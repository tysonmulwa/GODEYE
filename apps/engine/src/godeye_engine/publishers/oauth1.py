"""Minimal OAuth 1.0a (HMAC-SHA1) request signing — used by the X (Twitter) adapter.

Implements RFC 5849 signing for requests whose body is NOT form-encoded
(JSON bodies are excluded from the signature base string, per spec).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from urllib.parse import quote, urlsplit


def _pct(value: str) -> str:
    return quote(str(value), safe="-._~")


def signature_base_string(method: str, url: str, params: dict[str, str]) -> str:
    split = urlsplit(url)
    base_url = f"{split.scheme}://{split.netloc}{split.path}"
    query_pairs: list[tuple[str, str]] = []
    if split.query:
        for pair in split.query.split("&"):
            key, _, value = pair.partition("=")
            query_pairs.append((key, value))
    all_params = [(_pct(k), _pct(v)) for k, v in list(params.items()) + query_pairs]
    param_string = "&".join(f"{k}={v}" for k, v in sorted(all_params))
    return f"{method.upper()}&{_pct(base_url)}&{_pct(param_string)}"


def sign(
    method: str,
    url: str,
    consumer_key: str,
    consumer_secret: str,
    token: str,
    token_secret: str,
    extra_params: dict[str, str] | None = None,
    nonce: str | None = None,
    timestamp: str | None = None,
) -> str:
    """Return the value for the Authorization header."""
    oauth_params = {
        "oauth_consumer_key": consumer_key,
        "oauth_nonce": nonce or secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": timestamp or str(int(time.time())),
        "oauth_token": token,
        "oauth_version": "1.0",
    }
    base = signature_base_string(method, url, {**oauth_params, **(extra_params or {})})
    signing_key = f"{_pct(consumer_secret)}&{_pct(token_secret)}"
    digest = hmac.new(signing_key.encode(), base.encode(), hashlib.sha1).digest()
    oauth_params["oauth_signature"] = base64.b64encode(digest).decode()

    header_params = ", ".join(
        f'{_pct(k)}="{_pct(v)}"' for k, v in sorted(oauth_params.items())
    )
    return f"OAuth {header_params}"
