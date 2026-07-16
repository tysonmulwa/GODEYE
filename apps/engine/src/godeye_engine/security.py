"""Decryption of platform credentials stored by the NestJS API.

Format (see apps/api/src/common/crypto.service.ts):
    base64(iv:12) . base64(gcmTag:16) . base64(ciphertext)
"""

from __future__ import annotations

import base64
import json
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import get_settings


def decrypt_credentials(payload: str) -> dict[str, Any]:
    key = bytes.fromhex(get_settings().token_encryption_key)
    if len(key) != 32:
        raise ValueError("TOKEN_ENCRYPTION_KEY must be 64 hex characters")
    try:
        iv_b64, tag_b64, data_b64 = payload.split(".")
    except ValueError as e:
        raise ValueError("Malformed encrypted credential payload") from e
    iv = base64.b64decode(iv_b64)
    tag = base64.b64decode(tag_b64)
    ciphertext = base64.b64decode(data_b64)
    # Python's AESGCM expects ciphertext||tag; Node keeps the tag separate.
    plaintext = AESGCM(key).decrypt(iv, ciphertext + tag, None)
    return json.loads(plaintext.decode("utf-8"))
