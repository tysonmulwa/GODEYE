"""SEO audit task: crawl → rules → generators → AI recommendations → fixes → store.

The audit ends by writing SeoFix rows: one actionable, stack-aware change per
finding. That is the difference between a report and a loop, findings describe,
fixes get applied and then verified by ``verify_fixes``.
"""

from __future__ import annotations

import json
import logging
import time
from urllib.parse import urlparse

from sqlalchemy import insert, select, update

from ..ai import seo_agent
from ..celery_app import app
from ..db import (
    AgentRun,
    BusinessProfile,
    SeoAudit,
    SeoFix,
    get_session,
    new_id,
    utcnow,
)
from ..events import publish_event
from ..seo import audit as audit_rules
from ..seo import crawler, fixes as fix_builder, generators, indexnow

logger = logging.getLogger(__name__)


def _progress(agent_run_id: str, org_id: str, step: str, detail: str = "") -> None:
    with get_session() as session:
        session.execute(
            update(AgentRun)
            .where(AgentRun.c.id == agent_run_id)
            .values(output={"progress": step, "detail": detail})
        )
        session.commit()
    publish_event(org_id, {"type": "agent_run.progress", "agentRunId": agent_run_id, "step": step})


@app.task(name="godeye_engine.tasks.seo.run_site_audit", bind=True)
def run_site_audit(
    self,
    agent_run_id: str,
    org_id: str,
    audit_id: str,
    url: str,
    max_pages: int = 20,
) -> dict:
    started = time.monotonic()

    with get_session() as session:
        session.execute(
            update(AgentRun)
            .where(AgentRun.c.id == agent_run_id)
            .values(status="RUNNING", taskId=self.request.id)
        )
        session.execute(
            update(SeoAudit).where(SeoAudit.c.id == audit_id).values(status="RUNNING")
        )
        profile = session.execute(
            select(BusinessProfile).where(BusinessProfile.c.orgId == org_id)
        ).mappings().first()
        session.commit()

    profile_dict = dict(profile) if profile else {}
    # The business profile only describes the user's OWN site. When they audit a
    # different site, drop it so the AI analyses the crawled site on its own merits
    # instead of parroting their business.
    owned_website = profile_dict.get("website")
    is_own_site = bool(owned_website) and crawler.same_domain(url, owned_website)
    profile_for_ai = profile_dict if is_own_site else None

    try:
        # 1. Crawl
        _progress(agent_run_id, org_id, "crawl", f"Crawling {url}")
        result = crawler.crawl(
            url,
            max_pages=max_pages,
            progress=lambda n, u: _progress(
                agent_run_id, org_id, "crawl", f"Page {n}/{max_pages}: {u[:80]}"
            ),
        )
        if not result.pages:
            raise RuntimeError(
                f"Could not crawl any pages from {url}, is the site reachable?"
            )

        # 2. Rule-based audit + score
        _progress(agent_run_id, org_id, "audit", f"Auditing {len(result.pages)} page(s)")
        findings = audit_rules.audit_site(result)
        score = audit_rules.compute_score(findings, len(result.pages))

        # 3. Generators (always produced, deterministic)
        sitemap_xml = generators.generate_sitemap(result)
        robots_txt = generators.generate_robots(result.start_url)
        if is_own_site:
            schema_markup = seo_agent.build_schema_markup(profile_dict, result.start_url)
        else:
            home = result.pages[0]
            schema_markup = seo_agent.build_schema_markup(
                {
                    "businessName": home.title or urlparse(result.start_url).netloc,
                    "description": home.meta_description or "",
                },
                result.start_url,
            )

        # 4. AI recommendations, optional; audit still succeeds without an LLM key
        keywords = None
        meta_suggestions = None
        llm_cost = 0.0
        llm_meta: dict = {}
        try:
            _progress(agent_run_id, org_id, "keywords", "Researching keywords")
            site_summary = "\n".join(
                f"- {p.url}\n  title: {p.title or '(none)'} | desc: {p.meta_description or '(none)'}"
                f"\n  headings: {'; '.join(p.h1s[:6]) or '(none)'}"
                for p in result.pages[:15]
            )
            keywords, llm1 = seo_agent.keyword_research(
                result.start_url, site_summary, profile_for_ai
            )
            llm_cost += llm1.cost_usd
            llm_meta = {"provider": llm1.provider, "model": llm1.model}

            # Every page whose title or description the audit will flag, pages
            # with a too-short or too-long description need a rewrite just as
            # much as pages with none, and without one their fix can only be
            # advice rather than a patch.
            weak_pages = [
                {
                    "url": p.url,
                    "title": p.title,
                    "meta_description": p.meta_description,
                    "h1s": p.h1s,
                }
                for p in result.pages
                if not p.title
                or len(p.title) > audit_rules.TITLE_MAX
                or not p.meta_description
                or not (
                    audit_rules.DESCRIPTION_MIN
                    <= len(p.meta_description)
                    <= audit_rules.DESCRIPTION_MAX
                )
            ]
            if weak_pages:
                _progress(agent_run_id, org_id, "meta", f"Rewriting {len(weak_pages[:10])} meta tag(s)")
                meta_suggestions, llm2 = seo_agent.meta_suggestions(weak_pages, profile_for_ai)
                llm_cost += llm2.cost_usd
        except Exception as e:  # noqa: BLE001. AI extras are best-effort
            logger.info("AI SEO recommendations skipped: %s", e)

        # 5. Fixes, the actionable half. Findings say what is wrong; these say
        #    exactly what to change, written for the stack we detected.
        _progress(agent_run_id, org_id, "fixes", "Preparing fixes")
        built = fix_builder.build_fixes(
            result=result,
            findings=findings,
            meta_suggestions=meta_suggestions,
            schema_json=json.dumps(schema_markup, indent=2) if schema_markup else None,
            sitemap_xml=sitemap_xml,
            robots_txt=robots_txt,
            indexnow_key=indexnow.derive_key(org_id, result.start_url),
        )

        # 6. Persist
        now = utcnow()
        with get_session() as session:
            session.execute(
                update(SeoAudit)
                .where(SeoAudit.c.id == audit_id)
                .values(
                    status="SUCCEEDED",
                    score=score,
                    pagesCrawled=len(result.pages),
                    findings=audit_rules.findings_to_dicts(findings),
                    keywords=keywords,
                    metaSuggestions=meta_suggestions,
                    schemaMarkup=schema_markup,
                    sitemapXml=sitemap_xml,
                    robotsTxt=robots_txt,
                    platform=result.platform,
                    completedAt=now,
                )
            )
            if built:
                session.execute(
                    insert(SeoFix),
                    [
                        {
                            "id": new_id(),
                            "orgId": org_id,
                            "auditId": audit_id,
                            "findingCode": fix.code,
                            "kind": fix.kind,
                            "channel": "FIX_PACK",
                            "status": "PROPOSED",
                            "severity": fix.severity,
                            "targetUrl": fix.target_url,
                            "title": fix.title,
                            "before": fix.before,
                            "after": fix.after,
                            "filePath": fix.file_path,
                            "guidance": fix.guidance,
                            "attempts": 0,
                            "createdAt": now,
                            "updatedAt": now,
                        }
                        for fix in built
                    ],
                )
            session.execute(
                update(AgentRun)
                .where(AgentRun.c.id == agent_run_id)
                .values(
                    status="SUCCEEDED",
                    output={
                        "auditId": audit_id,
                        "score": score,
                        "pagesCrawled": len(result.pages),
                        "findings": len(findings),
                        "fixes": len(built),
                        "platform": result.platform,
                    },
                    provider=llm_meta.get("provider"),
                    model=llm_meta.get("model"),
                    costUsd=round(llm_cost, 6),
                    durationMs=int((time.monotonic() - started) * 1000),
                    completedAt=now,
                )
            )
            session.commit()

        publish_event(
            org_id,
            {
                "type": "agent_run.completed",
                "agentRunId": agent_run_id,
                "status": "SUCCEEDED",
                "auditId": audit_id,
            },
        )
        logger.info(
            "SEO audit %s: score %d, %d findings, %d fixes, platform=%s",
            audit_id, score, len(findings), len(built), result.platform,
        )
        return {"status": "SUCCEEDED", "auditId": audit_id, "score": score}

    except Exception as e:  # noqa: BLE001
        logger.exception("SEO audit failed for %s", audit_id)
        now = utcnow()
        with get_session() as session:
            session.execute(
                update(SeoAudit)
                .where(SeoAudit.c.id == audit_id)
                .values(status="FAILED", error=str(e)[:2000], completedAt=now)
            )
            session.execute(
                update(AgentRun)
                .where(AgentRun.c.id == agent_run_id)
                .values(status="FAILED", error=str(e)[:2000], completedAt=now)
            )
            session.commit()
        publish_event(
            org_id,
            {"type": "agent_run.completed", "agentRunId": agent_run_id, "status": "FAILED"},
        )
        return {"status": "FAILED", "error": str(e)}


