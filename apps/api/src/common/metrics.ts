import { meter } from "./telemetry";

/**
 * The instruments `docs/ops/alerts.yaml` alerts on.
 *
 * Kept in one file on purpose: an alert that references a metric nobody emits
 * is a rule that silently never fires, which is worse than no alert at all —
 * it looks like coverage. Every counter here has a rule, and every rule in
 * alerts.yaml has a counter here.
 *
 * ## Naming
 *
 * Dots, not underscores. OpenTelemetry's Prometheus exporter converts
 * `godeye.ratelimit.store_failures` (a Counter) into
 * `godeye_ratelimit_store_failures_total`, which is the name the alert rules
 * use. Writing the Prometheus name here would produce
 * `godeye_ratelimit_store_failures_total_total`.
 */

/**
 * The rate limiter could not reach Redis and refused the request.
 *
 * Correct behaviour — a limiter that opens under load is missing exactly when
 * it is needed — and simultaneously a full outage, which is why it pages.
 */
export const rateLimitStoreFailures = meter.createCounter("godeye.ratelimit.store_failures", {
  description: "Requests refused because the rate-limit store was unreachable",
});

/**
 * 1 while an upstream circuit is open, 0 otherwise.
 *
 * An UpDownCounter rather than a Counter: the question is "is it open right
 * now", not "how many times has it opened".
 */
export const circuitOpen = meter.createUpDownCounter("godeye.circuit.open", {
  description: "1 while an upstream circuit breaker is open",
});

/**
 * A rotated refresh token was presented again (S-15).
 *
 * Either a client replayed an old value or somebody else holds a copy. Those
 * are indistinguishable from here and one of them is theft, so the whole family
 * has already been revoked by the time this increments.
 */
export const refreshTokenReuse = meter.createCounter("godeye.auth.refresh_reuse", {
  description: "Refresh tokens presented after they were rotated",
});

/**
 * Paystack transactions with no local `PaymentApplication` row.
 *
 * A gauge, because it is a state the daily reconciliation observes rather than
 * an event: the same missing payment is still missing tomorrow, and a counter
 * would make one problem look like thirty.
 */
export const reconciliationMissing = meter.createUpDownCounter(
  "godeye.payment.reconciliation_missing",
  { description: "Successful provider transactions with no local record" },
);

/** Sign-ins refused by the per-account or per-address backoff (NIST 800-63B). */
export const loginBackoffRefusals = meter.createCounter("godeye.auth.backoff_refusals", {
  description: "Sign-in attempts refused while inside a cool-off window",
});

/** URLs the API-side SSRF guard refused before anything was enqueued. */
export const egressBlocked = meter.createCounter("godeye.egress.blocked", {
  description: "Customer-supplied URLs refused at the API boundary",
});

/**
 * Requests refused by the CSRF guard (S-14).
 *
 * Labelled by `reason` and nothing else. `no-origin` climbing on its own is
 * almost always a client that stopped sending the header, or a misconfigured
 * `WEB_URL`; `foreign-origin` climbing is somebody trying it. Without the two
 * apart, both look like the same 403 and neither gets investigated.
 */
export const csrfBlocked = meter.createCounter("godeye.http.csrf_blocked", {
  description: "State-changing requests refused for missing or foreign Origin",
});

/**
 * Breached-password screening outcomes (NIST SP 800-63B §5.1.1.2).
 *
 * `unavailable` is the one to alert on. The check fails open by design, so an
 * HIBP outage is silent from the outside — registrations keep succeeding, and
 * the only evidence that the control stopped applying is this counter.
 */
export const breachedPasswordChecks = meter.createCounter("godeye.auth.breach_checks", {
  description: "Password screening results: ok, breached, or unavailable",
});
