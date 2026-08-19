"""Security primitives: credential decryption, and the outbound egress guard.

`security.py` became a package when the SSRF fix (S-2, S-3, S-20) needed a
second module next to it. The credential functions keep their old import path —
`from ..security import decrypt_credentials` still works — because there is no
reason to churn five call sites for a file move.
"""

from .credentials import (  # noqa: F401
    WeakKeyError,
    assert_strong_key,
    decrypt_credentials,
)
from .egress import (  # noqa: F401
    EgressBlocked,
    SafeClient,
    SafeResponse,
    safe_fetch,
    validate,
)

__all__ = [
    "EgressBlocked",
    "SafeClient",
    "SafeResponse",
    "WeakKeyError",
    "assert_strong_key",
    "decrypt_credentials",
    "safe_fetch",
    "validate",
]
