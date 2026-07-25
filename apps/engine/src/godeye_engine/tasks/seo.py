"""SEO audit task: crawl → rules → generators → AI recommendations → store."""

from __future__ import annotations

import logging
import time
from urllib.parse import urlparse

from sqlalchemy import select, update

from ..ai import seo_agent
from ..celery_app import app
from ..db import AgentRun, BusinessProfile, SeoAudit, get_session, utcnow
from ..events import publish_event
from ..seo import audit as audit_rules
from ..seo import crawler, generators

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
                f"Could not crawl any pages from {url} — is the site reachable?"
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

        # 4. AI recommendations — optional; audit still succeeds without an LLM key
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

            weak_pages = [
                {
                    "url": p.url,
                    "title": p.title,
                    "meta_description": p.meta_description,
                    "h1s": p.h1s,
                }
                for p in result.pages
                if not p.title
                or not p.meta_description
                or len(p.title or "") > audit_rules.TITLE_MAX
            ]
            if weak_pages:
                _progress(agent_run_id, org_id, "meta", f"Rewriting {len(weak_pages[:10])} meta tag(s)")
                meta_suggestions, llm2 = seo_agent.meta_suggestions(weak_pages, profile_for_ai)
                llm_cost += llm2.cost_usd
        except Exception as e:  # noqa: BLE001 — AI extras are best-effort
            logger.info("AI SEO recommendations skipped: %s", e)

        # 5. Persist
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
                    completedAt=now,
                )
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
        logger.info("SEO audit %s: score %d, %d findings", audit_id, score, len(findings))
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
