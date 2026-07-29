"""IndexNow — tell search engines a URL changed, instead of waiting to be crawled.

A single POST notifies Bing, Yandex, Seznam and Naver at once (they share the
protocol and forward submissions between themselves). Turnaround is hours rather
than the weeks an organic re-crawl can take, and it costs nothing.

Google is not a participant. It runs no general instant-indexing API — the
Indexing API is restricted to JobPosting and BroadcastEvent — so for Google the
sitemap remains the only legitimate route. Any tool claiming to push pages into
Google on demand is misrepresenting what it does.

Ownership is proved by hosting a key file at the site root, so submission is a
two-step affair: the key ships as a fix in the Fix Pack, the user publishes it,
and only then will submissions be accepted.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from urllib.parse import urlparse

import httpx

from ..config import get_settings
from .crawler import fetch_text

logger = logging.getLogger(__name__)

ENDPOINT = "https://api.indexnow.org/IndexNow"
TIMEOUT = 15.0
MAX_URLS_PER_REQUEST = 10_000  # protocol limit


def host_of(url: str) -> str:
    return urlparse(url).netloc.lower()


def derive_key(org_id: str, url: str) -> str:
    """A stable, unguessable IndexNow key for one workspace's site.

    Derived rather than stored: the key has no value beyond proving control of
    the host, and deriving it means there is no extra table and no way for the
    key on file to drift from the key we submit with.

    It is keyed on TOKEN_ENCRYPTION_KEY, which is already the one secret in this
    system that can never be rotated without invalidating stored credentials. If
    it ever were rotated, the only consequence here is that the next audit
    proposes a new key file to publish.
    """
    secret = get_settings().token_encryption_key.encode()
    message = f"indexnow:{org_id}:{host_of(url)}".encode()
    return hmac.new(secret, message, hashlib.sha256).hexdigest()[:32]


def key_file_url(url: str, key: str) -> str:
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}/{key}.txt"


def key_is_published(url: str, key: str) -> bool:
    """True when the site actually serves the key file with the right contents.

    Checked before every submission rather than recorded once: the customer owns
    that server, and a file that was there last month may not be there today.
    """
    status, body = fetch_text(key_file_url(url, key))
    return status == 200 and body.strip() == key


def submit(org_id: str, site_url: str, urls: list[str]) -> dict:
    """Submit changed URLs. Returns a result dict; never raises for a rejection.

    The caller is usually a Celery task finishing something more important (a
    fix was applied, a page was published), so a search engine being unavailable
    must not fail that work.
    """
    if not urls:
        return {"submitted": 0, "status": "skipped", "reason": "no URLs to submit"}

    key = derive_key(org_id, site_url)
    if not key_is_published(site_url, key):
        return {
            "submitted": 0,
            "status": "unverified",
            "reason": (
                f"Publish {key}.txt at the site root first — search engines use it "
                "to confirm you control this domain."
            ),
            "key": key,
        }

    parsed = urlparse(site_url)
    host = parsed.netloc
    # Submissions are rejected wholesale if any URL is on another host.
    same_host = [u for u in urls if host_of(u) == host.lower()][:MAX_URLS_PER_REQUEST]
    if not same_host:
        return {"submitted": 0, "status": "skipped", "reason": "no URLs on this host"}

    payload = {
        "host": host,
        "key": key,
        "keyLocation": key_file_url(site_url, key),
        "urlList": same_host,
    }
    try:
        response = httpx.post(ENDPOINT, json=payload, timeout=TIMEOUT)
    except httpx.HTTPError as e:
        logger.info("IndexNow submission failed for %s: %s", host, e)
        return {"submitted": 0, "status": "error", "reason": str(e)}

    # 200 accepted, 202 accepted but key still being validated. Both are fine.
    if response.status_code in (200, 202):
        return {"submitted": len(same_host), "status": "accepted"}
    return {
        "submitted": 0,
        "status": "rejected",
        "reason": f"HTTP {response.status_code}: {response.text[:200]}",
    }