# Codes audit_page() can decide on its own, by looking at one page. Anything else
# (duplicate titles across a site, broken links) needs a full crawl to judge, so
# verification leaves those alone rather than guessing.
PAGE_LEVEL_CODES = {
    "missing_title",
    "title_too_long",
    "missing_description",
    "description_too_long",
    "description_too_short",
    "missing_h1",
    "multiple_h1",
    "thin_content",
    "images_missing_alt",
    "not_https",
    "missing_canonical",
    "noindex",
    "missing_og_tags",
    "missing_structured_data",
}


def _verify_file_fix(fix) -> tuple[bool, str]:
    """A FILE fix is done when the file is actually served from the site root."""
    status, body = crawler.fetch_text(fix["targetUrl"])
    if status != 200:
        return False, f"Not reachable, {fix['targetUrl']} returned HTTP {status or 'no response'}"
    if not body.strip():
        return False, f"{fix['targetUrl']} is empty"
    if fix["findingCode"] == "indexnow_key" and body.strip() != (fix["after"] or "").strip():
        return False, "The key file is served but its contents do not match the key"
    if fix["findingCode"] == "missing_sitemap" and "<loc" not in body.lower():
        return False, "That URL responds, but it is not an XML sitemap"
    return True, ""


@app.task(name="godeye_engine.tasks.seo.verify_fixes", bind=True)
def verify_fixes(self, org_id: str, audit_id: str) -> dict:
    """Re-check applied fixes against the live site and record the verdict.

    Nothing is marked VERIFIED because we wrote it or because the user said they
    did, only because the site now says so. The same audit rule that raised the
    finding decides whether it is gone, so verification cannot drift from
    detection.
    """
    with get_session() as session:
        rows = session.execute(
            select(SeoFix).where(
                SeoFix.c.auditId == audit_id,
                SeoFix.c.orgId == org_id,
                SeoFix.c.status.in_(["APPLIED", "FAILED"]),
            )
        ).mappings().all()

    if not rows:
        return {"checked": 0, "verified": 0, "failed": 0, "skipped": 0}

    fixes = [dict(r) for r in rows]
    page_urls = sorted(
        {f["targetUrl"] for f in fixes if f["kind"] in ("HEAD_TAG", "ATTRIBUTE", "MANUAL")}
    )
    pages = crawler.fetch_pages(page_urls) if page_urls else {}

    verified: list[str] = []
    failed = 0
    skipped = 0
    now = utcnow()

    with get_session() as session:
        for fix in fixes:
            if fix["kind"] == "FILE":
                ok, reason = _verify_file_fix(fix)
            elif fix["findingCode"] not in PAGE_LEVEL_CODES:
                # Site-wide problems need a full re-audit to judge; leave the fix
                # as the user left it rather than inventing a verdict.
                skipped += 1
                continue
            else:
                page = pages.get(fix["targetUrl"])
                if page is None:
                    ok, reason = False, "Could not fetch the page to re-check it"
                else:
                    still_present = {
                        f.code for f in audit_rules.audit_page(page)
                    }
                    ok = fix["findingCode"] not in still_present
                    reason = "" if ok else "The site still reports this issue"

            session.execute(
                update(SeoFix)
                .where(SeoFix.c.id == fix["id"])
                .values(
                    status="VERIFIED" if ok else "FAILED",
                    verifiedAt=now if ok else None,
                    error=None if ok else reason[:2000],
                    attempts=(fix["attempts"] or 0) + 1,
                    updatedAt=now,
                )
            )
            if ok:
                verified.append(fix["targetUrl"])
            else:
                failed += 1
        session.commit()

    # Tell the engines that participate in IndexNow about the pages that changed.
    # Best-effort by design: a search engine being unreachable must not undo a
    # verification we just proved.
    submitted = 0
    if verified:
        with get_session() as session:
            audit = session.execute(
                select(SeoAudit.c.url).where(SeoAudit.c.id == audit_id)
            ).first()
        if audit:
            result = indexnow.submit(org_id, audit[0], sorted(set(verified)))
            submitted = result.get("submitted", 0)

    publish_event(
        org_id,
        {
            "type": "seo.fixes_verified",
            "auditId": audit_id,
            "verified": len(verified),
            "failed": failed,
        },
    )
    logger.info(
        "Verified fixes for audit %s: %d verified, %d failed, %d skipped, %d submitted",
        audit_id, len(verified), failed, skipped, submitted,
    )
    return {
        "checked": len(fixes),
        "verified": len(verified),
        "failed": failed,
        "skipped": skipped,
        "indexNowSubmitted": submitted,
    }
