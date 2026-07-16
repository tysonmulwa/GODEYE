"""SEO audit rules — turn crawl data into findings and a 0-100 score."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass

from .crawler import CrawlResult, PageData

TITLE_MAX = 60
DESCRIPTION_MIN = 50
DESCRIPTION_MAX = 160
THIN_CONTENT_WORDS = 300
SLOW_RESPONSE_MS = 1500

SEVERITY_WEIGHTS = {"critical": 8, "warning": 3, "info": 1}
MAX_PENALTY_PER_CODE = 24  # one systemic problem shouldn't zero the score


@dataclass
class Finding:
    severity: str  # critical | warning | info
    code: str
    page: str
    message: str
    recommendation: str


def audit_page(page: PageData) -> list[Finding]:
    findings: list[Finding] = []
    url = page.url

    def add(severity: str, code: str, message: str, recommendation: str) -> None:
        findings.append(Finding(severity, code, url, message, recommendation))

    # --- title ---
    if not page.title:
        add("critical", "missing_title", "Page has no <title> tag",
            "Add a unique, descriptive title under 60 characters containing the primary keyword.")
    elif len(page.title) > TITLE_MAX:
        add("warning", "title_too_long",
            f"Title is {len(page.title)} characters (max ~{TITLE_MAX})",
            "Shorten the title so it doesn't get truncated in search results.")

    # --- meta description ---
    if not page.meta_description:
        add("warning", "missing_description", "Page has no meta description",
            "Add a compelling 50-160 character meta description — it drives click-through rate.")
    elif len(page.meta_description) > DESCRIPTION_MAX:
        add("info", "description_too_long",
            f"Meta description is {len(page.meta_description)} characters (max ~{DESCRIPTION_MAX})",
            "Trim the description to avoid truncation.")
    elif len(page.meta_description) < DESCRIPTION_MIN:
        add("info", "description_too_short",
            f"Meta description is only {len(page.meta_description)} characters",
            "Expand the description to 50-160 characters to better sell the click.")

    # --- headings ---
    if not page.h1s:
        add("warning", "missing_h1", "Page has no H1 heading",
            "Add exactly one H1 that states the page's main topic.")
    elif len(page.h1s) > 1:
        add("info", "multiple_h1", f"Page has {len(page.h1s)} H1 headings",
            "Use a single H1; demote the others to H2/H3.")

    # --- content ---
    if page.word_count < THIN_CONTENT_WORDS:
        add("warning", "thin_content",
            f"Only ~{page.word_count} words of content",
            f"Search engines favor substantive pages; aim for {THIN_CONTENT_WORDS}+ words of useful content.")

    # --- images ---
    if page.images_missing_alt > 0:
        add("warning", "images_missing_alt",
            f"{page.images_missing_alt} of {page.images_total} images missing alt text",
            "Add descriptive alt text — it's an accessibility and image-SEO win.")

    # --- technical ---
    if not page.is_https:
        add("critical", "not_https", "Page served over HTTP",
            "Serve all pages over HTTPS; HTTP pages are penalized and flagged as insecure.")
    if not page.canonical:
        add("info", "missing_canonical", "No canonical URL declared",
            "Add <link rel=\"canonical\"> to prevent duplicate-content dilution.")
    if page.meta_robots and "noindex" in page.meta_robots.lower():
        add("critical", "noindex", "Page is set to noindex",
            "Remove the noindex directive if this page should appear in search results.")
    if page.response_time_ms > SLOW_RESPONSE_MS:
        add("warning", "slow_response",
            f"Server responded in {page.response_time_ms} ms",
            "Aim for <1.5s server response: enable caching/CDN, optimize the backend.")

    # --- social / structured data ---
    if not page.has_og_tags:
        add("info", "missing_og_tags", "No Open Graph tags",
            "Add og:title / og:description / og:image so shares look right on social platforms.")
    if not page.has_json_ld:
        add("info", "missing_structured_data", "No JSON-LD structured data",
            "Add schema.org markup (Organization, Product, Article…) to qualify for rich results.")

    return findings


def audit_site(result: CrawlResult) -> list[Finding]:
    findings: list[Finding] = []
    for page in result.pages:
        findings.extend(audit_page(page))

    # duplicate titles across the site
    title_counts = Counter(p.title for p in result.pages if p.title)
    for title, count in title_counts.items():
        if count > 1:
            offenders = [p.url for p in result.pages if p.title == title]
            findings.append(
                Finding(
                    "warning", "duplicate_title", offenders[0],
                    f'{count} pages share the title "{title[:60]}"',
                    "Give every page a unique title; duplicates split ranking signals.",
                )
            )

    # broken internal links
    for broken_url, sources in result.broken_links.items():
        findings.append(
            Finding(
                "critical", "broken_link", sources[0] if sources else broken_url,
                f"Broken link to {broken_url}",
                "Fix or remove the link; broken links waste crawl budget and hurt UX.",
            )
        )

    # site-level files
    if not result.has_robots_txt:
        findings.append(
            Finding("warning", "missing_robots", result.start_url,
                    "No robots.txt found",
                    "Publish a robots.txt (GODEYE generated one for you in this audit).")
        )
    if not result.has_sitemap_xml:
        findings.append(
            Finding("warning", "missing_sitemap", result.start_url,
                    "No sitemap.xml found",
                    "Publish a sitemap.xml (GODEYE generated one for you in this audit).")
        )
    return findings


def compute_score(findings: list[Finding], pages_crawled: int) -> int:
    """0-100: start perfect, subtract capped penalties per issue type."""
    if pages_crawled == 0:
        return 0
    penalty_by_code: dict[str, int] = {}
    for finding in findings:
        weight = SEVERITY_WEIGHTS.get(finding.severity, 1)
        penalty_by_code[finding.code] = min(
            penalty_by_code.get(finding.code, 0) + weight, MAX_PENALTY_PER_CODE
        )
    return max(0, 100 - sum(penalty_by_code.values()))


def findings_to_dicts(findings: list[Finding]) -> list[dict]:
    return [asdict(f) for f in findings]
