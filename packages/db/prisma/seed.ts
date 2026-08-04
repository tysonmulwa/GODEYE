import { PrismaClient } from "../generated/client";
import * as argon2 from "argon2";
import { PLANS } from "@godeye/shared";

const prisma = new PrismaClient();

async function main() {
  // Plans. Defined in @godeye/shared so the database, the public pricing page
  // and the limits the API enforces cannot drift apart — a marketing page
  // promising a number the product refuses is discovered only after payment.
  for (const p of PLANS) {
    await prisma.plan.upsert({
      where: { code: p.code },
      // Spread deliberately avoided: the catalogue also carries a tagline for
      // the pricing page, which is not a column here.
      update: { name: p.name, priceMonthlyUsd: p.priceMonthlyUsd, limits: p.limits },
      create: {
        code: p.code,
        name: p.name,
        priceMonthlyUsd: p.priceMonthlyUsd,
        limits: p.limits,
      },
    });
  }

  // Demo user + org
  const passwordHash = await argon2.hash("godeye-demo-123", { type: argon2.argon2id });
  const user = await prisma.user.upsert({
    where: { email: "demo@godeye.app" },
    update: {},
    create: {
      email: "demo@godeye.app",
      passwordHash,
      name: "Demo User",
      emailVerifiedAt: new Date(),
    },
  });

  const org = await prisma.organization.upsert({
    where: { slug: "demo-org" },
    update: {},
    create: {
      name: "Demo Org",
      slug: "demo-org",
      memberships: { create: { userId: user.id, role: "OWNER" } },
      businessProfile: {
        create: {
          businessName: "Acme Coffee Roasters",
          industry: "Food & Beverage",
          description:
            "Specialty coffee roastery selling single-origin beans online and in-store.",
          targetAudience: "Coffee enthusiasts aged 25-45 who value quality and sustainability.",
          location: "Nairobi, Kenya",
          website: "https://example.com",
          products: ["Single-origin beans", "Cold brew kits", "Subscriptions"],
          goals: ["Grow Instagram following", "Increase online sales", "Build brand awareness"],
          brandVoice: "Warm, knowledgeable, a little playful — never corporate.",
          competitors: ["Java House", "Artcaffe"],
        },
      },
    },
  });

  const freePlan = await prisma.plan.findUniqueOrThrow({ where: { code: "FREE" } });
  await prisma.subscription.upsert({
    where: { orgId: org.id },
    update: {},
    create: { orgId: org.id, planId: freePlan.id, status: "ACTIVE" },
  });

  console.log(`Seeded: demo@godeye.app / godeye-demo-123 (org: ${org.slug})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
