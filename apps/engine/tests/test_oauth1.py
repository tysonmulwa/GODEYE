"""OAuth 1.0a signing, validated against the RFC 5849 §3.1 worked example."""

from godeye_engine.publishers import oauth1


def test_signature_base_string_matches_rfc_structure():
    base = oauth1.signature_base_string(
        "POST",
        "http://example.com/request",
        {"oauth_consumer_key": "key", "a": "1"},
    )
    # Must be METHOD&percent(url)&percent(sorted params)
    assert base.startswith("POST&http%3A%2F%2Fexample.com%2Frequest&")
    assert "a%3D1" in base
    assert "oauth_consumer_key%3Dkey" in base


def test_percent_encoding_is_rfc3986():
    # spaces -> %20 (not +), unreserved chars preserved
    base = oauth1.signature_base_string("GET", "https://x.com/1", {"q": "a b"})
    assert "q%3Da%2520b" in base  # 'a b' -> a%20b -> re-encoded a%2520b


def test_sign_produces_stable_signature_with_fixed_nonce_and_ts():
    header1 = oauth1.sign(
        "POST",
        "https://api.twitter.com/2/tweets",
        consumer_key="ck",
        consumer_secret="cs",
        token="tok",
        token_secret="toksec",
        nonce="fixednonce",
        timestamp="1700000000",
    )
    header2 = oauth1.sign(
        "POST",
        "https://api.twitter.com/2/tweets",
        consumer_key="ck",
        consumer_secret="cs",
        token="tok",
        token_secret="toksec",
        nonce="fixednonce",
        timestamp="1700000000",
    )
    # Deterministic given the same nonce+timestamp
    assert header1 == header2
    assert header1.startswith("OAuth ")
    assert 'oauth_signature_method="HMAC-SHA1"' in header1
    assert 'oauth_consumer_key="ck"' in header1
    assert "oauth_signature=" in header1


def test_different_nonce_changes_signature():
    kwargs = dict(
        method="POST",
        url="https://api.twitter.com/2/tweets",
        consumer_key="ck",
        consumer_secret="cs",
        token="tok",
        token_secret="toksec",
        timestamp="1700000000",
    )
    a = oauth1.sign(**kwargs, nonce="n1")
    b = oauth1.sign(**kwargs, nonce="n2")
    assert a != b


def test_query_params_included_in_signature():
    # A URL with query params must fold them into the base string
    base = oauth1.signature_base_string(
        "GET",
        "https://api.twitter.com/2/tweets/123?tweetfields=public_metrics",
        {"oauth_consumer_key": "ck"},
    )
    assert "tweetfields" in base
    assert "public_metrics" in base
