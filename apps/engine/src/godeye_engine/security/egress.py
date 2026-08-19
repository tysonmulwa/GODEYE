"""The one place this system is allowed to fetch a URL somebody else supplied.

Findings S-2, S-3 and S-20. Three entry points accepted an arbitrary URL and
fetched it from inside the private network with ``follow_redirects=True`` and no
validation of scheme, host or resolved address:

    S-2   POST /seo/audit      -> crawler.py
    S-3   POST /products/import -> products/sources.py
    S-20  download_media(url)   -> publishers/base.py, called from five publishers

Reachable from those: cloud metadata endpoints, every ``*.railway.internal``
service including the engine's own ``/health`` (which echoes database and Redis
error strings), and every host in the deployment network. Parsed responses were
stored on ``SeoAudit`` and read back through ``GET /seo/audits/:id``, so the
channel was bidirectional.

Everything here is one function, ``safe_fetch``, and a lint rule forbids calling
httpx or requests directly outside this module. Split validation is how these
things regress: one caller gets a check, the next one added does not.

CWE-918, OWASP API7. The DNS-rebinding defence is CWE-367 applied to SSRF.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from dataclasses import dataclass
from urllib.parse import urlencode, urlparse, urlunparse

import httpx

logger = logging.getLogger(__name__)

#: Only these. `file://` reads the disk, `gopher://` forges arbitrary TCP
#: payloads, `dict://` and `ftp://` reach services that were never meant to be
#: addressable this way.
ALLOWED_SCHEMES = frozenset({"http", "https"})

#: 80 and 443 unless an operator widens it. A URL pointing at :22 or :6379 is
#: not a web page under any reading.
ALLOWED_PORTS = frozenset({80, 443})

#: Hostnames that resolve to somewhere private on at least one cloud, or that
#: name an internal service directly. Checked by name as well as by address,
#: because a name can resolve differently from where we look it up.
BLOCKED_HOSTS = frozenset(
    {
        "metadata.google.internal",
        "metadata",
        "instance-data",
        "localhost",
        "localhost.localdomain",
    }
)

#: Any host ending in one of these is internal by construction.
BLOCKED_SUFFIXES = (
    ".internal",
    ".railway.internal",
    ".local",
    ".localhost",
    ".cluster.local",
    ".svc",
    ".svc.cluster.local",
)

#: Addresses that are never a customer's website.
BLOCKED_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "0.0.0.0/8",  # "this network"
        "10.0.0.0/8",
        "100.64.0.0/10",  # CGNAT
        "127.0.0.0/8",  # loopback
        "169.254.0.0/16",  # link-local, and AWS/Azure/GCP metadata
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",  # benchmarking
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",  # multicast
        "240.0.0.0/4",  # reserved
        "255.255.255.255/32",
        "::1/128",
        "fc00::/7",  # unique local
        "fe80::/10",  # link-local
        "ff00::/8",  # multicast
        "::/128",
    )
)

#: Alibaba Cloud's metadata service is a plain public-looking address.
BLOCKED_ADDRESSES = frozenset({ipaddress.ip_address("100.100.100.200")})

DEFAULT_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_CONNECT_TIMEOUT = 5.0
DEFAULT_TOTAL_TIMEOUT = 15.0
MAX_REDIRECTS = 3

#: Identifies us to the sites we read. A crawler that will not say who it is has
#: no business complaining when it is blocked, and this is a legal point as much
#: as a technical one.
USER_AGENT = "GodeyeBot/1.0 (+https://godeyeautomation.com/bot)"


class EgressBlocked(ValueError):
    """A URL was refused before any connection was made."""

    def __init__(self, url: str, reason: str) -> None:
        super().__init__(f"Refused to fetch {url}: {reason}")
        self.url = url
        self.reason = reason


@dataclass(frozen=True)
class SafeResponse:
    status_code: int
    headers: dict[str, str]
    content: bytes
    url: str

    @property
    def text(self) -> str:
        encoding = "utf-8"
        content_type = self.headers.get("content-type", "")
        if "charset=" in content_type:
            encoding = content_type.split("charset=")[-1].split(";")[0].strip() or "utf-8"
        return self.content.decode(encoding, errors="replace")


def _is_blocked_address(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    # An IPv4-mapped IPv6 literal (::ffff:127.0.0.1) is the bypass that gets
    # missed: it is not in any IPv6 blocked range, and it connects to loopback.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip in BLOCKED_ADDRESSES:
        return True
    if any(ip in network for network in BLOCKED_NETWORKS):
        return True
    # Belt and braces: the stdlib's own view, for anything the list missed.
    return bool(
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
    )


def _resolve(host: str, port: int) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise EgressBlocked(host, f"hostname does not resolve ({e})") from e
    addresses = []
    for info in infos:
        raw = info[4][0]
        try:
            addresses.append(ipaddress.ip_address(raw))
        except ValueError:
            continue
    if not addresses:
        raise EgressBlocked(host, "hostname resolved to nothing usable")
    return addresses


def validate(url: str) -> tuple[str, int, str, ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Check a URL and return (host, port, scheme, the address to connect to).

    Raises ``EgressBlocked`` with a reason. Every rejection is a reason a human
    can act on — "refused to fetch http://10.0.0.1/: address 10.0.0.1 is
    private", not a bare False.
    """
    parsed = urlparse(url)

    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        raise EgressBlocked(url, f"scheme {parsed.scheme or '(none)'} is not http or https")
    if parsed.username or parsed.password:
        # `http://user:pass@evil.com/` is also how a URL is made to *look* like
        # it points somewhere it does not.
        raise EgressBlocked(url, "credentials in the URL are not allowed")

    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        raise EgressBlocked(url, "no host")

    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    if port not in ALLOWED_PORTS:
        raise EgressBlocked(url, f"port {port} is not 80 or 443")

    if host in BLOCKED_HOSTS or host.endswith(BLOCKED_SUFFIXES):
        raise EgressBlocked(url, f"host {host} names an internal service")

    # A literal address skips DNS entirely, so check it as written first.
    try:
        literal = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        literal = None
    if literal is not None:
        if _is_blocked_address(literal):
            raise EgressBlocked(url, f"address {literal} is private, loopback or reserved")
        return host, port, parsed.scheme.lower(), literal

    addresses = _resolve(host, port)
    # EVERY answer must be acceptable, not just the first: a DNS record with one
    # public and one private answer would otherwise be a coin flip.
    for address in addresses:
        if _is_blocked_address(address):
            raise EgressBlocked(url, f"{host} resolves to {address}, which is private or reserved")
    return host, port, parsed.scheme.lower(), addresses[0]


