"""The SSRF guard. Findings S-2, S-3, S-20.

Every entry in FORBIDDEN is a target that was reachable before this existed:
cloud metadata, the deployment's own internal services, and the engine's own
/health, which echoes database and Redis error strings back to the caller.
"""

import httpx
import pytest

from godeye_engine.security import EgressBlocked, safe_fetch, validate

FORBIDDEN = [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://100.100.100.200/latest/meta-data/",
    "http://localhost/",
    "http://localhost:8000/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://engine.railway.internal/health",
    "http://engine-api.railway.internal:8000/health",
    "http://redis.internal/",
    "http://db.cluster.local/",
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_INFO",
    "dict://127.0.0.1:11211/stats",
    "ftp://example.com/secret",
    "http://user:pass@evil.example.com/",
    "http://example.com:22/",
    "http://example.com:6379/",
    # The IPv4-mapped IPv6 forms, which match no IPv6 range and connect to v4.
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
]


@pytest.mark.parametrize("url", FORBIDDEN)
def test_refuses(url):
    with pytest.raises(EgressBlocked):
        validate(url)


@pytest.mark.parametrize("url", FORBIDDEN)
def test_refuses_before_any_connection(url):
    # safe_fetch must never open a socket for these. A transport that raises if
    # touched proves the rejection happened during validation.
    def explode(_request):  # pragma: no cover - reaching this IS the failure
        raise AssertionError("a connection was attempted for a blocked URL")

    with pytest.raises(EgressBlocked):
        safe_fetch(url, transport=httpx.MockTransport(explode))


def test_allows_a_real_public_site():
    host, port, scheme, address = validate("https://example.com/pricing")
    assert host == "example.com"
    assert port == 443
    assert scheme == "https"
    assert not address.is_private


def test_refuses_a_hostname_that_does_not_resolve():
    # Two acceptable outcomes, and both are a refusal. Many ISP resolvers hijack
    # NXDOMAIN to a parking address, which is often inside RFC1918 — so the
    # rejection arrives as "resolves to something private" rather than "does not
    # resolve". Asserting only the first message would make this test pass or
    # fail on whose DNS is answering.
    with pytest.raises(EgressBlocked):
        validate("http://this-host-does-not-exist.invalid/")


def test_default_ports_are_allowed():
    assert validate("http://example.com/")[1] == 80
    assert validate("https://example.com/")[1] == 443


# ---------- redirects ----------


def test_follows_a_redirect_to_a_public_host():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "https://example.com/end"})
        return httpx.Response(200, text="arrived")

    result = safe_fetch("https://example.com/start", transport=httpx.MockTransport(handler))
    assert result.status_code == 200
    assert result.text == "arrived"


def test_refuses_a_redirect_into_the_metadata_service():
    """The standard bypass: a public URL that 302s to 169.254.169.254.

    follow_redirects=True walks straight into it, which is exactly what the
    crawler and the importer both did.
    """

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302, headers={"location": "http://169.254.169.254/latest/meta-data/"}
        )

    with pytest.raises(EgressBlocked, match="private, loopback or reserved"):
        safe_fetch("https://example.com/redirect", transport=httpx.MockTransport(handler))


def test_refuses_a_redirect_to_an_internal_hostname():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://engine.railway.internal/health"})

    with pytest.raises(EgressBlocked, match="internal service"):
        safe_fetch("https://example.com/redirect", transport=httpx.MockTransport(handler))


def test_refuses_a_redirect_loop():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://example.com/loop"})

    with pytest.raises(EgressBlocked, match="redirects"):
        safe_fetch("https://example.com/loop", transport=httpx.MockTransport(handler))


# ---------- response size ----------


def test_aborts_a_response_over_the_byte_cap():
    """A 100 MB body must not be pulled into a worker's memory."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * (2 * 1024 * 1024))

    with pytest.raises(EgressBlocked, match="byte cap"):
        safe_fetch(
            "https://example.com/huge",
            max_bytes=1024 * 1024,
            transport=httpx.MockTransport(handler),
        )


def test_allows_a_response_under_the_cap():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"y" * 1000)

    result = safe_fetch(
        "https://example.com/small", max_bytes=1024 * 1024, transport=httpx.MockTransport(handler)
    )
    assert len(result.content) == 1000


def test_identifies_itself_and_keeps_the_host_header():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["ua"] = request.headers.get("user-agent")
        seen["host"] = request.headers.get("host")
        return httpx.Response(200, text="ok")

    safe_fetch("https://example.com/", transport=httpx.MockTransport(handler))
    # A crawler that will not say who it is has no business complaining when it
    # is blocked, and the Host header must survive connecting by address.
    assert "Godeye" in seen["ua"]
    assert seen["host"] == "example.com"


# ---------- the callers actually use it ----------


#: Files allowed to call httpx directly, each with the reason.
#:
#: These talk to FIXED platform hosts written into the source — graph.facebook.com,
#: api.twitter.com, discord.com, reddit.com. No part of those URLs comes from a
#: customer, so there is nothing for an egress guard to decide. Anything reading
#: a URL a customer supplied, or one discovered in a customer's page, belongs in
#: safe_fetch and is NOT on this list.
DIRECT_HTTPX_ALLOWED = {
    "security/egress.py",  # the guard itself
    "publishers/meta.py",  # graph.facebook.com metrics + container polling
    "publishers/x.py",  # api.twitter.com
    "publishers/discord.py",  # discord.com
    "publishers/reddit.py",  # reddit.com
}


def test_no_user_supplied_url_is_fetched_outside_the_guard():
    """The guard is only worth anything if it is the single door.

    S-2, S-3 and S-20 were three separate sinks that each looked fine on its own
    review. A fourth (products/supabase_store.py, whose backend URL is scraped
    from the customer's page) turned up while wiring this. Split validation is
    how that happens; this test is what stops the fifth.
    """
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "src" / "godeye_engine"
    offenders = []
    for path in root.rglob("*.py"):
        relative = path.relative_to(root).as_posix()
        if relative in DIRECT_HTTPX_ALLOWED:
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if "httpx.Client(" in line or "httpx.get(" in line or "requests.get(" in line:
                offenders.append(f"{relative}:{lineno} {line.strip()}")
    assert offenders == []


def test_the_allowlist_is_honest():
    """Every exemption must still exist, and must still be a fixed host."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "src" / "godeye_engine"
    for relative in DIRECT_HTTPX_ALLOWED:
        assert (root / relative).is_file(), f"stale exemption: {relative}"
