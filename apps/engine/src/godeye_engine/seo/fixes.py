"""Turn audit findings into concrete, stack-aware fixes.

A finding says *"this page has no meta description"*. That is a diagnosis, and a
diagnosis changes nothing on the internet. A fix carries the literal tag to
paste, plus the name of the screen in *this customer's* CMS where it goes.

Every fix is expressed the same way regardless of how it will eventually reach
the site, so the write channels added later (Cloudflare edge injection,
WordPress REST, Shopify Admin, a GitHub PR) consume exactly what the
copy-and-paste Fix Pack consumes today.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from html import escape
from urllib.parse import urlparse

from .audit import Finding
from .crawler import CrawlResult, PageData

# Kinds mirror the FixKind enum in packages/db/prisma/schema.prisma.
HEAD_TAG = "HEAD_TAG"
FILE = "FILE"
ATTRIBUTE = "ATTRIBUTE"
MANUAL = "MANUAL"

MAX_PER_CODE = 20  # one systemic problem shouldn't produce 200 rows
MAX_TOTAL = 120


@dataclass
class Fix:
    code: str  # the finding code this resolves
    kind: str
    severity: str
    target_url: str
    title: str
    guidance: str
    before: str | None = None
    after: str | None = None
    file_path: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------
# Where the change goes, per stack
# --------------------------------------------------------------------------

# Platforms group into families that share an editing model. Naming the actual
# screen ("Yoast → SEO title") is the whole point, generic advice like "update
# your meta tags" is what the user already had before they bought the product.
FAMILY: dict[str, str] = {
    "wordpress": "wordpress",
    "woocommerce": "wordpress",
    "shopify": "shopify",
    "wix": "builder",
    "squarespace": "builder",
    "webflow": "builder",
    "ghost": "builder",
    "framer": "builder",
    "drupal": "cms",
    "joomla": "cms",
    "typo3": "cms",
    "magento": "ecommerce",
    "prestashop": "ecommerce",
    "shopware": "ecommerce",
    "bigcommerce": "ecommerce",
    "nextjs": "code",
    "nuxt": "code",
    "gatsby": "code",
    "astro": "code",
    "hugo": "code",
    "jekyll": "code",
    "html": "code",
}

LABEL: dict[str, str] = {
    "wordpress": "WordPress",
    "woocommerce": "WooCommerce",
    "shopify": "Shopify",
    "wix": "Wix",
    "squarespace": "Squarespace",
    "webflow": "Webflow",
    "ghost": "Ghost",
    "framer": "Framer",
    "drupal": "Drupal",
    "joomla": "Joomla",
    "typo3": "TYPO3",
    "magento": "Magento / Adobe Commerce",
    "prestashop": "PrestaShop",
    "shopware": "Shopware",
    "bigcommerce": "BigCommerce",
    "nextjs": "Next.js",
    "nuxt": "Nuxt",
    "gatsby": "Gatsby",
    "astro": "Astro",
    "hugo": "Hugo",
    "jekyll": "Jekyll",
    "html": "hand-written HTML",
}

# family -> category -> where to put it.
GUIDE: dict[str, dict[str, str]] = {
    "wordpress": {
        "meta": (
            "Edit the page, scroll to the Yoast SEO (or Rank Math / AIOSEO) box below "
            "the editor, and paste this into the SEO title and meta description "
            "fields. Do not paste raw HTML there, use the text between the tags."
        ),
        "jsonld": (
            "Yoast and Rank Math both output schema automatically. If you are not "
            "using one, add this with a snippet plugin (WPCode) targeting the site "
            "header, or paste it into your child theme's header.php before </head>."
        ),
        "root_file": (
            "Yoast SEO → Tools → File editor can write robots.txt directly. Yoast "
            "also generates the sitemap at /sitemap_index.xml, so you usually want "
            "that URL rather than uploading a static file. For a plain file, upload "
            "it to the WordPress root over SFTP."
        ),
        "img_alt": (
            "Media → Library, click each image, and fill in the Alternative Text "
            "field. Editing it in the Media Library updates it everywhere the image "
            "is used."
        ),
    },
    "shopify": {
        "meta": (
            "Open the product, collection or page in Shopify admin, scroll to Search "
            "engine listing and click Edit. Paste the title and description into "
            "those two fields, text only, not the HTML tags."
        ),
        "jsonld": (
            "Online Store → Themes → ⋯ → Edit code → layout/theme.liquid, and paste "
            "this just before </head>."
        ),
        "root_file": (
            "Shopify generates /sitemap.xml for you, do not upload one. robots.txt "
            "is editable via Themes → Edit code → templates/robots.txt.liquid."
        ),
        "img_alt": (
            "Click the image in the product or Content → Files, then use Add alt "
            "text. Theme images are edited in the theme customiser."
        ),
    },
    "builder": {
        "meta": (
            "Open the page in the editor and find its SEO / page settings panel "
            "(Wix: SEO Basics; Squarespace: Page Settings → SEO; Webflow: Page "
            "Settings → SEO; Ghost: Post settings → Meta data). Paste the text into "
            "the title and description fields."
        ),
        "jsonld": (
            "Add it as a custom code block in the site header. Wix: Settings → "
            "Custom Code; Squarespace: Settings → Advanced → Code Injection → "
            "Header; Webflow: Project Settings → Custom Code → Head."
        ),
        "root_file": (
            "These platforms generate and serve robots.txt and sitemap.xml "
            "themselves, you cannot upload your own, and you should not try. Use "
            "the built-in editor (Wix: SEO Tools → Robots.txt Editor; Squarespace "
            "and Webflow: Settings → SEO) if you need to change robots rules."
        ),
        "img_alt": (
            "Select the image in the editor and fill in its alt text field (Wix and "
            "Squarespace both label it 'Alt text'; Webflow uses the Settings panel)."
        ),
    },
    "cms": {
        "meta": (
            "Edit the node/article and fill in its metadata fields. Drupal: the "
            "Metatag section (or Metatag module); Joomla: Publishing tab → Meta "
            "Description / Browser Page Title; TYPO3: page properties → Metadata."
        ),
        "jsonld": (
            "Add it through your template layer (Drupal: html.html.twig; TYPO3: "
            "TypoScript page.headerData; Joomla: template index.php) before </head>."
        ),
        "root_file": (
            "Upload the file to the web root over SFTP, next to index.php. Check "
            "your rewrite rules do not intercept the path first."
        ),
        "img_alt": (
            "Edit each image in the media library and fill in its alt text field."
        ),
    },
    "ecommerce": {
        "meta": (
            "Open the product or CMS page in admin and fill in its SEO fields, "
            "Magento: Search Engine Optimization section; PrestaShop: SEO & URLs "
            "tab; Shopware: SEO section; BigCommerce: product → SEO. Paste the text "
            "only, not the tags."
        ),
        "jsonld": (
            "Add it to your theme's head template, or via the platform's HTML head "
            "injection setting (Magento: Content → Design → Configuration → HTML "
            "Head → Scripts and Style Sheets)."
        ),
        "root_file": (
            "Most of these generate a sitemap for you (Magento: Marketing → SEO & "
            "Search → Site Map). robots.txt is usually editable in admin. Magento: "
            "Content → Design → Configuration → Search Engine Robots. Prefer the "
            "admin setting over uploading a file."
        ),
        "img_alt": (
            "Edit the product image in admin and set its alt / label field."
        ),
    },
    "code": {
        "meta": (
            "Add this to the page's <head>. In Next.js use the Metadata export (or "
            "next/head); in Nuxt useHead(); in Astro the <head> of the layout; in "
            "Hugo or Jekyll the head partial, driven by front matter so each page "
            "differs."
        ),
        "jsonld": (
            "Render this as a <script type=\"application/ld+json\"> in your document "
            "head, for a framework, in the root layout so it appears on every page."
        ),
        "root_file": (
            "Drop the file in your public/static directory (Next.js: public/; Astro "
            "and Nuxt: public/; Hugo: static/; Jekyll: the site root) and redeploy. "
            "It must be served from the domain root."
        ),
        "img_alt": (
            "Add an alt attribute to each <img> in the source. Decorative images "
            "should get alt=\"\" rather than being left out."
        ),
    },
}


def guidance_for(platform: str, category: str) -> str:
    family = FAMILY.get(platform, "code")
    return GUIDE[family][category]


def _brand(url: str) -> str:
    host = urlparse(url).netloc.replace("www.", "")
    return host.split(".")[0].replace("-", " ").title()


def _attr(value: str) -> str:
    """Escape a string for use inside a double-quoted HTML attribute."""
    return escape(value, quote=True)


# --------------------------------------------------------------------------
# Building fixes
# --------------------------------------------------------------------------


@dataclass
class _Context:
    result: CrawlResult
    pages_by_url: dict[str, PageData]
    meta_by_url: dict[str, dict]
    platform: str
    fixes: list[Fix] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)

    def add(self, fix: Fix) -> None:
        if len(self.fixes) >= MAX_TOTAL:
            return
        if self.counts.get(fix.code, 0) >= MAX_PER_CODE:
            return
        self.counts[fix.code] = self.counts.get(fix.code, 0) + 1
        self.fixes.append(fix)


def _title_fix(ctx: _Context, finding: Finding) -> None:
    page = ctx.pages_by_url.get(finding.page)
    suggested = (ctx.meta_by_url.get(finding.page) or {}).get("suggestedTitle")
    if not suggested and page:
        # No AI suggestion available, derive something honest from the page's own
        # H1 rather than inventing a claim about the business.
        heading = (page.h1s or [None])[0]
        if heading:
            suggested = f"{heading} | {_brand(finding.page)}"[:60]
    if not suggested:
        ctx.add(
            Fix(
                code=finding.code,
                kind=MANUAL,
                severity=finding.severity,
                target_url=finding.page,
                title="Write a page title",
                before=page.title if page else None,
                guidance=(
                    "This page needs a unique title under 60 characters containing "
                    "the term you want it to rank for. There is not enough content "
                    "on the page to draft one automatically.\n\n"
                    + guidance_for(ctx.platform, "meta")
                ),
            )
        )
        return
    ctx.add(
        Fix(
            code=finding.code,
            kind=HEAD_TAG,
            severity=finding.severity,
            target_url=finding.page,
            title="Set the page title",
            before=f"<title>{escape(page.title)}</title>" if page and page.title else None,
            after=f"<title>{escape(suggested)}</title>",
            guidance=guidance_for(ctx.platform, "meta"),
        )
    )


def _description_fix(ctx: _Context, finding: Finding) -> None:
    page = ctx.pages_by_url.get(finding.page)
    suggested = (ctx.meta_by_url.get(finding.page) or {}).get("suggestedDescription")
    current = page.meta_description if page else None
    before = (
        f'<meta name="description" content="{_attr(current)}">' if current else None
    )
    if not suggested:
        ctx.add(
            Fix(
                code=finding.code,
                kind=MANUAL,
                severity=finding.severity,
                target_url=finding.page,
                title="Write a meta description",
                before=before,
                guidance=(
                    "Write 50–160 characters that describe this page and give "
                    "someone a reason to click. It does not affect ranking directly, "
                    "it affects how many people choose your result over the ones "
                    "around it.\n\n" + guidance_for(ctx.platform, "meta")
                ),
            )
        )
        return
    ctx.add(
        Fix(
            code=finding.code,
            kind=HEAD_TAG,
            severity=finding.severity,
            target_url=finding.page,
            title="Set the meta description",
            before=before,
            after=f'<meta name="description" content="{_attr(suggested)}">',
            guidance=guidance_for(ctx.platform, "meta"),
        )
    )


def _canonical_fix(ctx: _Context, finding: Finding) -> None:
    ctx.add(
        Fix(
            code=finding.code,
            kind=HEAD_TAG,
            severity=finding.severity,
            target_url=finding.page,
            title="Declare a canonical URL",
            after=f'<link rel="canonical" href="{_attr(finding.page)}">',
            guidance=(
                "This tells search engines which address is the real one when the "
                "same page is reachable several ways (with and without a trailing "
                "slash, with tracking parameters, http and https). Without it those "
                "variants compete with each other.\n\n"
                + guidance_for(ctx.platform, "meta")
            ),
        )
    )


def _og_fix(ctx: _Context, finding: Finding) -> None:
    page = ctx.pages_by_url.get(finding.page)
    suggestion = ctx.meta_by_url.get(finding.page) or {}
    title = suggestion.get("suggestedTitle") or (page.title if page else "") or ""
    description = (
        suggestion.get("suggestedDescription") or (page.meta_description if page else "") or ""
    )
    lines = [
        f'<meta property="og:title" content="{_attr(title)}">',
        f'<meta property="og:description" content="{_attr(description)}">',
        f'<meta property="og:url" content="{_attr(finding.page)}">',
        '<meta property="og:type" content="website">',
        '<meta name="twitter:card" content="summary_large_image">',
        "<!-- Add og:image with an absolute URL to a 1200x630 image: -->",
        '<!-- <meta property="og:image" content="https://example.com/share.jpg"> -->',
    ]
    ctx.add(
        Fix(
            code=finding.code,
            kind=HEAD_TAG,
            severity=finding.severity,
            target_url=finding.page,
            title="Add Open Graph tags",
            after="\n".join(lines),
            guidance=(
                "Controls how the page looks when it is shared on Facebook, "
                "LinkedIn, WhatsApp and Slack. Without these the platform guesses, "
                "and it usually guesses badly.\n\n"
                + guidance_for(ctx.platform, "meta")
            ),
        )
    )


def _jsonld_fix(ctx: _Context, finding: Finding, schema_json: str) -> None:
    ctx.add(
        Fix(
            code=finding.code,
            kind=HEAD_TAG,
            severity=finding.severity,
            target_url=finding.page,
            title="Add structured data (JSON-LD)",
            after=f'<script type="application/ld+json">\n{schema_json}\n</script>',
            guidance=(
                "Describes your business in the format search engines read "
                "directly. It is what qualifies a site for rich results, star "
                "ratings, opening hours, breadcrumbs. Check the values below are "
                "accurate before publishing; incorrect structured data can get rich "
                "results withdrawn.\n\n" + guidance_for(ctx.platform, "jsonld")
            ),
        )
    )


def _file_fix(
    ctx: _Context, finding: Finding, path: str, body: str, title: str, why: str
) -> None:
    ctx.add(
        Fix(
            code=finding.code,
            kind=FILE,
            severity=finding.severity,
            target_url=f"{_root(ctx.result.start_url)}/{path}",
            title=title,
            after=body,
            file_path=path,
            guidance=why + "\n\n" + guidance_for(ctx.platform, "root_file"),
        )
    )


def _root(url: str) -> str:
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def _alt_fix(ctx: _Context, finding: Finding) -> None:
    page = ctx.pages_by_url.get(finding.page)
    images = (page.images_without_alt if page else []) or []
    count = len(images) or (page.images_missing_alt if page else 0)
    listed = "\n".join(f"  - {src}" for src in images[:15])
    ctx.add(
        Fix(
            code=finding.code,
            kind=ATTRIBUTE,
            severity=finding.severity,
            target_url=finding.page,
            title=f"Describe {count} image(s)" if count else "Add image alt text",
            guidance=(
                "Alt text is read aloud by screen readers and is how images rank in "
                "image search. Describe what is in the picture, not what you want to "
                "rank for.\n\n"
                + (f"Images on this page with no alt text:\n{listed}\n\n" if listed else "")
                + guidance_for(ctx.platform, "img_alt")
            ),
        )
    )


MANUAL_GUIDANCE: dict[str, tuple[str, str]] = {
    "noindex": (
        "Remove the noindex directive",
        "This page explicitly tells search engines not to list it, so it cannot "
        "rank no matter what else is fixed. This is usually left over from a "
        "staging site. If the page should be public, remove the noindex robots "
        "meta tag or switch the equivalent setting in your CMS off.",
    ),
    "not_https": (
        "Serve the site over HTTPS",
        "Browsers mark HTTP pages as Not secure and search engines prefer HTTPS. "
        "Install a certificate (Let's Encrypt is free, and most hosts and CDNs "
        "issue one automatically) and redirect all HTTP traffic to HTTPS with a "
        "301.",
    ),
    "slow_response": (
        "Reduce server response time",
        "Aim for under 1.5 seconds to first byte. Enable page caching, put a CDN "
        "in front of the site, and check for slow database queries or an "
        "over-loaded shared host. Speed is both a ranking factor and the largest "
        "single cause of people leaving before the page appears.",
    ),
    "broken_link": (
        "Fix a broken link",
        "Visitors hitting this link get an error, and crawlers waste their budget "
        "on it. Point it at the correct address, or remove it. If the destination "
        "moved permanently, add a 301 redirect from the old address instead.",
    ),
    "duplicate_title": (
        "Give each page a unique title",
        "Pages sharing a title compete with each other for the same searches, and "
        "search engines have to guess which one to show. Write a distinct title "
        "for each, describing what is specifically on that page.",
    ),
    "multiple_h1": (
        "Use a single H1",
        "The H1 states what the page is about. Several of them dilute that "
        "signal. Keep the most accurate one and demote the rest to H2 or H3, "
        "this is a markup change, the text stays visible.",
    ),
    "thin_content": (
        "Expand this page",
        "There is too little on this page to answer anyone's question, so it is "
        "unlikely to rank for anything. Either expand it into something genuinely "
        "useful, or merge it into a stronger page and redirect. GODEYE can draft "
        "the expansion from your keyword clusters.",
    ),
}


def build_fixes(
    result: CrawlResult,
    findings: list[Finding],
    meta_suggestions: list[dict] | None,
    schema_json: str | None,
    sitemap_xml: str | None,
    robots_txt: str | None,
    indexnow_key: str | None = None,
) -> list[Fix]:
    """One actionable fix per finding, written for the detected stack.

    Findings we cannot hand over a patch for become MANUAL fixes rather than
    being dropped, the user still needs to know, and pretending we have a patch
    we don't would be worse than saying so.
    """
    ctx = _Context(
        result=result,
        pages_by_url={p.url: p for p in result.pages},
        meta_by_url={m["page"]: m for m in (meta_suggestions or []) if m.get("page")},
        platform=result.platform,
    )
    home = result.start_url

    for finding in findings:
        code = finding.code
        if code in ("missing_title", "title_too_long"):
            _title_fix(ctx, finding)
        elif code in ("missing_description", "description_too_short", "description_too_long"):
            _description_fix(ctx, finding)
        elif code == "missing_canonical":
            _canonical_fix(ctx, finding)
        elif code == "missing_og_tags":
            _og_fix(ctx, finding)
        elif code == "missing_structured_data":
            # Organization-level schema belongs on the home page; proposing it on
            # every crawled page would bury the findings that differ per page.
            if finding.page == home and schema_json:
                _jsonld_fix(ctx, finding, schema_json)
        elif code == "missing_robots" and robots_txt:
            _file_fix(
                ctx, finding, "robots.txt", robots_txt, "Publish robots.txt",
                "Tells crawlers which parts of the site to read and where the "
                "sitemap is. Without it crawlers guess, and some waste their time "
                "on checkout and admin pages instead of your products.",
            )
        elif code == "missing_sitemap" and sitemap_xml:
            _file_fix(
                ctx, finding, "sitemap.xml", sitemap_xml, "Publish sitemap.xml",
                "Lists every page you want indexed, so search engines find them "
                "without having to follow links. This matters most on sites whose "
                "navigation is rendered by JavaScript.",
            )
        elif code == "images_missing_alt":
            _alt_fix(ctx, finding)
        elif code in MANUAL_GUIDANCE:
            title, why = MANUAL_GUIDANCE[code]
            ctx.add(
                Fix(
                    code=code,
                    kind=MANUAL,
                    severity=finding.severity,
                    target_url=finding.page,
                    title=title,
                    guidance=f"{finding.message}\n\n{why}",
                )
            )

    if indexnow_key:
        ctx.add(
            Fix(
                code="indexnow_key",
                kind=FILE,
                severity="info",
                target_url=f"{_root(home)}/{indexnow_key}.txt",
                title="Publish the IndexNow key",
                after=indexnow_key,
                file_path=f"{indexnow_key}.txt",
                guidance=(
                    "IndexNow lets GODEYE tell Bing, Yandex, Seznam and Naver the "
                    "moment a page changes, instead of waiting weeks to be "
                    "re-crawled. Hosting this file at the site root is how those "
                    "engines confirm you control the domain. The file contains the "
                    "key and nothing else, no trailing newline required.\n\n"
                    "Google is deliberately not on that list: it operates no "
                    "general instant-indexing API, so for Google the sitemap "
                    "remains the route.\n\n"
                    + guidance_for(result.platform, "root_file")
                ),
            )
        )

    return ctx.fixes
