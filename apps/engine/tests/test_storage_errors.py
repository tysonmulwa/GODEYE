"""Diagnosing a failed upload.

botocore renders an unrecognised response as "An error occurred () ... : " with
the code and message empty, which tells nobody anything. The HTTP status does
tell you something, and the two cases point in opposite directions, so getting
this mapping backwards sends someone to change the setting that was already
right. Statuses below were observed against a real Supabase project.
"""

from botocore.exceptions import ClientError

from godeye_engine.storage import describe_upload_failure


def client_error(status: int, code: str = "", message: str = "") -> ClientError:
    return ClientError(
        {
            "Error": {"Code": code, "Message": message},
            "ResponseMetadata": {"HTTPStatusCode": status},
        },
        "PutObject",
    )


def test_403_with_an_empty_code_is_a_credentials_problem():
    """The reported failure. Supabase answers 403 with a body botocore cannot
    read as S3 error XML, so the code comes through empty even though the
    endpoint was correct all along."""
    detail = describe_upload_failure(client_error(403))
    assert "credentials were refused" in detail
    assert "S3_ACCESS_KEY" in detail
    assert "endpoint is correct" in detail


def test_404_is_an_endpoint_problem_not_a_credentials_one():
    detail = describe_upload_failure(client_error(404, code="404", message="Not Found"))
    assert "/storage/v1/s3" in detail
    assert "credentials were refused" not in detail


def test_a_missing_bucket_says_so():
    detail = describe_upload_failure(client_error(404, code="NoSuchBucket"))
    assert "S3_BUCKET" in detail


def test_the_status_and_code_are_always_reported():
    """Even for a case with no specific advice, the raw facts have to survive:
    the original error printed neither."""
    detail = describe_upload_failure(client_error(500, code="InternalError"))
    assert "500" in detail
    assert "InternalError" in detail


def test_a_non_boto_error_still_produces_something_useful():
    detail = describe_upload_failure(RuntimeError("connection reset"))
    assert "connection reset" in detail
    assert "bucket" in detail.lower()


def test_credentials_are_never_included(monkeypatch):
    """This string is written to AgentRun.error and shown in the browser."""
    from godeye_engine.config import get_settings

    monkeypatch.setenv("S3_ACCESS_KEY", "AKIAVERYSECRETKEY")
    monkeypatch.setenv("S3_SECRET_KEY", "s3cr3t-do-not-leak")
    get_settings.cache_clear()
    try:
        detail = describe_upload_failure(client_error(403))
        assert "AKIAVERYSECRETKEY" not in detail
        assert "s3cr3t-do-not-leak" not in detail
    finally:
        get_settings.cache_clear()
