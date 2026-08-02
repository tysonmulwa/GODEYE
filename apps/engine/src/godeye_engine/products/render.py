"""Fetch a page after its JavaScript has run.

Some storefronts build their catalogue in the browser, so a plain fetch returns
an empty shell. Reading those needs a real browser.

That browser is deliberately not in this image. The worker here was killed by
the kernel for memory while encoding a five second video, and Chromium is far
heavier than ffmpeg — putting it in the same container would trade a feature
nobody has yet for publishing, which everybody uses. So rendering is a request
to something else.

The contract is Browserless's /content endpoint: POST {"url": ...} and get the
rendered HTML back. It is worth targeting specifically because it is one
container anyone can run — `docker run ghcr.io/browserless/chromium`, or a
second Railway service beside this one — so nobody is required to buy a hosted
scraping product to use the feature, and the hosted ones speak it too.

Playwright is supported as well for anyone who does want it in-process, and is
imported lazily so the dependency stays optional.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from ..config import get_settings

logger = logging.getLogger(__name__)

# A cold browser, a real navigation and a network-idle wait. Slower than any
# plain fetch and still bounded, because this runs on the queue.
RENDER_TIMEOUT_SEC = 60.0

NOT_CONFIGURED = (
    "This storefront builds its catalogue in the browser, so reading it needs a "
    "browser. Point BROWSER_RENDER_URL at a Browserless-compatible service "
    "(one container: ghcr.io/browserless/chromium) and set BROWSER_RENDER_TOKEN "
    "if it needs one."
)


@dataclass
class Rendered:
    html: str | None
    detail: str | None = None

    @property
    def ok(self) -> bool:
        return bool(self.html)


def is_configured() -> bool:
    settings = get_settings()
    return bool(settings.browser_render_url) or settings.browser_render_provider == "playwright"


def render(url: str) -> Rendered:
    """The page as a browser sees it, or why it could not be fetched.

    Never raises. A storefront we cannot read is an answer for the user, not a
    traceback in a worker log.
    """
    settings = get_settings()
    if settings.browser_render_provider == "playwright":
        return _render_playwright(url)
    if settings.browser_render_url:
        return _render_remote(url, settings)
    return Rendered(html=None, detail=NOT_CONFIGURED)


def _render_remote(url: str, settings) -> Rendered:
    endpoint = settings.browser_render_url
    payload = {
        "url": url,
        # Wait for the requests to stop rather than for a fixed delay: a
        # catalogue arrives when its fetch resolves, not after two seconds.
        "gotoOptions": {"waitUntil": "networkidle2", "timeout": 45000},
    }
    params = {"token": settings.browser_render_token} if settings.browser_render_token else None

    try:
        response = httpx.post(
            endpoint, json=payload, params=params, timeout=RENDER_TIMEOUT_SEC
        )
    except httpx.HTTPError as e:
        logger.warning("Render request to %s failed: %s: %s", endpoint, type(e).__name__, e)
        return Rendered(html=None, detail=f"The rendering service did not answer ({type(e).__name__}).")

    if response.status_code == 401 or response.status_code == 403:
        return Rendered(
            html=None,
            detail="The rendering service refused the token. Check BROWSER_RENDER_TOKEN.",
        )
    if response.status_code >= 400:
        return Rendered(
            html=None,
            detail=f"The rendering service returned HTTP {response.status_code}.",
        )

    html = response.text
    if not html.strip():
        return Rendered(html=None, detail="The rendering service returned an empty page.")
    return Rendered(html=html)


def _render_playwright(url: str) -> Rendered:
    """In-process rendering, for anyone who accepts the memory cost."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return Rendered(
            html=None,
            detail=(
                "BROWSER_RENDER_PROVIDER is playwright but the package is not installed "
                "in this image. Install playwright and its Chromium, or use a "
                "Browserless-compatible service instead."
            ),
        )

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
            try:
                page = browser.new_page()
                page.goto(url, wait_until="networkidle", timeout=45000)
                return Rendered(html=page.content())
            finally:
                browser.close()
    except Exception as e:  # noqa: BLE001 — an unreadable site is a report
        logger.warning("Playwright render of %s failed: %s: %s", url, type(e).__name__, e)
        return Rendered(html=None, detail=f"The browser could not load the page ({type(e).__name__}).")
