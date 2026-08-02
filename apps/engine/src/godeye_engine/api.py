"""Internal FastAPI app — only the NestJS API talks to this (shared secret)."""

from __future__ import annotations

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import text

from .celery_app import worker_builds
from .config import get_settings
from .db import get_engine

app = FastAPI(title="GODEYE Engine", version="0.1.0", docs_url=None, redoc_url=None)


def verify_internal_secret(x_internal_secret: str = Header(default="")) -> None:
    if x_internal_secret != get_settings().engine_internal_secret:
        raise HTTPException(status_code=401, detail="Invalid internal secret")


class GenerateContentRequest(BaseModel):
    agentRunId: str
    orgId: str
    goal: str = Field(min_length=3, max_length=1000)
    platforms: list[str] = Field(min_length=1, max_length=10)
    tone: str | None = None
    topic: str | None = None
    callToAction: str | None = None
    abTest: bool = False


class ValidateXRequest(BaseModel):
    apiKey: str
    apiSecret: str
    accessToken: str
    accessSecret: str


class GenerateImageRequest(BaseModel):
    agentRunId: str
    orgId: str
    brief: str = Field(min_length=3, max_length=2000)
    preset: str = "SQUARE"
    style: str | None = None
    contentItemId: str | None = None
    applyBrand: bool = False


class StoreLogoRequest(BaseModel):
    orgId: str
    filename: str
    dataBase64: str
    contentType: str = "image/png"


class StoreUploadRequest(BaseModel):
    orgId: str
    dataBase64: str
    contentType: str = "image/png"


class GenerateVideoRequest(BaseModel):
    agentRunId: str
    orgId: str
    brief: str = Field(min_length=3, max_length=2000)
    preset: str = "VERTICAL"
    durationSec: int = Field(default=30, ge=10, le=90)
    voice: str = "nova"
    style: str | None = None
    includeCaptions: bool = True
    contentItemId: str | None = None


@app.get("/health")
def health(render: str = "") -> dict:
    # The build marker matters as much as the checks. Working out whether a
    # change had reached the worker meant reading the shape of the rows it
    # produced, which is slow and easy to get wrong.
    sha = get_settings().railway_git_commit_sha
    checks = {"engine": "ok"}
    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as e:  # noqa: BLE001
        checks["database"] = f"error: {e}"
    try:
        import redis as redis_lib

        # Bounded on purpose: a refused Redis fails fast, but a hung one would
        # hold this request open with no default timeout to stop it, and a
        # health check that hangs is one more thing to debug during an outage.
        redis_lib.Redis.from_url(
            get_settings().redis_url, socket_connect_timeout=2, socket_timeout=2
        ).ping()
        checks["redis"] = "ok"
    except Exception as e:  # noqa: BLE001
        checks["redis"] = f"error: {e}"

    # This process does not publish anything — the worker does, from the same
    # image but its own deploy. Report the workers too, or a green /health can
    # sit on top of a queue nobody is consuming.
    build = sha[:8] if sha else "unknown"
    workers = worker_builds()
    errors = [w["error"] for w in workers if w.get("error")]
    # "unknown" is the absence of an answer, so it must never satisfy a
    # comparison — two unknowns once matched each other and reported ok while
    # the broker was refusing connections.
    mismatched = [w for w in workers if w["build"] != build or build == "unknown"]
    if errors:
        checks["workers"] = f"error: {'; '.join(errors)}"
    elif not workers:
        checks["workers"] = "error: no worker responded — nothing is consuming the queue"
    elif mismatched:
        detail = ", ".join(f"{w['node']}={w['build']}" for w in mismatched)
        checks["workers"] = f"error: cannot confirm workers match this build ({build}): {detail}"
    else:
        checks["workers"] = f"ok ({len(workers)} on {build})"

    # Reported separately from the build: a current worker that cannot render
    # still publishes, it just drops the sound and says nothing.
    cannot_render = [w for w in workers if not w.get("ffmpeg", "").startswith("ffmpeg")]
    if workers and not errors:
        checks["ffmpeg"] = (
            "ok"
            if not cannot_render
            else "error: " + ", ".join(f"{w['node']}: {w.get('ffmpeg')}" for w in cannot_render)
        )

    result = {"status": "", "checks": checks, "build": build, "workers": workers}

    # Opt-in: this encodes video, so it is far too expensive to run on every
    # health poll. Worth having because a working ffmpeg binary and a container
    # that can finish an encode are different things, and only the second one
    # decides whether a post arrives with sound.
    #
    # Asked for and read separately, because the encode outlives the request:
    # the edge closes a connection at 100 seconds, and answering inline lost a
    # result the worker had already produced.
    if render:
        from .tasks.diagnostics import read_render_result, start_render_selftest

        # A pass cached from before a change is worse than no answer at all.
        stored = None if render == "refresh" else read_render_result()
        if stored is None:
            queued = start_render_selftest()
            result["render"] = {
                "status": "running" if queued else "could not queue — is a worker up?",
                "hint": "ask again in a minute for the result",
            }
            checks["render"] = "ok (pending)" if queued else "error: could not queue"
        else:
            result["render"] = stored
            checks["render"] = (
                "ok"
                if stored.get("ok")
                else f"error: {stored.get('error') or 'render produced no audio'}"
            )

    result["status"] = "ok" if all(v.startswith("ok") for v in checks.values()) else "degraded"
    return result


