"""Decryption of platform credentials stored by the NestJS API.

Two formats are readable, mirroring apps/api/src/common/crypto.service.ts:

    legacy  base64(iv:12) "." base64(gcmTag:16) "." base64(ciphertext)
    v1      "v1." keyId "." base64(iv) "." base64(tag) "." base64(ciphertext)

v1 carries a key id, so a key rotation does not need both services restarted in
the same second, and binds an AAD naming the owning workspace, so a ciphertext
lifted out of one tenant's row does not decrypt against another's.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import get_settings


class WeakKeyError(ValueError):
    """A key that is the right shape but is not a key."""


def assert_strong_key(name: str, key: bytes) -> None:
    """Reject format-valid keys with no entropy.

    `.env.example` used to ship 64 zeros. It satisfied every check that existed
    on both sides — Node's `/^[0-9a-fA-F]{64}$/` and this module's length test —
    so anyone who copied that file encrypted every stored platform credential
    and every TOTP secret with a key published in the repository.
    """
    distinct = len(set(key))
    if distinct == 1:
        raise WeakKeyError(f"{name} is a single byte repeated; generate one with: openssl rand -hex 32")
    if distinct < 16:
        raise WeakKeyError(
            f"{name} has only {distinct} distinct byte values and is not a random key"
        )
    ascending = sum(1 for i in range(1, len(key)) if key[i] == key[i - 1] + 1)
    if ascending > len(key) // 2:
        raise WeakKeyError(f"{name} is a counting sequence, not a random key")


def _key_bytes(name: str, hex_value: str) -> bytes:
    key = bytes.fromhex(hex_value)
    if len(key) != 32:
        raise ValueError(f"{name} must be 64 hex characters (32 bytes)")
    assert_strong_key(name, key)
    return key


def _key_id(key: bytes) -> str:
    return hashlib.sha256(key).hexdigest()[:8]


def _candidate_keys() -> list[bytes]:
    settings = get_settings()
    keys = [_key_bytes("TOKEN_ENCRYPTION_KEY", settings.require("token_encryption_key"))]
    for previous in settings.token_encryption_key_previous.split(","):
        previous = previous.strip()
        if previous:
            keys.append(_key_bytes("TOKEN_ENCRYPTION_KEY_PREVIOUS", previous))
    return keys


def _open(key: bytes, iv_b64: str, tag_b64: str, data_b64: str, aad: bytes | None) -> dict[str, Any]:
    iv = base64.b64decode(iv_b64)
    tag = base64.b64decode(tag_b64)
    ciphertext = base64.b64decode(data_b64)
    # Python's AESGCM expects ciphertext||tag; Node keeps the tag separate.
    plaintext = AESGCM(key).decrypt(iv, ciphertext + tag, aad)
    return json.loads(plaintext.decode("utf-8"))


def decrypt_credentials(payload: str, org_id: str | None = None) -> dict[str, Any]:
    """Decrypt a stored credential blob.

    `org_id` is the workspace the row belongs to. It is the AAD for v1
    ciphertexts, so omitting it on a v1 blob fails closed rather than silently
    dropping the tenant binding.
    """
    parts = payload.split(".")

    if parts and parts[0] == "v1":
        if len(parts) != 5:
            raise ValueError("Malformed encrypted credential payload")
        _, key_id, iv_b64, tag_b64, data_b64 = parts
        aad = f"org:{org_id}".encode() if org_id is not None else None
        for key in _candidate_keys():
            if hmac.compare_digest(_key_id(key), key_id):
                return _open(key, iv_b64, tag_b64, data_b64, aad)
        raise ValueError(
            f"Credentials were encrypted with key {key_id}, which is neither "
            "TOKEN_ENCRYPTION_KEY nor listed in TOKEN_ENCRYPTION_KEY_PREVIOUS"
        )

    if len(parts) != 3:
        raise ValueError("Malformed encrypted credential payload")
    iv_b64, tag_b64, data_b64 = parts
    last: Exception | None = None
    for key in _candidate_keys():
        try:
            return _open(key, iv_b64, tag_b64, data_b64, None)
        except Exception as e:  # noqa: BLE001 - try the next key during a rotation
            last = e
    raise ValueError("Unable to decrypt credentials with any configured key") from last