def _connect_url(url: str, address: ipaddress.IPv4Address | ipaddress.IPv6Address, port: int) -> str:
    """Rewrite the URL to the address we validated.

    This is the difference between a real guard and a decorative one. Resolving
    a name and then letting the HTTP client resolve it *again* at connect time
    leaves a window where the second answer differs from the first — DNS
    rebinding, CWE-367. Connecting to the address we checked closes it.
    """
    parsed = urlparse(url)
    literal = f"[{address}]" if address.version == 6 else str(address)
    return urlunparse(parsed._replace(netloc=f"{literal}:{port}"))


def safe_fetch(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
    total_timeout: float = DEFAULT_TOTAL_TIMEOUT,
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
    org_id: str | None = None,
    transport: httpx.BaseTransport | None = None,
) -> SafeResponse:
    """Fetch a user-supplied URL, or refuse and say why.

    Redirects are followed by hand, at most ``MAX_REDIRECTS`` times, revalidating
    every hop. A 302 to ``169.254.169.254`` is the standard bypass and an
    automatic redirect walks straight into it.

    ``transport`` exists so the redirect and byte-cap paths can be driven from a
    test without a live server. It changes nothing about the checks: validation
    runs before a transport is ever consulted, so a mocked transport cannot make
    a blocked URL reachable.
    """
    current = url
    for hop in range(MAX_REDIRECTS + 1):
        try:
            host, port, scheme, address = validate(current)
        except EgressBlocked as blocked:
            # Logged with the workspace so abuse is visible rather than inferred
            # from a support ticket.
            logger.warning(
                "Egress blocked org=%s url=%s hop=%d reason=%s",
                org_id or "-",
                current,
                hop,
                blocked.reason,
            )
            raise

        request_headers = {"User-Agent": USER_AGENT, **(headers or {}), "Host": host}
        timeout = httpx.Timeout(total_timeout, connect=connect_timeout)

        with httpx.Client(
            follow_redirects=False,
            timeout=timeout,
            verify=scheme == "https",
            transport=transport,
        ) as client:
            request = client.build_request(
                method,
                _connect_url(current, address, port),
                headers=request_headers,
                # TLS is negotiated for the NAME even though the socket goes to
                # the address we pinned, so certificate validation still means
                # something.
                extensions={"sni_hostname": host},
            )
            response = client.send(request, stream=True)
            try:
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get("location")
                    if not location:
                        raise EgressBlocked(current, "redirect with no Location")
                    # Resolved against the URL as written, not the pinned
                    # address, so a relative Location lands on the right host.
                    current = str(httpx.URL(current).join(location))
                    redirected = True
                else:
                    redirected = False
                    body = bytearray()
                    # Streamed and counted as it arrives. Reading first and
                    # checking afterwards is how a 100 MB body ends up in a
                    # worker's memory before anybody objects to it.
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > max_bytes:
                            raise EgressBlocked(
                                current, f"response exceeded the {max_bytes} byte cap"
                            )
                    result = SafeResponse(
                        status_code=response.status_code,
                        headers={k.lower(): v for k, v in response.headers.items()},
                        content=bytes(body),
                        url=current,
                    )
            finally:
                response.close()
            if redirected:
                continue
            return result

    raise EgressBlocked(url, f"more than {MAX_REDIRECTS} redirects")


class SafeClient:
    """A drop-in for ``httpx.Client`` that only speaks through ``safe_fetch``.

    Deliberately narrow: ``get`` and ``close``, which is all the crawler and the
    product importer ever used. A wider surface would invite somebody to reach
    for a method that bypasses the guard, and the guard is only worth anything
    if it is the single door.
    """

    def __init__(
        self,
        *,
        headers: dict[str, str] | None = None,
        max_bytes: int = DEFAULT_MAX_BYTES,
        total_timeout: float = DEFAULT_TOTAL_TIMEOUT,
        org_id: str | None = None,
    ) -> None:
        self._headers = headers or {}
        self._max_bytes = max_bytes
        self._total_timeout = total_timeout
        self._org_id = org_id

    def get(
        self,
        url: str,
        *,
        params: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> SafeResponse:
        if params:
            separator = "&" if urlparse(url).query else "?"
            url = f"{url}{separator}{urlencode(params)}"
        return safe_fetch(
            url,
            headers=self._headers,
            max_bytes=self._max_bytes,
            total_timeout=timeout or self._total_timeout,
            org_id=self._org_id,
        )

    def close(self) -> None:  # parity with httpx.Client, nothing to release
        return None

    def __enter__(self) -> SafeClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