@app.post("/tasks/generate-content", dependencies=[Depends(verify_internal_secret)])
def enqueue_generate_content(request: GenerateContentRequest) -> dict:
    from .tasks.content import generate_content

    task = generate_content.delay(
        agent_run_id=request.agentRunId,
        org_id=request.orgId,
        goal=request.goal,
        platforms=request.platforms,
        tone=request.tone,
        topic=request.topic,
        call_to_action=request.callToAction,
        ab_test=request.abTest,
    )
    return {"taskId": task.id}


@app.post("/tasks/generate-image", dependencies=[Depends(verify_internal_secret)])
def enqueue_generate_image(request: GenerateImageRequest) -> dict:
    from .tasks.image import generate_image

    task = generate_image.delay(
        agent_run_id=request.agentRunId,
        org_id=request.orgId,
        brief=request.brief,
        preset_id=request.preset,
        style=request.style,
        content_item_id=request.contentItemId,
        apply_brand=request.applyBrand,
    )
    return {"taskId": task.id}


class RunSeoAuditRequest(BaseModel):
    agentRunId: str
    orgId: str
    auditId: str
    url: str
    maxPages: int = Field(default=20, ge=1, le=50)


@app.post("/tasks/run-seo-audit", dependencies=[Depends(verify_internal_secret)])
def enqueue_seo_audit(request: RunSeoAuditRequest) -> dict:
    from .tasks.seo import run_site_audit

    task = run_site_audit.delay(
        agent_run_id=request.agentRunId,
        org_id=request.orgId,
        audit_id=request.auditId,
        url=request.url,
        max_pages=request.maxPages,
    )
    return {"taskId": task.id}


class VerifyFixesRequest(BaseModel):
    orgId: str
    auditId: str


@app.post("/tasks/verify-seo-fixes", dependencies=[Depends(verify_internal_secret)])
def enqueue_verify_fixes(request: VerifyFixesRequest) -> dict:
    from .tasks.seo import verify_fixes

    task = verify_fixes.delay(org_id=request.orgId, audit_id=request.auditId)
    return {"taskId": task.id}


class IndexNowRequest(BaseModel):
    orgId: str
    siteUrl: str
    urls: list[str] = Field(default_factory=list, max_length=1000)


@app.post("/seo/indexnow", dependencies=[Depends(verify_internal_secret)])
def submit_indexnow(request: IndexNowRequest) -> dict:
    """Submit changed URLs to IndexNow. Synchronous — it is two HTTP calls, and
    the user deserves to hear 'accepted' or 'publish the key file first' now
    rather than in a notification later."""
    from .seo import indexnow

    return indexnow.submit(request.orgId, request.siteUrl, request.urls)


@app.get("/seo/indexnow/status", dependencies=[Depends(verify_internal_secret)])
def indexnow_status(orgId: str, siteUrl: str) -> dict:
    """Whether the site is ready to receive IndexNow submissions."""
    from .seo import indexnow

    key = indexnow.derive_key(orgId, siteUrl)
    return {
        "key": key,
        "keyFileUrl": indexnow.key_file_url(siteUrl, key),
        "published": indexnow.key_is_published(siteUrl, key),
    }


