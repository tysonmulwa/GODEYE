"""Import a workspace's catalogue from its own website.

Two things this is careful about.

Consent is checked here, at the point the request would actually go out, not
only in the UI that asked for it. Reading someone's site is something they opt
into, and a task that can be queued from anywhere has to enforce that itself.

Re-importing updates rather than duplicating, and only touches rows whose
content actually changed. A shop republishing the same page must not look like
a catalogue of new arrivals, because what gets posted is chosen from that.
"""

from __future__ import annotations

import hashlib
import logging
from decimal import Decimal

from sqlalchemy import select, update

from ..celery_app import app
from ..db import BusinessProfile, MediaAsset, Product, get_session, new_id, utcnow
from ..products import sources

logger = logging.getLogger(__name__)

# Importing is a crawl of someone else's site: bounded, and far shorter than
# the generic ceiling so a slow shop cannot hold a worker for half an hour.
IMPORT_SOFT_LIMIT_SEC = 4 * 60
IMPORT_HARD_LIMIT_SEC = 5 * 60

NO_CONSENT = "no_consent"


def content_hash(product) -> str:
    """Fingerprint of the fields worth noticing a change in.

    Deliberately not the whole record: lastSeenAt moves on every import, and
    hashing it would mark every product as changed every time.
    """
    parts = [
        product.title,
        product.description or "",
        str(product.price if product.price is not None else ""),
        product.currency or "",
        product.image_url or "",
        product.availability or "",
    ]
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:32]


@app.task(
    name="godeye_engine.tasks.products.import_products",
    soft_time_limit=IMPORT_SOFT_LIMIT_SEC,
    time_limit=IMPORT_HARD_LIMIT_SEC,
)
def import_products(org_id: str, url: str | None = None, limit: int = 40) -> dict:
    """Read the workspace's shop and store what it is selling."""
    now = utcnow()

    with get_session() as session:
        profile = session.execute(
            select(
                BusinessProfile.c.website,
                BusinessProfile.c.productImportConsentAt,
            ).where(BusinessProfile.c.orgId == org_id)
        ).mappings().first()

    # Enforced here rather than trusted from the caller: this task can be
    # queued from anywhere, and the consent is the user's, not the caller's.
    if profile is None or profile["productImportConsentAt"] is None:
        logger.warning("Product import refused for %s: no consent recorded", org_id)
        return {
            "verdict": NO_CONSENT,
            "detail": (
                "This workspace has not agreed to GODEYE reading its website. "
                "Turn on product import in Settings first."
            ),
            "imported": 0,
        }

    target = url or profile["website"]
    if not target:
        return {
            "verdict": sources.NO_CATALOGUE,
            "detail": "No website is set for this workspace, so there is nothing to read.",
            "imported": 0,
        }

    result = sources.import_from_site(target, limit=limit)
    logger.info(
        "Product import for %s: %s via %s, %d product(s) from %d page(s)",
        org_id, result.verdict, result.route, len(result.products), result.pages_read,
    )

    if not result.ok:
        return {
            "verdict": result.verdict,
            "detail": result.detail,
            "imported": 0,
            "pagesRead": result.pages_read,
        }

    added, changed, unchanged = _store(org_id, result.products, now)

    with get_session() as session:
        session.execute(
            update(BusinessProfile)
            .where(BusinessProfile.c.orgId == org_id)
            .values(lastProductImportAt=now)
        )
        session.commit()

    return {
        "verdict": result.verdict,
        "route": result.route,
        "pagesRead": result.pages_read,
        "imported": len(result.products),
        "added": added,
        "changed": changed,
        "unchanged": unchanged,
    }


