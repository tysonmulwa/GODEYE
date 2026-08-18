"""Best-time detection, fallback heuristics and data-driven ranking."""

from godeye_engine import intel


class TestFallback:
    def test_uses_platform_defaults_with_thin_data(self, monkeypatch):
        monkeypatch.setattr(intel, "engagement_by_hour", lambda *a, **k: {})
        hours = intel.best_hours("org1", "LINKEDIN", "UTC")
        assert hours == intel.PLATFORM_DEFAULT_HOURS["LINKEDIN"][:3]

    def test_unknown_platform_uses_generic_hours(self, monkeypatch):
        monkeypatch.setattr(intel, "engagement_by_hour", lambda *a, **k: {})
        assert intel.best_hours("org1", "TUMBLR", "UTC") == intel.GENERIC_HOURS[:3]

    def test_best_times_formats_as_hh_mm(self, monkeypatch):
        monkeypatch.setattr(intel, "engagement_by_hour", lambda *a, **k: {})
        times = intel.best_times("org1", "X", "UTC")
        assert all(len(t) == 5 and t[2] == ":" for t in times)


class TestDataDriven:
    def test_ranks_hours_by_average_engagement(self, monkeypatch):
        # 20:00 clearly best, then 09:00, then 13:00, enough data points to trust
        data = {
            9: [10, 12, 11],
            13: [3, 4, 2],
            20: [50, 60, 55],
        }
        monkeypatch.setattr(intel, "engagement_by_hour", lambda *a, **k: data)
        hours = intel.best_hours("org1", "X", "UTC", count=2)
        # top 2 by average = 20 and 9, returned sorted ascending
        assert hours == [9, 20]

    def test_respects_min_data_points(self, monkeypatch):
        # only 3 points total < MIN_DATA_POINTS -> fall back
        monkeypatch.setattr(intel, "engagement_by_hour", lambda *a, **k: {9: [100], 20: [1, 2]})
        assert intel.best_hours("org1", "X", "UTC") == intel.PLATFORM_DEFAULT_HOURS["X"][:3]
