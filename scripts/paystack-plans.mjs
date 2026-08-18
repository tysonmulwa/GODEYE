/**
 * Create the three Paystack plans, and print the codes to paste into Railway.
 *
 * Doing this by hand in the dashboard is where the mode trap lives: plan codes
 * belong to whichever side of the Test/Live switch was showing when the plan
 * was made, and a plan built in test mode is simply "not found" to a live key.
 * This script cannot make that mistake — it reads the mode off the key it was
 * given and creates the plans in that same mode, because that is the only mode
 * that key can see.
 *
 * It also takes the prices from @godeye/shared, the same catalogue that seeds
 * the database and renders the pricing page, so the plan Paystack charges and
 * the plan the product promises cannot drift apart.
 *
 * Nothing is stored. The key is read from the environment, used, and forgotten.
 *
 *   PAYSTACK_SECRET_KEY=sk_live_... node scripts/paystack-plans.mjs
 *
 * Existing plans are reused rather than duplicated: run it twice and the second
 * run prints the same three codes.
 *
 * Currency: defaults to USD, which is what the catalogue quotes. Paystack only
 * accepts currencies your account has enabled, and a price in another currency
 * is NOT the dollar figure with a different symbol — 19 KES is not 19 USD. So
 * any other currency has to state its own amounts, in major units:
 *
 *   node scripts/paystack-plans.mjs --currency KES --pro 2500 --premium 6400 --vip 26000
 */
// The catalogue ships as built output, which a fresh clone has not produced
// yet. Imported dynamically so that case is a sentence rather than a stack
// trace about a missing module.
let PLANS;
try {
  ({ PLANS } = await import("../packages/shared/dist/index.js"));
} catch {
  console.error(
    "The shared plan catalogue is not built yet. Run this first:",
  );
  console.error("  pnpm --filter @godeye/shared build");
  process.exit(1);
}

const secretKey = (process.env.PAYSTACK_SECRET_KEY ?? "").trim();
if (!secretKey) {
  console.error(
    "PAYSTACK_SECRET_KEY is not set.\n\n" +
      "  PAYSTACK_SECRET_KEY=sk_live_xxx node scripts/paystack-plans.mjs\n\n" +
      "Use the same key the API runs with — plans are only visible to keys of\n" +
      "the mode they were created in.",
  );
  process.exit(1);
}

const mode = secretKey.startsWith("sk_live_")
  ? "live"
  : secretKey.startsWith("sk_test_")
    ? "test"
    : "unknown";
if (mode === "unknown") {
  console.error(
    `That key does not start with sk_live_ or sk_test_, so it is not a Paystack\n` +
      `secret key. The public key (pk_...) cannot create plans.`,
  );
  process.exit(1);
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const currency = (flag("currency") ?? "USD").toUpperCase();

/**
 * Amount in the currency's subunit, which is what Paystack bills in.
 *
 * Throws rather than exiting: by the time this runs there are open sockets,
 * and process.exit() with those in flight aborts the Node process on Windows
 * with a libuv assertion instead of printing the reason.
 */
function amountFor(plan) {
  if (currency === "USD") return plan.priceMonthlyUsd * 100;
  const override = flag(plan.code.toLowerCase());
  if (override === undefined) {
    throw new Error(
      `--currency ${currency} needs an explicit price per tier, in ${currency}:\n\n` +
        `  node scripts/paystack-plans.mjs --currency ${currency} --pro N --premium N --vip N\n\n` +
        `The catalogue quotes USD, and converting it here would invent a price\n` +
        `nobody agreed to — a customer would be charged ${plan.priceMonthlyUsd} ${currency}.`,
    );
  }
  const major = Number(override);
  if (!Number.isFinite(major) || major <= 0) {
    throw new Error(`--${plan.code.toLowerCase()} must be a number greater than zero`);
  }
  return Math.round(major * 100);
}

async function paystack(path, init) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) {
    throw new Error(body.message ?? `Paystack returned ${res.status}`);
  }
  return body.data;
}

const planName = (plan) => `GODEYE ${plan.name}`;

async function main() {
  console.log(`Paystack key is ${mode} mode — plans will be created in ${mode} mode.\n`);

  // One listing, so a re-run reuses what is already there instead of leaving a
  // dashboard full of near-identical plans nobody can tell apart.
  const existing = await paystack("/plan?perPage=100");
  const byName = new Map(existing.map((p) => [p.name, p]));

  const codes = [];
  for (const plan of PLANS) {
    const name = planName(plan);
    const amount = amountFor(plan);
    const found = byName.get(name);

    if (found) {
      const same = found.amount === amount && found.currency === currency;
      console.log(
        `${plan.code.padEnd(8)} exists  ${found.plan_code}  ` +
          `${(found.amount / 100).toFixed(2)} ${found.currency} / ${found.interval}` +
          (same ? "" : `  <-- differs from ${(amount / 100).toFixed(2)} ${currency}`),
      );
      if (!same) {
        console.log(
          `         ^ left alone. Changing a live plan's price changes what existing\n` +
            `           subscribers are charged, so that is a decision for the dashboard.`,
        );
      }
      codes.push([plan.code, found.plan_code]);
      continue;
    }

    const created = await paystack("/plan", {
      method: "POST",
      body: JSON.stringify({
        name,
        amount,
        currency,
        interval: "monthly",
        description: plan.tagline,
      }),
    });
    console.log(
      `${plan.code.padEnd(8)} created ${created.plan_code}  ` +
        `${(created.amount / 100).toFixed(2)} ${created.currency} / ${created.interval}`,
    );
    codes.push([plan.code, created.plan_code]);
  }

  console.log(`\nSet these on the Railway API service (${mode} mode), then redeploy:\n`);
  for (const [tier, code] of codes) console.log(`PAYSTACK_PLAN_${tier}=${code}`);
  console.log(
    `\nThe API checks all three at boot. Look for "Paystack plan PRO: ..." in the\n` +
      `deploy log — a rejection there names the variable that is still wrong.`,
  );
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  if (/currency/i.test(e.message)) {
    console.error(
      `\nPaystack only accepts currencies your account has enabled. Check\n` +
        `Settings -> Preferences in the dashboard, and pass --currency with one\n` +
        `it supports, along with that currency's own prices.`,
    );
  }
  // exitCode rather than exit(): keep-alive sockets from fetch are still open
  // here, and exiting on top of them aborts Node on Windows with a libuv
  // assertion that buries the message just printed.
  process.exitCode = 1;
});
