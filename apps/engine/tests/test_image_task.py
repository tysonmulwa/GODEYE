"""The image task must always report its own outcome.

A run is set to RUNNING by the task and can only be cleared by the task. Any
path that leaves the function without writing a terminal status strands the row
at RUNNING forever, with no error to explain it, while the worker moves on
looking healthy. That is exactly what happened when the upload step sat outside
the try: image generation had never once succeeded in production, and nothing
anywhere said so.
"""

import pytest

from godeye_engine.ai.image_provider import ImageResult
from godeye_engine.tasks import image as image_task


class FakeResult:
    """Whatever session.execute() returns.

    The task reads profile and brand rows through .mappings().first(), and the
    org's recent image prompts through .scalars().
    """

    def mappings(self):
        return self

    def first(self):
        return None

    def scalars(self):
        return iter([])


class FakeSession:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, *a, **kw):
        return FakeResult()

    def commit(self):
        pass


@pytest.fixture
def harness(monkeypatch):
    """Stub everything up to the upload so each test drives one failure."""
    failures: list[tuple[str, str]] = []

    monkeypatch.setattr(image_task, "get_session", lambda: FakeSession())
    monkeypatch.setattr(image_task, "publish_event", lambda *a, **kw: None)
    monkeypatch.setattr(
        image_task, "_fail_run",
        lambda run_id, org_id, error: failures.append((run_id, error)),
    )
    monkeypatch.setattr(
        image_task.image_agent, "build_image_prompt", lambda *a, **kw: "a prompt"
    )
    monkeypatch.setattr(
        image_task.image_provider, "generate_image",
        lambda *a, **kw: ImageResult(
            data=b"fake-png", provider="openai", model="gpt-image-2",
            provider_size="1024x1024",
        ),
    )
    monkeypatch.setattr(image_task.branding, "fit_to_preset", lambda data, preset: data)
    # Real Pillow would reject the placeholder bytes; encoding is covered in
    # test_media.py, and what matters here is which paths report their outcome.
    monkeypatch.setattr(image_task.branding, "to_jpeg", lambda data, *a, **kw: data)
    return failures


def run_task():
    """Invoke the task body directly, bypassing Celery's dispatch."""
    return image_task.generate_image(
        agent_run_id="run1", org_id="org1", brief="a coffee shop", preset_id="SQUARE"
    )


def test_upload_failure_marks_the_run_failed(harness, monkeypatch):
    """The regression. Before the fix this raised straight out of the task and
    the row stayed RUNNING with nothing to show for it."""
    def boom(*a, **kw):
        raise RuntimeError("An error occurred (AccessDenied) when calling PutObject")

    monkeypatch.setattr(image_task, "upload_bytes", boom)

    result = run_task()

    assert result["status"] == "FAILED"
    assert len(harness) == 1, "the run was never marked failed"
    _, error = harness[0]
    assert "AccessDenied" in error, "the underlying cause must survive"


def test_the_storage_error_points_at_the_worker(harness, monkeypatch):
    """The image exists and has been paid for by this point, so the fault is
    local. Saying which service holds the wrong settings is the whole value."""
    monkeypatch.setattr(
        image_task, "upload_bytes",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("connection refused")),
    )

    run_task()

    _, error = harness[0]
    assert "worker" in error.lower()
    assert "S3_ACCESS_KEY" in error


def test_a_provider_failure_still_reports(harness, monkeypatch):
    """The pre-existing handler must keep working after the restructure."""
    monkeypatch.setattr(
        image_task.image_provider, "generate_image",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("model_not_found")),
    )

    result = run_task()

    assert result["status"] == "FAILED"
    assert "model_not_found" in harness[0][1]


def test_the_happy_path_reports_success(harness, monkeypatch):
    monkeypatch.setattr(
        image_task, "upload_bytes", lambda key, data, ct: f"https://cdn.example/{key}"
    )

    result = run_task()

    assert result["status"] == "SUCCEEDED"
    assert result["url"].startswith("https://cdn.example/")
    assert not harness, "a successful run must not be marked failed"