@app.post("/tasks/generate-video", dependencies=[Depends(verify_internal_secret)])
def enqueue_generate_video(request: GenerateVideoRequest) -> dict:
    from .tasks.video import generate_video

    task = generate_video.delay(
        agent_run_id=request.agentRunId,
        org_id=request.orgId,
        brief=request.brief,
        preset_id=request.preset,
        duration_sec=request.durationSec,
        voice=request.voice,
        style=request.style,
        include_captions=request.includeCaptions,
        content_item_id=request.contentItemId,
    )
    return {"taskId": task.id}


@app.post("/storage/logo", dependencies=[Depends(verify_internal_secret)])
def store_logo(request: StoreLogoRequest) -> dict:
    """Store an uploaded brand logo and return its key + public URL."""
    import base64

    from .db import new_id
    from .storage import upload_bytes

    data = base64.b64decode(request.dataBase64)
    if len(data) > 5_000_000:
        raise HTTPException(status_code=400, detail="Logo exceeds 5 MB")
    ext = "png" if "png" in request.contentType else "jpg"
    key = f"{request.orgId}/brand/logo-{new_id()}.{ext}"
    url = upload_bytes(key, data, request.contentType)
    return {"storageKey": key, "url": url}


class StoreBrandMusicRequest(BaseModel):
    orgId: str
    filename: str
    dataBase64: str
    contentType: str = "audio/mpeg"


@app.post("/storage/brand-music", dependencies=[Depends(verify_internal_secret)])
def store_brand_music(request: StoreBrandMusicRequest) -> dict:
    """Store a workspace's background track for mixing under generated video."""
    import base64

    from .db import new_id
    from .storage import upload_bytes

    data = base64.b64decode(request.dataBase64)
    # A background bed for a 30 to 90 second video; anything larger is a whole
    # album and will not be used.
    if len(data) > 15_000_000:
        raise HTTPException(status_code=400, detail="Track exceeds 15 MB")
    ext = {
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/mp4": "m4a",
        "audio/aac": "m4a",
        "audio/ogg": "ogg",
    }.get(request.contentType, "mp3")
    key = f"{request.orgId}/brand/music-{new_id()}.{ext}"
    url = upload_bytes(key, data, request.contentType)
    return {"storageKey": key, "url": url}


@app.post("/storage/upload", dependencies=[Depends(verify_internal_secret)])
def store_upload(request: StoreUploadRequest) -> dict:
    """Store an uploaded image/video and return its key + public URL."""
    import base64

    from .db import new_id
    from .storage import upload_bytes

    data = base64.b64decode(request.dataBase64)
    if len(data) > 25_000_000:
        raise HTTPException(status_code=400, detail="File exceeds 25 MB")
    ext = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
    }.get(request.contentType, "bin")
    key = f"{request.orgId}/uploads/{new_id()}.{ext}"
    url = upload_bytes(key, data, request.contentType)
    return {"storageKey": key, "url": url, "sizeBytes": len(data)}


@app.get("/media/{key:path}")
def serve_media(key: str) -> FileResponse:
    """Serve a locally-stored object (STORAGE_BACKEND=local). Public by design —
    images must be viewable without the internal secret."""
    from .storage import _is_local, local_path

    if not _is_local():
        raise HTTPException(status_code=404, detail="Not found")
    path = local_path(key)
    # Contain traversal: the resolved path must stay under the media dir.
    from .storage import local_media_dir

    try:
        path.resolve().relative_to(local_media_dir().resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid key") from None
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path)


@app.post("/validate/x", dependencies=[Depends(verify_internal_secret)])
def validate_x(request: ValidateXRequest) -> dict:
    """Validate X credentials (OAuth1 lives only in the engine)."""
    from .publishers.x import verify_credentials

    try:
        return verify_credentials(request.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/intel/best-times", dependencies=[Depends(verify_internal_secret)])
def get_best_times(orgId: str, platform: str, timezone: str = "UTC") -> dict:
    from . import intel

    times = intel.best_times(orgId, platform, timezone)
    data_driven = False
    try:
        points = intel.engagement_by_hour(orgId, platform, timezone)
        data_driven = sum(len(v) for v in points.values()) >= intel.MIN_DATA_POINTS
    except Exception:  # noqa: BLE001 — fall back silently if the DB is unreachable
        pass
    return {"platform": platform, "timezone": timezone, "times": times, "dataDriven": data_driven}
