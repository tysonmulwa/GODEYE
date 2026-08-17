/**
 * The plan catalogue, in one place.
 *
 * These numbers appear in three places that must agree: the database (seeded
 * from here), the public pricing page, and the limits the API enforces at
 * runtime. Kept apart, the marketing page eventually promises a number the
 * product refuses to honour — and a customer discovers it after paying.
 *
 * Prices are USD. GODEYE sells internationally and Paystack charges in the
 * currency of the plan, so a figure quoted in any other currency is one the
 * customer is never actually charged.
 */

export interface PlanLimits {
  postsPerMonth: number;
  aiTokensPerMonth: number;
  connections: number;
  seats: number;
}

export type PlanCode = "PRO" | "PREMIUM" | "VIP";

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  priceMonthlyUsd: number;
  /** One line on who the plan is for, shown on the public pricing page. */
  tagline: string;
  limits: PlanLimits;
}

/**
 * There is no free plan. Every workspace starts on a 24 hour Pro trial and then
 * has to pay, so the entry tier is Pro at 19 dollars carrying what used to be
 * the free allowance.
 *
 * The three tiers are the same three rows that were here before, renamed and
 * repriced rather than replaced: the old free allowance became Pro, the old Pro
 * became Premium, the old Scale became VIP. Limits are untouched. That matters
 * because Subscription rows point at a plan by id, so replacing the rows would
 * have orphaned every paying workspace.
 */
export const PLANS: PlanDefinition[] = [
  {
    code: "PRO",
    name: "Pro",
    priceMonthlyUsd: 19,
    tagline: "Everything working, for one business on its own channels.",
    limits: { postsPerMonth: 30, aiTokensPerMonth: 100_000, connections: 3, seats: 1 },
  },
  {
    code: "PREMIUM",
    name: "Premium",
    priceMonthlyUsd: 49,
    tagline: "For a business posting every day across its channels.",
    limits: { postsPerMonth: 500, aiTokensPerMonth: 2_000_000, connections: 15, seats: 5 },
  },
  {
    code: "VIP",
    name: "VIP",
    priceMonthlyUsd: 199,
    tagline: "For agencies and teams running several brands at once.",
    limits: { postsPerMonth: 5000, aiTokensPerMonth: 20_000_000, connections: 100, seats: 25 },
  },
];

/** Hours of full Pro access a brand new workspace gets before it must pay. */
export const TRIAL_HOURS = 24;

/**
 * Workspaces that are never billed and never lock: the ones GODEYE itself runs.
 *
 * Matched by slug rather than id so the list survives a reseed, and kept in
 * shared code so the API, the trial sweeper and the billing page all agree on
 * who is exempt. A workspace missing from here would lock its owner out of
 * their own product, which is exactly the sort of thing nobody notices until it
 * happens at the weekend.
 */
export const BILLING_EXEMPT_SLUGS = ["godeye", "patampoa", "mjini-collection"];

/**
 * Whether a workspace may still write, and why.
 *
 * Computed by the API and handed to the browser with the session, so the app
 * can say what is happening before the first refused request rather than after
 * it. The browser is told, never trusted: the API refuses the write itself.
 *
 * - TRIALING — inside the 24 hours, everything works, `trialEndsAt` is set.
 * - ACTIVE   — paying.
 * - EXEMPT   — one of BILLING_EXEMPT_SLUGS; never billed, never locked.
 * - LOCKED   — the trial ran out unpaid, or the subscription lapsed. Reading
 *              stays open; anything that changes data is refused.
 */
export type WorkspaceAccessStatus = "TRIALING" | "ACTIVE" | "EXEMPT" | "LOCKED";

export interface WorkspaceAccess {
  status: WorkspaceAccessStatus;
  /** True when writes are refused. Kept separate from `status` so the check at
   *  each call site is a boolean, not a list of statuses to remember. */
  locked: boolean;
  /** ISO timestamp the trial ends. Null unless a trial is running. */
  trialEndsAt: string | null;
  planCode: PlanCode | null;
}

export const PLAN_FEATURES: { key: keyof PlanLimits; label: string }[] = [
  { key: "postsPerMonth", label: "posts per month" },
  { key: "aiTokensPerMonth", label: "AI tokens per month" },
  { key: "connections", label: "connected channels" },
  { key: "seats", label: "team seats" },
];
