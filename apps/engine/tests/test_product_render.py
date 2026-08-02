"""Reading a storefront that builds its catalogue in the browser.

Mjini Collection is the real case: four kilobytes of HTML and a mount point,
so a plain fetch finds nothing and the shop looks empty.
"""

from __future__ import annotations

import httpx
import pytest

from godeye_engine.config import get_settings
from godeye_engine.products import render, sources
from godeye_engine.products.sources import FOUND, NEEDS_RENDERING, NO_CATALOGUE, import_from_site
from tests.test_product_sources import SHELL, fake_transport

RENDERED_HOME = """<html><body>
  <a href="/products/hand-cream">Hand Cream</a>
  <a href="/about">About</a>
  <a href="https://elsewhere.example/products/x">Not ours</a>
</body></html>"""

RENDERED_PRODUCT = """<html><body><script type="application/ld+json">
{"@type":"Product","name":"Hand Cream","offers":{"price":"9.99","priceCurrency":"GBP"}}
</script></body></html>"""


@pytest.fixture(autouse=True)
def clear_settings():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def shell_site(monkeypatch):
    """A storefront that returns its shell to every plain fetch."""
    transport = fake_transport({"https://spa.example": httpx.Response(200, text=SHELL)})
    monkeypatch.setattr(
        sources, "_client", lambda: httpx.Client(transport=transport, follow_redirects=True)
    )


class TestWhenRenderingIsNotConfigured:
    def test_the_user_is_told_what_to_set_up(self, shell_site, monkeypatch):
        monkeypatch.setattr(render, "is_configured", lambda: False)
        result = import_from_site("https://spa.example")
        assert result.verdict == NEEDS_RENDERING
        # Actionable, not just "failed": it names the variable and a container
        # anyone can run, so the feature does not require buying a product.
        assert "BROWSER_RENDER_URL" in (result.detail or "")
        assert "browserless" in (result.detail or "").lower()


class TestWhenRenderingWorks:
    def test_a_rendered_storefront_yields_its_products(self, shell_site, monkeypatch):
        monkeypatch.setattr(render, "is_configured", lambda: True)
        monkeypatch.setattr(
            render,
            "render",
            lambda url: render.Rendered(
                html=RENDERED_PRODUCT if "hand-cream" in url else RENDERED_HOME
            ),
        )
        result = import_from_site("https://spa.example")
        assert result.verdict == FOUND
        assert result.route == "render"
        assert [p.title for p in result.products] == ["Hand Cream"]

    def test_links_are_taken_from_the_rendered_page_not_the_shell(
        self, shell_site, monkeypatch
    ):
        """The shell has no links — they are drawn by the JavaScript. Reading
        them from the plain fetch would find nothing to render."""
        asked: list[str] = []

        def fake_render(url):
            asked.append(url)
            return render.Rendered(
                html=RENDERED_PRODUCT if "hand-cream" in url else RENDERED_HOME
            )

        monkeypatch.setattr(render, "is_configured", lambda: True)
        monkeypatch.setattr(render, "render", fake_render)
        import_from_site("https://spa.example")
        assert "https://spa.example/products/hand-cream" in asked

    def test_offsite_links_are_not_rendered(self, shell_site, monkeypatch):
        asked: list[str] = []

        def fake_render(url):
            asked.append(url)
            return render.Rendered(html=RENDERED_HOME if url.endswith("example") else "<html/>")

        monkeypatch.setattr(render, "is_configured", lambda: True)
        monkeypatch.setattr(render, "render", fake_render)
        import_from_site("https://spa.example")
        assert not any("elsewhere.example" in u for u in asked)

    def test_a_rendered_site_with_no_products_is_not_a_shop(self, shell_site, monkeypatch):
        """Rendered successfully and still empty is a different answer from
        "we could not read it" — and it should not ask to be retried."""
        monkeypatch.setattr(render, "is_configured", lambda: True)
        monkeypatch.setattr(
            render, "render", lambda url: render.Rendered(html="<html><body>A blog</body></html>")
        )
        result = import_from_site("https://spa.example")
        assert result.verdict == NO_CATALOGUE

    def test_a_failing_renderer_keeps_the_needs_rendering_verdict(
        self, shell_site, monkeypatch
    ):
        monkeypatch.setattr(render, "is_configured", lambda: True)
        monkeypatch.setattr(
            render, "render", lambda url: render.Rendered(html=None, detail="browser timed out")
        )
        result = import_from_site("https://spa.example")
        assert result.verdict == NEEDS_RENDERING
        assert "timed out" in (result.detail or "")


