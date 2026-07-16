"""Credential decryption must interop with the Node AES-256-GCM format."""

import base64
import json
import os

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from godeye_engine import security
from godeye_engine.config import get_settings

KEY_HEX = "ab" * 32


def encrypt_like_node(key_hex: str, payload: dict) -> str:
    """Reproduce apps/api CryptoService.encrypt: iv.tag.ciphertext (base64)."""
    key = bytes.fromhex(key_hex)
    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, json.dumps(payload).encode(), None)
    ciphertext, tag = sealed[:-16], sealed[-16:]
    return ".".join(
        base64.b64encode(part).decode() for part in (iv, tag, ciphertext)
    )


@pytest.fixture(autouse=True)
def configured_key(monkeypatch):
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", KEY_HEX)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_decrypts_node_format():
    creds = {"botToken": "123:abc", "chatId": "-100999"}
    assert security.decrypt_credentials(encrypt_like_node(KEY_HEX, creds)) == creds


def test_rejects_tampered_payload():
    blob = encrypt_like_node(KEY_HEX, {"a": 1})
    iv, tag, data = blob.split(".")
    raw = bytearray(base64.b64decode(data))
    raw[0] ^= 0xFF
    tampered = ".".join([iv, tag, base64.b64encode(bytes(raw)).decode()])
    with pytest.raises(Exception):
        security.decrypt_credentials(tampered)


def test_rejects_malformed_payload():
    with pytest.raises(ValueError):
        security.decrypt_credentials("not-a-valid-blob")
