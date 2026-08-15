"""A provider that returns no text must say so rather than return an empty string.

Every agent here asks for a strict output format, and every one of them treats
the reply as content. An empty string is not content, but it survives a string
return type all the way to whatever consumes it. In the image pipeline it
reached the image model as a prompt and produced a picture of the wrong thing,
with the run recorded SUCCEEDED because a picture did come back.

The specific cause was thinking left enabled on a strict-output call:
max_tokens covers thinking and the reply together, so a 600 token budget was
spent entirely on thinking and the response carried no text block at all.
"""

import pytest

from godeye_engine.ai import provider


class FakeBlock:
    def __init__(self, type_: str, text: str = ""):
        self.type = type_
        self.text = text


class FakeUsage:
    input_tokens = 3150
    output_tokens = 600


class FakeResponse:
    def __init__(self, blocks, stop_reason="end_turn"):
        self.content = blocks
        self.stop_reason = stop_reason
        self.usage = FakeUsage()


class FakeMessages:
    def __init__(self, response):
        self._response = response
        self.kwargs = {}

    def create(self, **kwargs):
        self.kwargs = kwargs
        return self._response


class FakeClient:
    def __init__(self, response):
        self.messages = FakeMessages(response)


@pytest.fixture
def anthropic_client(monkeypatch):
    """Swap the Anthropic constructor and hand back the captured call."""
    import anthropic

    holder = {}

    def install(response):
        client = FakeClient(response)
        holder["client"] = client
        monkeypatch.setattr(anthropic, "Anthropic", lambda **kw: client)
        monkeypatch.setattr(
            provider, "get_settings",
            lambda: type(
                "S", (),
                {"anthropic_api_key": "k", "anthropic_model": "claude-sonnet-5"},
            )(),
        )
        return client

    return install


def test_a_thinking_only_response_raises(anthropic_client):
    """The exact production failure: one thinking block, no text."""
    anthropic_client(FakeResponse([FakeBlock("thinking")], stop_reason="max_tokens"))

    with pytest.raises(RuntimeError, match="returned no text"):
        provider.complete("system", "user", max_tokens=600)


def test_the_error_names_the_stop_reason(anthropic_client):
    """Without it the fix is a guess. max_tokens means raise the budget."""
    anthropic_client(FakeResponse([FakeBlock("thinking")], stop_reason="max_tokens"))

    with pytest.raises(RuntimeError, match="max_tokens"):
        provider.complete("system", "user", max_tokens=600)


def test_whitespace_only_text_counts_as_empty(anthropic_client):
    anthropic_client(FakeResponse([FakeBlock("text", "   \n  ")]))

    with pytest.raises(RuntimeError, match="returned no text"):
        provider.complete("system", "user")


def test_thinking_is_disabled_on_the_request(anthropic_client):
    """The root cause. Every agent here wants a strict output format and none
    of them read a thinking block, so the budget it consumes is pure risk."""
    client = anthropic_client(FakeResponse([FakeBlock("text", "a real reply")]))

    provider.complete("system", "user", max_tokens=600)

    assert client.messages.kwargs["thinking"] == {"type": "disabled"}


def test_a_normal_reply_is_returned(anthropic_client):
    anthropic_client(FakeResponse([FakeBlock("text", "a real reply")]))

    result = provider.complete("system", "user")

    assert result.text == "a real reply"
    assert result.provider == "anthropic"
