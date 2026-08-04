/**
 * The plan catalogue, in one place.
 *
 * These numbers appear in three places that must agree: the database (seeded
 * from here), the public pricing page, and the limits the API enforces at
 * runtime. Kept apart, the marketing page eventually promises a number the
 * product refuses to honour — and a customer discovers it after paying.
 *
 * Prices are USD. GODEYE sells internationally and Stripe charges in the
 * currency of the Price object, so a figure quoted in any other currency is
 * one the customer is never actually charged.
 */

export interface PlanLimits {
  postsPerMonth: number;
  aiTokensPerMonth: number;
  connections: number;
  seats: number;
}

export interface PlanDefinition {
  code: "FREE" | "PRO" | "SCALE";
  name: string;
  priceMonthlyUsd: number;
  /** One line on who the plan is for, shown on the public pricing page. */
  tagline: string;
  limits: PlanLimits;
}

export const PLANS: PlanDefinition[] = [
  {
    code: "FREE",
    name: "Free",
    priceMonthlyUsd: 0,
    tagline: "Enough to see whether it earns its place.",
    limits: { postsPerMonth: 30, aiTokensPerMonth: 100_000, connections: 3, seats: 1 },
  },
  {
    code: "PRO",
    name: "Pro",
    priceMonthlyUsd: 49,
    tagline: "For a business posting every day across its channels.",
    limits: { postsPerMonth: 500, aiTokensPerMonth: 2_000_000, connections: 15, seats: 5 },
  },
  {
    code: "SCALE",
    name: "Scale",
    priceMonthlyUsd: 199,
    tagline: "For agencies and teams running several brands at once.",
    limits: { postsPerMonth: 5000, aiTokensPerMonth: 20_000_000, connections: 100, seats: 25 },
  },
];

export const PLAN_FEATURES: { key: keyof PlanLimits; label: string }[] = [
  { key: "postsPerMonth", label: "posts per month" },
  { key: "aiTokensPerMonth", label: "AI tokens per month" },
  { key: "connections", label: "connected channels" },
  { key: "seats", label: "team seats" },
];
