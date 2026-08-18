import io

p = "apps/api/src/billing/billing.module.ts"
s = io.open(p, encoding="utf-8").read()

# ---------------------------------------------------------------- schema ----
old = 'const checkoutSchema = z.object({ planCode: z.enum(["PRO", "PREMIUM", "VIP"]) });'
if old in s:
    raise SystemExit("unexpected: schema already reverted to the old shape")

old = """const checkoutSchema = z.object({
  planCode: z.enum(["PRO", "PREMIUM", "VIP"]),
  mode: z.enum(["subscription", "once"]).default("subscription"),
});"""
new = """const checkoutSchema = z.object({
  planCode: z.enum(["PRO", "PREMIUM", "VIP"]),
  method: z.enum(["card", "apple_pay", "mpesa"]).default("card"),
});

export type PaymentMethod = z.infer<typeof checkoutSchema>["method"];

/**
 * A Paystack transaction reference, as it comes back on the return URL.
 *
 * Bounded and pattern checked because it is pasted straight into a URL path on
 * the way to Paystack.
 */
const verifySchema = z.object({ reference: z.string().min(4).max(120).regex(/^[\\w.-]+$/) });"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """/**
 * How a workspace is paying for the month.
 *
 * `subscription` is a Paystack plan: a card, charged again automatically every
 * month. `once` is a single transaction for one month, which is the only way
 * Apple Pay and M-Pesa can be used at all, Paystack can re-charge a card
 * authorisation and nothing else, so a wallet on a plan would take money once
 * and never renew.
 */"""
new = """/**
 * How the customer is paying.
 *
 * `card` is a Paystack plan: billed in dollars and charged again every month
 * without anyone doing anything. `apple_pay` and `mpesa` cannot be charged
 * again at all, because Paystack can only re-use a card authorisation, so each
 * one buys a single month.
 *
 * The method also fixes the currency. A transaction carries exactly one, and
 * M-Pesa settles only in shillings, so a card or Apple Pay pays the dollar
 * price while M-Pesa pays the shilling one.
 */"""
assert s.count(old) == 1
s = s.replace(old, new)

# -------------------------------------------------------------- checkout ----
start = s.index("  async checkout(orgId: string, userId: string, planCode: PlanCode) {")
end = s.index("\n  /**\n   * Paystack signs with HMAC SHA512")
new_checkout = '''  async checkout(
    orgId: string,
    userId: string,
    planCode: PlanCode,
    method: PaymentMethod = "card",
  ) {
    if (!env.paystack.secretKey) {
      throw new BadRequestException(
        "Payments are not configured on this server yet. Set PAYSTACK_SECRET_KEY.",
      );
    }
    if (!env.paystack.methods.includes(method)) {
      throw new BadRequestException(`${method} is not available on this server`);
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user?.email) {
      throw new BadRequestException("Your account has no email address to bill");
    }

    const subscribing = method === "card";
    const request = subscribing
      ? await this.subscriptionRequest(planCode)
      : this.oneOffRequest(planCode, method);

    const res = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.paystack.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: user.email,
        ...request,
        // Paystack appends its own reference to this, which is what lets the
        // page confirm the payment itself the moment the customer lands back.
        callback_url: `${env.webUrl.split(",")[0]}/billing?billing=success`,
        // The only link back to the workspace. The webhook arrives on its own,
        // with no session, so without this there is no way to know which
        // organisation just paid, or what it bought.
        metadata: {
          orgId,
          planCode,
          userId,
          method,
          mode: subscribing ? "subscription" : "once",
        },
      }),
    });
    const data = (await res.json()) as {
      status?: boolean;
      message?: string;
      data?: { authorization_url?: string; reference?: string };
    };
    if (!res.ok || !data.status || !data.data?.authorization_url) {
      this.logger.error(`Paystack checkout failed (${method}): ${data.message}`);
      throw new BadRequestException(data.message ?? "Could not start checkout");
    }

    this.audit.log({
      orgId,
      userId,
      action: "billing.checkout_started",
      metadata: { planCode, method, provider: "paystack" },
    });
    return { url: data.data.authorization_url, reference: data.data.reference ?? null };
  }

  /**
   * A card subscription: Paystack holds the plan and charges it again monthly.
   *
   * No `channels` list. Paystack already limits a plan transaction to what it
   * can re-charge, and naming channels here would only risk offering one it
   * cannot.
   */
  private async subscriptionRequest(planCode: PlanCode) {
    const plan = env.paystack.plans[planCode];
    if (!plan) {
      throw new BadRequestException(
        `No Paystack plan configured for ${planCode}. Create a recurring plan in ` +
          `the Paystack dashboard and set PAYSTACK_PLAN_${planCode} to its plan code.`,
      );
    }
    const { amount, currency } = await this.paystackPlan(planCode, plan);
    return {
      plan,
      amount,
      // Only when Paystack stated one. A plan priced in a currency the
      // merchant does not have enabled fails at checkout, and guessing a
      // default here would hide which of the two is actually wrong.
      ...(currency ? { currency } : {}),
    };
  }

  /**
   * One month, bought outright.
   *
   * This exists because Paystack can only re-charge a card. A customer paying
   * with M-Pesa or Apple Pay has no reusable authorisation, so there is nothing
   * to renew. Putting them on a plan would take their money once and then let
   * the workspace lock while they believed they were subscribed.
   *
   * One channel per checkout, so the sheet opens on the method they picked
   * instead of a list they have to choose from a second time.
   */
  private oneOffRequest(planCode: PlanCode, method: PaymentMethod) {
    const { amount, currency } = this.oneOffPrice(planCode, method);
    return {
      amount: amount * 100,
      currency,
      channels: [method === "mpesa" ? "mobile_money" : "apple_pay"],
    };
  }

  /**
   * What a single month costs, and in which currency.
   *
   * M-Pesa settles only in shillings, so it pays the shilling price. Everything
   * else pays the dollar price the rest of the product quotes. Both figures come
   * from the shared catalogue rather than a conversion done here: a rate applied
   * at checkout would show one number on the billing page and charge another at
   * the till, and the customer only finds out on their statement.
   */
  private oneOffPrice(planCode: string, method: PaymentMethod) {
    const plan = PLANS.find((p) => p.code === planCode);
    if (!plan) throw new BadRequestException(`Unknown plan ${planCode}`);
    return method === "mpesa"
      ? { amount: plan.priceMonthlyKes, currency: "KES" }
      : { amount: plan.priceMonthlyUsd, currency: "USD" };
  }

  /**
   * Ask Paystack whether a payment went through, and act on the answer.
   *
   * The webhook is the usual route, but it is a second server calling a third:
   * it can be unconfigured, blocked, retried late, or simply never set up. When
   * that happens the customer has paid, Paystack has told them so, and the
   * product still shows the old plan. This is the same activation triggered
   * from the browser that just came back from the checkout, so the common case
   * needs nothing but the customer's own return trip.
   */
  async verifyPayment(orgId: string, reference: string) {
    if (!env.paystack.secretKey) {
      throw new BadRequestException("Payments are not configured on this server yet");
    }
    const res = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${env.paystack.secretKey}` } },
    );
    const body = (await res.json()) as {
      status?: boolean;
      message?: string;
      data?: Record<string, unknown>;
    };
    if (!res.ok || !body.status || !body.data) {
      this.logger.warn(`Paystack could not verify ${reference}: ${body.message}`);
      throw new BadRequestException(body.message ?? "Could not check that payment");
    }

    const data = body.data;
    if (data.status !== "success") {
      return { applied: false, status: String(data.status ?? "unknown") };
    }

    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    // A reference is not a secret, so this endpoint must never activate a plan
    // for a workspace other than the one the payment was made for.
    if (metadata.orgId !== orgId) {
      this.logger.warn(
        `Org ${orgId} tried to claim payment ${reference}, which belongs to ${String(metadata.orgId)}`,
      );
      throw new BadRequestException("That payment belongs to another workspace");
    }

    const applied = await this.applyPayment(data);
    return { applied, status: "success" };
  }

  /**
   * Turn a successful Paystack payment into access, exactly once.
   *
   * Reached from two directions, the webhook and the customer's return trip,
   * which race each other by design so that neither is a single point of
   * failure. The reference is recorded as an audit row and checked first,
   * because a one-off payment adds a month to the clock and doing that twice
   * for one payment gives away a month.
   */
  private async applyPayment(data: Record<string, unknown>): Promise<boolean> {
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    const orgId = typeof metadata.orgId === "string" ? metadata.orgId : null;
    const planCode = typeof metadata.planCode === "string" ? metadata.planCode : null;
    const reference = typeof data.reference === "string" ? data.reference : null;

    if (!orgId || !planCode) {
      // Loud, because the money has already moved. A payment that cannot be
      // matched to a workspace is a customer who paid and got nothing.
      this.logger.error(
        `Paystack payment carried no orgId/planCode metadata, so no plan can be ` +
          `activated. Reference: ${reference ?? "unknown"}`,
      );
      return false;
    }

    if (reference) {
      const alreadyDone = await this.prisma.auditLog.findFirst({
        where: { action: PAYMENT_APPLIED, targetId: reference },
        select: { id: true },
      });
      if (alreadyDone) return false;
    }

    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan) {
      this.logger.error(`Paystack payment names plan ${planCode}, which does not exist`);
      return false;
    }

    const customer = (data.customer ?? {}) as Record<string, unknown>;
    const once = metadata.mode === "once";
    const existing = await this.prisma.subscription.findUnique({
      where: { orgId },
      select: { currentPeriodEnd: true },
    });

    // A one-off buys a month from where the current one ends, not from now:
    // somebody who pays a week early has bought a month, not lost a week.
    // A subscription takes Paystack's own next charge date instead.
    const paidUntil = once
      ? new Date(
          Math.max(Date.now(), existing?.currentPeriodEnd?.getTime() ?? 0) +
            ONE_MONTH_DAYS * 24 * 3600 * 1000,
        )
      : this.parseDate(data.next_payment_date);

    const fields = {
      planId: plan.id,
      status: "ACTIVE" as const,
      providerCustomerId: (customer.customer_code as string) ?? null,
      // Deliberately left null for a one-off. Nothing renews it, and that
      // absence is what tells the read-only guard this month has a hard end
      // rather than a card behind it.
      providerSubscriptionId: once ? null : ((data.subscription_code as string) ?? null),
      // Only overwritten when there is a date to write. Clearing it on a plain
      // charge.success would erase the renewal date that the subscription
      // event had already recorded.
      ...(paidUntil ? { currentPeriodEnd: paidUntil } : {}),
    };

    await this.prisma.subscription.upsert({
      where: { orgId },
      create: { orgId, ...fields },
      update: fields,
    });

    // Written before anything else can race it, and awaited, because this row
    // is what stops the same payment being credited twice.
    if (reference) {
      await this.prisma.auditLog
        .create({
          data: {
            orgId,
            action: PAYMENT_APPLIED,
            targetType: "PaystackTransaction",
            targetId: reference,
            metadata: {
              planCode,
              mode: once ? "once" : "subscription",
              method: typeof metadata.method === "string" ? metadata.method : null,
              paidUntil: paidUntil?.toISOString() ?? null,
            } as never,
          },
        })
        .catch(() => undefined);
    }

    // The workspace is paying as of this instant, so it must not wait out a
    // cached read-only decision before it can publish again.
    this.access.invalidate(orgId);
    this.logger.log(
      `Activated ${planCode} for org ${orgId}` +
        (once ? ` until ${paidUntil?.toISOString()} (one month)` : " (subscription)"),
    );
    return true;
  }
'''
s = s[:start] + new_checkout + s[end:]

# --------------------------------------------------------------- webhook ----
start = s.index("  async handlePaystackEvent(event: {")
end = s.index("  /** Paystack sends dates as")
new_webhook = '''  async handlePaystackEvent(event: {
    event?: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    const data = event.data ?? {};

    if (event.event === "charge.success" || event.event === "subscription.create") {
      await this.applyPayment(data);
      return;
    }

    if (event.event === "subscription.disable" || event.event === "subscription.not_renew") {
      const code = data.subscription_code as string | undefined;
      if (!code) return;
      const sub = await this.prisma.subscription.findFirst({
        where: { providerSubscriptionId: code },
      });
      if (sub) {
        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: { status: "CANCELED" },
        });
        this.access.invalidate(sub.orgId);
        this.audit.log({ orgId: sub.orgId, action: "billing.subscription_canceled" });
        this.logger.log(`Paystack cancelled the subscription for org ${sub.orgId}`);
      }
    }
  }

'''
s = s[:start] + new_webhook + s[end:]

# ------------------------------------------------------------- constants ----
old = "/** Days a single payment buys. A month, erring on the customer's side. */\nconst ONE_MONTH_DAYS = 31;"
new = """/** Days a single payment buys. A month, erring on the customer's side. */
const ONE_MONTH_DAYS = 31;