class TestTheRenderRequest:
    def _configure(self, monkeypatch, **env):
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        get_settings.cache_clear()

    def test_posts_the_url_and_waits_for_the_network_to_settle(self, monkeypatch):
        """A catalogue arrives when its fetch resolves, not after a fixed
        delay, so the wait has to be network-idle."""
        sent: dict = {}

        def fake_post(url, **kwargs):
            sent.update({"url": url, **kwargs})
            return httpx.Response(200, text="<html>rendered</html>")

        self._configure(monkeypatch, BROWSER_RENDER_URL="https://chrome.internal/content")
        monkeypatch.setattr(render.httpx, "post", fake_post)
        result = render.render("https://spa.example")
        assert result.ok
        assert sent["json"]["url"] == "https://spa.example"
        assert sent["json"]["gotoOptions"]["waitUntil"] == "networkidle2"

    def test_a_token_is_sent_when_one_is_set(self, monkeypatch):
        sent: dict = {}
        self._configure(
            monkeypatch,
            BROWSER_RENDER_URL="https://chrome.internal/content",
            BROWSER_RENDER_TOKEN="secret",
        )
        monkeypatch.setattr(
            render.httpx,
            "post",
            lambda url, **kw: sent.update(kw) or httpx.Response(200, text="<html/>"),
        )
        render.render("https://spa.example")
        assert sent["params"] == {"token": "secret"}

    def test_a_rejected_token_says_so(self, monkeypatch):
        self._configure(monkeypatch, BROWSER_RENDER_URL="https://chrome.internal/content")
        monkeypatch.setattr(render.httpx, "post", lambda url, **kw: httpx.Response(403))
        result = render.render("https://spa.example")
        assert not result.ok
        assert "TOKEN" in (result.detail or "")

    def test_a_network_failure_is_reported_not_raised(self, monkeypatch):
        def boom(url, **kwargs):
            raise httpx.ConnectError("refused")

        self._configure(monkeypatch, BROWSER_RENDER_URL="https://chrome.internal/content")
        monkeypatch.setattr(render.httpx, "post", boom)
        result = render.render("https://spa.example")
        assert not result.ok and "did not answer" in (result.detail or "")

    def test_an_empty_page_is_not_a_success(self, monkeypatch):
        self._configure(monkeypatch, BROWSER_RENDER_URL="https://chrome.internal/content")
        monkeypatch.setattr(render.httpx, "post", lambda url, **kw: httpx.Response(200, text="  "))
        assert not render.render("https://spa.example").ok

    def test_playwright_missing_says_how_to_proceed(self, monkeypatch):
        """The dependency is optional on purpose — Chromium is heavier than the
        ffmpeg that got this worker killed."""
        self._configure(monkeypatch, BROWSER_RENDER_PROVIDER="playwright")
        import builtins

        real_import = builtins.__import__

        def no_playwright(name, *args, **kwargs):
            if name.startswith("playwright"):
                raise ImportError("no playwright")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", no_playwright)
        result = render.render("https://spa.example")
        assert not result.ok
        assert "not installed" in (result.detail or "")


def test_nothing_renders_until_it_is_configured(monkeypatch):
    """Rendering is opt-in: without it, behaviour is exactly as before."""
    get_settings.cache_clear()
    monkeypatch.delenv("BROWSER_RENDER_URL", raising=False)
    monkeypatch.delenv("BROWSER_RENDER_PROVIDER", raising=False)
    get_settings.cache_clear()
    assert render.is_configured() is False
