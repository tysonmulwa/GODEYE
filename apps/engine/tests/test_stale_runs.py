"""Reaping AgentRuns whose worker died mid-task (pure logic, no DB).

A killed process runs no handler and trips no time limit, so its row stays
RUNNING and the UI spins on it forever. These thresholds decide when a row is
declared dead, and being impatient here fails work that was merely slow.
"""

from datetime import datetime, timedelta

from godeye_engine.tasks.scheduler import (
    DEFAULT_STALE_RUN_MINUTES,
    STALE_RUN_MINUTES,
    is_stale_run,
)

NOW = datetime(2026, 7, 31, 16, 0, 0)


def ago(minutes: int) -> datetime:
    return NOW - timedelta(minutes=minutes)


def test_a_fresh_run_is_left_alone():
    assert not is_stale_run("IMAGE", ago(1), NOW)


def test_an_image_run_stuck_past_its_window_is_reaped():
    """The real incident: rows sat RUNNING for 45 minutes with the task long
    dead, because nothing inside a killed process can mark them failed."""
    assert is_stale_run("IMAGE", ago(45), NOW)


def test_thresholds_sit_above_each_task_hard_limit():
    """A run must only be reaped once it cannot still be working. The image
    task's hard limit is 6 minutes, so anything at or under that would race a
    task that is about to time out cleanly on its own."""
    assert STALE_RUN_MINUTES["IMAGE"] > 6
    assert STALE_RUN_MINUTES["VIDEO"] >= 25  # global hard limit
    assert not is_stale_run("IMAGE", ago(7), NOW)


def test_video_gets_longer_than_image():
    """Video assembles several images plus audio, so the image threshold would
    kill legitimate work."""
    assert is_stale_run("IMAGE", ago(20), NOW)
    assert not is_stale_run("VIDEO", ago(20), NOW)


def test_an_unknown_agent_falls_back_to_the_safe_default():
    assert not is_stale_run("SOMETHING_NEW", ago(DEFAULT_STALE_RUN_MINUTES - 1), NOW)
    assert is_stale_run("SOMETHING_NEW", ago(DEFAULT_STALE_RUN_MINUTES + 1), NOW)


def test_a_missing_timestamp_is_never_reaped():
    """Without createdAt there is no evidence of staleness, and guessing would
    fail a run that started a second ago."""
    assert not is_stale_run("IMAGE", None, NOW)