/**
 * The audit action that records a payment as spent.
 *
 * Its targetId is the Paystack reference, which is what makes activation safe
 * to attempt from both the webhook and the browser without paying a customer's
 * month out twice.
 */
const PAYMENT_APPLIED = "billing.payment_applied";"""
assert s.count(old) == 1
s = s.replace(old, new)

# ------------------------------------------------------------- overview -----
old = """      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        priceMonthlyUsd: p.priceMonthlyUsd.toString(),
        limits: this.limitsOf(p),
      })),"""
new = """      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        priceMonthlyUsd: p.priceMonthlyUsd.toString(),
        // What one month costs on M-Pesa, the only method quoted in shillings.
        // The page shows it once somebody picks M-Pesa and not before, so
        // nobody is asked to compare two currencies to read a price.
        priceMpesaKes: this.oneOffPrice(p.code, "mpesa").amount,
        limits: this.limitsOf(p),
      })),
      /** Ways to pay this server offers, in the order the picker shows them. */
      methods: env.paystack.methods,"""
assert s.count(old) == 1
s = s.replace(old, new)

# ------------------------------------------------------------ controller ----
old = """  @Post("checkout")
  @MinRole("ADMIN")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Start a Paystack checkout for a paid plan" })
  checkout(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ) {
    return this.billing.checkout(auth.orgId, auth.sub, body.planCode);
  }"""
new = """  @Post("checkout")
  @MinRole("ADMIN")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Start a Paystack checkout. A card subscribes and renews monthly in USD, " +
      "Apple Pay buys one month in USD, M-Pesa buys one month in KES.",
  })
  checkout(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ) {
    return this.billing.checkout(auth.orgId, auth.sub, body.planCode, body.method);
  }

  @Post("verify")
  @MinRole("ADMIN")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Confirm a payment straight with Paystack and activate the plan. Lets the " +
      "customer's own return trip do what the webhook would, so a plan is live " +
      "the moment they are back rather than whenever the webhook arrives.",
  })
  verify(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(verifySchema)) body: z.infer<typeof verifySchema>,
  ) {
    return this.billing.verifyPayment(auth.orgId, body.reference);
  }"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
