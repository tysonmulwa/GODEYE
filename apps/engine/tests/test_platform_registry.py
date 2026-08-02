"""The shared platform registry must match what the engine can actually publish.

Autopilot's platform picker is driven by AVAILABLE_PLATFORMS in
packages/shared, not by the user's connections. TikTok shipped a publisher but
was left flagged unavailable there, so a workspace with TikTok connected was
offered only its other channels and had no way to include it in a plan.

Nothing links the two lists, and they are in different languages, so this reads
the TypeScript and compares. A mismatch in either direction is a bug: a platform
offered without a publisher fails at publish time, and one with a publisher but
no flag is invisible.
"""

import pathlib
import re

from godeye_engine.publishers import _PUBLISHERS

PLATFORMS_TS = (
    pathlib.Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "platforms.ts"
)

# e.g.  FACEBOOK: { id: "FACEBOOK", ..., available: true, ... },
ENTRY = re.compile(r"^\s*(?P<id>[A-Z_]+):\s*\{(?P<body>[^}]*)\}", re.MULTILINE)


def available_in_shared() -> set[str]:
    source = PLATFORMS_TS.read_text(encoding="utf-8")
    found = set()
    for match in ENTRY.finditer(source):
        if re.search(r"available:\s*true", match.group("body")):
            found.add(match.group("id"))
    return found


def test_the_registry_file_is_where_we_think():
    assert PLATFORMS_TS.is_file(), f"missing {PLATFORMS_TS}"
    assert available_in_shared(), "parsed no available platforms; the format changed"


def test_every_available_platform_has_a_publisher():
    """Offering one without a publisher gets the user a failed post."""
    missing = sorted(available_in_shared() - set(_PUBLISHERS))
    assert not missing, f"marked available with no publisher: {missing}"


def test_every_publisher_is_offered_to_users():
    """The TikTok bug. A publisher nobody can select does nothing for anyone."""
    hidden = sorted(set(_PUBLISHERS) - available_in_shared())
    assert not hidden, f"publisher exists but the UI hides it: {hidden}"


def test_tiktok_specifically_is_selectable():
    """Named because it was connected, publishing, and still not offered."""
    assert "TIKTOK" in available_in_shared()
    assert "TIKTOK" in _PUBLISHERS
