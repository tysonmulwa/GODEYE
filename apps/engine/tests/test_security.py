"""Credential decryption must interop with the Node AES-256-GCM format."""

import base64
import hashlib
import json
import os

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from godeye_engine import security
from godeye_engine.config import InsecureConfigError, get_settings

# A real-looking key. This was "ab" * 32 — every byte 0xab — which the weak-key
# check added for finding S-6 now rejects, correctly: a key with one distinct
# byte value is not a key. The test is about Node/Python interop, not about
# accepting weak keys, so the fixture moved rather than the rule.
KEY_HEX = "b3126e1542fa317004bc1c192e87c6afc2bbfae1674ffae2b159df41d7743209"
OTHER_KEY_HEX = "6eda579dfc262ed8032593429aab8b84bbe279c297e8e95f0707617c7c35c49d"


def encrypt_like_node(key_hex: str, payload: dict) -> str:
    """Reproduce the legacy CryptoService format: iv.tag.ciphertext (base64)."""
    key = bytes.fromhex(key_hex)
    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, json.dumps(payload).encode(), None)
    ciphertext, tag = sealed[:-16], sealed[-16:]
    return ".".join(
        base64.b64encode(part).decode() for part in (iv, tag, ciphertext)
    )


def encrypt_v1(key_hex: str, payload: dict, org_id: str | None) -> str:
    """Reproduce the current format: v1.keyId.iv.tag.ciphertext, AAD = org:<id>."""
    key = bytes.fromhex(key_hex)
    iv = os.urandom(12)
    aad = f"org:{org_id}".encode() if org_id is not None else None
    sealed = AESGCM(key).encrypt(iv, json.dumps(payload).encode(), aad)
    ciphertext, tag = sealed[:-16], sealed[-16:]
    key_id = hashlib.sha256(key).hexdigest()[:8]
    return ".".join(
        ["v1", key_id, *(base64.b64encode(p).decode() for p in (iv, tag, ciphertext))]
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
    # ValueError specifically, not Exception. A blind `raises(Exception)` is
    # satisfied by a NameError or an AttributeError too, so it passes whether
    # the tamper was detected or the code simply broke -- which is the same
    # weak assertion that let a missing `InvalidOperation` import sit unnoticed
    # in products/compliance.py.
    with pytest.raises(ValueError):
        security.decrypt_credentials(tampered)


def test_rejects_malformed_payload():
    with pytest.raises(ValueError):
        security.decrypt_credentials("not-a-valid-blob")


# ---------- v1: key versioning and tenant binding (findings S-6, S-6b) ----------


def test_decrypts_v1_with_matching_org():
    creds = {"botToken": "123:abc"}
    blob = encrypt_v1(KEY_HEX, creds, "org_1")
    assert security.decrypt_credentials(blob, "org_1") == creds


def test_v1_refuses_a_ciphertext_moved_to_another_tenant():
    """The whole point of the AAD: a row copied between workspaces must not open."""
    blob = encrypt_v1(KEY_HEX, {"botToken": "123:abc"}, "org_1")
    # InvalidTag, named exactly. It is the GCM authentication tag refusing --
    # the AAD binding doing its job -- and it is a different failure from a
    # malformed payload or a missing key, which both raise ValueError. A blind
    # `raises(Exception)` could not tell the three apart, and would pass just
    # as happily if the call raised because the code was broken.
    with pytest.raises(InvalidTag):
        security.decrypt_credentials(blob, "org_2")


def test_v1_names_the_key_it_cannot_find(monkeypatch):
    blob = encrypt_v1(OTHER_KEY_HEX, {"a": 1}, "org_1")
    with pytest.raises(ValueError, match="TOKEN_ENCRYPTION_KEY_PREVIOUS"):
        security.decrypt_credentials(blob, "org_1")


def test_previous_key_still_decrypts_during_a_rotation(monkeypatch):
    blob = encrypt_v1(OTHER_KEY_HEX, {"a": 1}, "org_1")
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY_PREVIOUS", OTHER_KEY_HEX)
    get_settings.cache_clear()
    assert security.decrypt_credentials(blob, "org_1") == {"a": 1}


@pytest.mark.parametrize(
    "weak_hex",
    [
        "00" * 32,  # what .env.example used to ship
        "ab" * 32,  # one byte repeated
        "".join(f"{i:02x}" for i in range(32)),  # a counting sequence
    ],
)
def test_refuses_a_format_valid_key_with_no_entropy(monkeypatch, weak_hex):
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", weak_hex)
    get_settings.cache_clear()
    with pytest.raises(ValueError):
        security.decrypt_credentials(encrypt_like_node(KEY_HEX, {"a": 1}))


def test_refuses_a_missing_key(monkeypatch):
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", "")
    get_settings.cache_clear()
    # InsecureConfigError, not ValueError: an unset key is a configuration
    # refusal, and the boot gate raises its own type so it can be told apart
    # from a decryption failure at runtime.
    with pytest.raises(InsecureConfigError):
        security.decrypt_credentials(encrypt_like_node(KEY_HEX, {"a": 1}))
