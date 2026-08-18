"""Autopilot planner slot computation (pure logic, no DB)."""

from datetime import datetime
from typing import ClassVar

from godeye_engine.tasks.planner import compute_slots


def dt(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi)


class TestDailyCadence:
    def test_daily_1_uses_one_preferred_time_per_day(self):
        slots = compute_slots(
            "DAILY_1",
            None,
            ["09:00"],
            "UTC",
            dt(2026, 7, 15, 0, 0),
            dt(2026, 7, 17, 0, 0),
            fallback_hours=[9, 13, 18],
        )
        # 15th 09:00 and 16th 09:00 fall in (start, end]
        assert slots == [dt(2026, 7, 15, 9), dt(2026, 7, 16, 9)]

    def test_daily_3_uses_three_times(self):
        slots = compute_slots(
            "DAILY_3",
            None,
            ["08:00", "13:00", "19:00"],
            "UTC",
            dt(2026, 7, 15, 0, 0),
            dt(2026, 7, 15, 23, 59),
            fallback_hours=[9, 13, 18],
        )
        assert [s.hour for s in slots] == [8, 13, 19]

    def test_falls_back_to_engine_hours_when_no_preferred(self):
        slots = compute_slots(
            "DAILY_2",
            None,
            [],
            "UTC",
            dt(2026, 7, 15, 0, 0),
            dt(2026, 7, 15, 23, 59),
            fallback_hours=[10, 15, 20],
        )
        # DAILY_2 -> first two fallback hours
        assert [s.hour for s in slots] == [10, 15]


class TestWeekends:
    def test_only_saturday_and_sunday(self):
        # 2026-07-18 is Saturday, 07-19 Sunday, 07-20 Monday
        slots = compute_slots(
            "WEEKENDS",
            None,
            ["12:00"],
            "UTC",
            dt(2026, 7, 17, 0, 0),
            dt(2026, 7, 21, 0, 0),
            fallback_hours=[12],
        )
        weekdays = {s.weekday() for s in slots}
        assert weekdays <= {5, 6}
        assert len(slots) == 2


class TestHourly:
    def test_hourly_produces_one_per_hour(self):
        slots = compute_slots(
            "HOURLY",
            None,
            [],
            "UTC",
            dt(2026, 7, 15, 10, 0),
            dt(2026, 7, 15, 14, 0),
            fallback_hours=[9],
        )
        assert [s.hour for s in slots] == [11, 12, 13, 14]


class TestCustomCron:
    def test_custom_cron_expands(self):
        # every day at 06:00
        slots = compute_slots(
            "CUSTOM",
            "0 6 * * *",
            [],
            "UTC",
            dt(2026, 7, 15, 0, 0),
            dt(2026, 7, 17, 12, 0),
            fallback_hours=[9],
        )
        # 15th, 16th, 17th at 06:00 (all <= 17th 12:00)
        assert [s.hour for s in slots] == [6, 6, 6]
        assert [s.day for s in slots] == [15, 16, 17]
        assert all(s.minute == 0 for s in slots)

    def test_custom_cron_missing_returns_empty(self):
        assert (
            compute_slots(
                "CUSTOM", None, [], "UTC", dt(2026, 7, 15, 0, 0), dt(2026, 7, 16, 0, 0), [9]
            )
            == []
        )


class TestTimezone:
    def test_slots_returned_in_utc(self):
        # 09:00 in a +03:00 zone -> 06:00 UTC
        slots = compute_slots(
            "DAILY_1",
            None,
            ["09:00"],
            "Africa/Nairobi",  # UTC+3, no DST
            dt(2026, 7, 15, 0, 0),
            dt(2026, 7, 16, 0, 0),
            fallback_hours=[9],
        )
        assert len(slots) == 1
        assert slots[0].hour == 6  # UTC