def attach_imported_photo(org_id: str, content_id: str, now) -> bool:
    """Use a photograph the shop already published, when none is generated.

    A workspace that imported its catalogue owns real pictures of the things it
    sells, and they cost nothing to reuse. Without one an autopilot post is
    bare text, which TikTok and Instagram refuse outright — so the choice is
    not between a good image and a plain post, it is between a post and none.

    Rotates on how often each product has been used, so a run of posts does not
    repeat the same photograph, and prefers what is actually in stock.
    """
    with get_session() as session:
        product = session.execute(
            select(Product.c.id, Product.c.imageUrl, Product.c.postCount)
            .where(
                Product.c.orgId == org_id,
                Product.c.imageUrl.isnot(None),
                # Showing something unbuyable is worse than showing nothing.
                (Product.c.availability.is_(None)) | (Product.c.availability != "OutOfStock"),
            )
            .order_by(Product.c.postCount.asc(), Product.c.lastSeenAt.desc())
            .limit(1)
        ).mappings().first()

        if product is None:
            return False

        session.execute(
            MediaAsset.insert().values(
                id=new_id(),
                orgId=org_id,
                contentItemId=content_id,
                kind="IMAGE",
                source="IMPORTED",
                # The shop hosts this picture, so there is no object of ours
                # behind it — but the column is NOT NULL, so it records where
                # the file actually lives rather than an empty string.
                storageKey=product["imageUrl"],
                url=product["imageUrl"],
                # Publishers fetch the bytes and read the real type from the
                # response; this is the honest default for a shop photograph.
                mimeType="image/jpeg",
                createdAt=now,
            )
        )
        # Counted as used, so the next post reaches for a different one. The
        # same column the product-post planner rotates on, deliberately: both
        # are drawing from one catalogue and should not fight over it.
        session.execute(
            update(Product)
            .where(Product.c.id == product["id"])
            .values(postCount=(product["postCount"] or 0) + 1, updatedAt=now)
        )
        session.commit()

    logger.info("Autopilot: attached an imported product photo to %s", content_id)
    return True


@app.task(name="godeye_engine.tasks.products.scheduled_imports")
def scheduled_imports() -> dict:
    """Re-read the shops that asked to be re-read.

    Queues one import per workspace rather than doing the work here: a slow
    shop would otherwise hold up every other workspace behind it.
    """
    with get_session() as session:
        rows = session.execute(
            select(BusinessProfile.c.orgId).where(
                BusinessProfile.c.productAutoImport.is_(True),
                # Belt and braces: the settings refuse this combination, and
                # the import would refuse it again. Cheaper not to queue it.
                BusinessProfile.c.productImportConsentAt.isnot(None),
            )
        ).all()

    for row in rows:
        import_products.delay(org_id=row.orgId)
    if rows:
        logger.info("Queued %d scheduled product import(s)", len(rows))
    return {"queued": len(rows)}


def _store(org_id: str, products: list, now) -> tuple[int, int, int]:
    """Upsert on (orgId, sourceUrl); report what actually moved."""
    added = changed = unchanged = 0

    with get_session() as session:
        existing = {
            row["sourceUrl"]: row
            for row in session.execute(
                select(
                    Product.c.id, Product.c.sourceUrl, Product.c.contentHash
                ).where(Product.c.orgId == org_id)
            ).mappings().all()
        }

        for product in products:
            digest = content_hash(product)
            current = existing.get(product.url)
            values = {
                "title": product.title[:500],
                "description": product.description,
                "price": Decimal(product.price) if product.price is not None else None,
                "currency": product.currency,
                "imageUrl": product.image_url,
                "availability": product.availability,
                "sku": product.sku,
                "source": product.source,
                "contentHash": digest,
                "lastSeenAt": now,
                "updatedAt": now,
            }

            if current is None:
                session.execute(
                    Product.insert().values(
                        id=new_id(),
                        orgId=org_id,
                        sourceUrl=product.url,
                        firstSeenAt=now,
                        postCount=0,
                        createdAt=now,
                        **values,
                    )
                )
                added += 1
            elif current["contentHash"] != digest:
                session.execute(
                    update(Product).where(Product.c.id == current["id"]).values(**values)
                )
                changed += 1
            else:
                # Still on sale, nothing new to say. Only the timestamp moves,
                # so a republished page does not read as a new arrival.
                session.execute(
                    update(Product)
                    .where(Product.c.id == current["id"])
                    .values(lastSeenAt=now)
                )
                unchanged += 1

        session.commit()

    return added, changed, unchanged