class TestFirstRunGrace:
    """Beat wakes the planner every 5 minutes. A plan saved at 10:33 with a
    10:35 slot was first looked at after that slot had gone, so the first post
    someone expected never happened."""

    TZ = "Asia/Dubai"

    def test_a_slot_just_missed_is_still_booked_on_the_first_run(self):
        from datetime import datetime, timedelta

        from godeye_engine.tasks.planner import FIRST_RUN_GRACE_MINUTES, compute_slots

        # 10:38 Dubai, with the plan asking for 10:35.
        now = datetime(2026, 8, 2, 6, 38)  # UTC
        start = now - timedelta(minutes=FIRST_RUN_GRACE_MINUTES)
        slots = compute_slots(
            "DAILY_3", None, ["10:35", "13:00", "18:00"], self.TZ,
            start, now + timedelta(hours=24), [9, 13, 19],
        )
        assert any(s.hour == 6 and s.minute == 35 for s in slots), (
            f"the just-missed 10:35 slot was dropped: {slots}"
        )

    def test_without_the_grace_it_is_dropped(self):
        """Shows the grace is what makes the difference, not something else."""
        from datetime import datetime, timedelta

        from godeye_engine.tasks.planner import compute_slots

        now = datetime(2026, 8, 2, 6, 38)
        slots = compute_slots(
            "DAILY_3", None, ["10:35", "13:00", "18:00"], self.TZ,
            now, now + timedelta(hours=24), [9, 13, 19],
        )
        assert not any(
            s.hour == 6 and s.minute == 35 and s.day == 2 for s in slots
        )

    def test_the_grace_does_not_reach_an_unrelated_earlier_slot(self):
        """Twelve minutes, not twelve hours: a morning slot must not be revived
        by a plan created in the evening."""
        from datetime import datetime, timedelta

        from godeye_engine.tasks.planner import FIRST_RUN_GRACE_MINUTES, compute_slots

        now = datetime(2026, 8, 2, 14, 0)  # 18:00 Dubai
        start = now - timedelta(minutes=FIRST_RUN_GRACE_MINUTES)
        slots = compute_slots(
            "DAILY_3", None, ["10:35", "13:00", "18:00"], self.TZ,
            start, now + timedelta(hours=24), [9, 13, 19],
        )
        assert not any(s.day == 2 and s.hour == 6 and s.minute == 35 for s in slots)


class TestTheImageBriefCarriesThePlatform:
    """The planner is the only place that knows where an autopilot image is
    going. It worked the platform out to pick the preset and then dropped it,
    so every generated image was briefed with no idea of its destination and
    the per-platform visual culture never applied to a single post.
    """

    PLAN: ClassVar[dict] = {
        "orgId": "org1",
        "platforms": ["TIKTOK", "INSTAGRAM"],
    }

    def _dispatch(self, monkeypatch) -> dict:
        from godeye_engine.tasks import image as image_task
        from godeye_engine.tasks import planner

        sent: dict = {}

        class FakeSession:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute(self, *a, **kw):
                return None

            def commit(self):
                pass

        monkeypatch.setattr(planner, "get_session", lambda: FakeSession())
        monkeypatch.setattr(
            image_task.generate_image, "delay",
            lambda **kw: sent.update(kw),
        )
        planner._queue_image_for_content(
            self.PLAN, "content1", "Payday", "earning", [], body="A creator cashes out."
        )
        return sent

    def test_the_platform_is_dispatched(self, monkeypatch):
        assert self._dispatch(monkeypatch)["platform"] == "TIKTOK"

    def test_the_preset_still_matches_that_platform(self, monkeypatch):
        """The platform and the preset must not drift apart: they are two uses
        of the same decision."""
        from godeye_engine.media import presets

        sent = self._dispatch(monkeypatch)
        assert sent["preset_id"] == presets.PLATFORM_DEFAULT_PRESET.get("TIKTOK", "SQUARE")

    def test_the_post_body_still_reaches_the_brief(self, monkeypatch):
        """Guards the earlier fix in the same call: the image agent illustrates
        the post, not the business in general."""
        assert "A creator cashes out." in self._dispatch(monkeypatch)["brief"]
