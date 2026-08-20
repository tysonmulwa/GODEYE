# Service level objectives

**Rubric row 4.** Alert rules: [`alerts.yaml`](./alerts.yaml).
Metrics: `godeye_*` from the engine, `http.server.*` from the API.

---

## The rule these are written under

**Page a human only for a burning error budget, never for a threshold crossing.**

A CPU alert, a "5xx count > 10" alert and a disk alert all share the same
failure: they fire when a number moves, not when a customer is affected. What
follows is three months of ignored pages and then a real one that gets ignored
too.

Every alert below is either a **burn-rate** alert on an SLO, or a symptom a
customer would describe in a support ticket.

## SLIs and objectives

| # | What a customer would say | SLI | Objective | Window |
|---|---|---|---|---|
| 1 | "The app is down" | Requests answered without a 5xx | **99.9%** | 30 days |
| 2 | "The app is slow" | Reads under 400ms | **99%** | 30 days |
| 3 | "Scheduling is slow" | Schedule admissions under 800ms | **99%** | 30 days |
| 4 | **"My post didn't go out"** | Posts published within 5 minutes of their scheduled time | **99%** | 30 days |
| 5 | "My channel silently stopped working" | Connections in ACTIVE or EXPIRING_SOON, not EXPIRED/REVOKED | **99.5%** | 30 days |
| 6 | "I paid and nothing happened" | Payments with a `PaymentApplication` row within 10 minutes | **99.9%** | 30 days |

**SLO 4 is the product.** GODEYE's promise is unattended publishing; a post that
goes out an hour late is a failure even though every request succeeded. It is
also the one the audit's B-7 was violating continuously and invisibly, because
nothing measured it.

**SLO 5 exists because of B-7 specifically.** `expiresAt` was written in four
places and read in none, so every TikTok connection died a day after it was made
while the UI still said ACTIVE. The objective is what makes that condition
observable rather than reportable-by-customer.

### Error budgets

| SLO | Budget over 30 days |
|---|---|
| 99.9% availability | 43 minutes |
| 99% read latency | 7.2 hours of requests over 400ms |
| 99% publish timeliness | ~7 posts late per 1,000 |
| 99.9% payment application | ~1 payment per 1,000 |

## Burn-rate alerting

Multi-window, multi-burn-rate, per Google's SRE workbook. Two windows so a
short spike does not page and a slow bleed is not missed.

| Severity | Burn rate | Long window | Short window | Budget consumed | Action |
|---|---|---|---|---|---|
| **Page** | 14.4× | 1h | 5m | 2% in an hour | Wake somebody |
| **Page** | 6× | 6h | 30m | 5% in six hours | Wake somebody |
| **Ticket** | 3× | 1d | 2h | 10% in a day | Next working day |
| **Ticket** | 1× | 3d | 6h | 10% in three days | Next working day |

The two-window requirement is what removes the flapping: the long window says
"this has been true long enough to matter", the short one says "it is still true
now", and an alert needs both.

## Symptom alerts

These are not burn rates. They are conditions that mean a customer is already
affected and no budget calculation is needed.

| Alert | Condition | Why it pages |
|---|---|---|
| **PublishBacklogGrowing** | `godeye_publish_lateness_seconds > 900` for 10m | Posts are more than 15 minutes late. The customer-visible symptom of SLO 4 |
| **DispatcherStopped** | `rate(godeye_publish_total[15m]) == 0` **and** `godeye_due_posts_backlog > 0` | Posts are due and nothing is publishing. This is the failure that is silent by construction |
| **TokenRefreshFailing** | `sum(rate(godeye_connection_refresh_total{outcome="failed"}[1h])) / sum(rate(godeye_connection_refresh_total[1h])) > 0.25` | An app credential rotated or an app was suspended — one problem affecting everybody, not many unlucky users |
| **RateLimitStoreDown** | any `503` with `code="RATE_LIMIT_STORE"` | The limiter is failing closed, which is correct and is also a full outage |
| **PaymentReconciliationDiverged** | reconciliation reports any missing transaction | Somebody paid and did not get what they paid for |
| **EgressBlockedSpike** | `rate(godeye_egress_blocked_total[15m]) > 1` | Either an attack, or a legitimate customer URL the guard is wrong about. Both need a look |
| **CircuitOpen** | `circuit open` logged for one upstream > 5m | A dependency is down and we are failing fast — correct, and worth knowing |

`DispatcherStopped` is the most valuable alert in the list. Every other failure
mode here produces errors somewhere; a dispatcher that stops produces **nothing
at all**, and the first signal without this alert is a customer asking why their
week of posts never went out.

## What is deliberately NOT alerted

- **CPU, memory, disk.** Causes, not symptoms. They belong on a dashboard.
- **4xx rate.** The API refusing invalid input is the API working. Alerting on it
  is how a team ends up loosening validation to make a graph green.
- **429 rate as a page.** A ticket at most. Sustained 429s mean the limiter is the
  ceiling, which is a capacity conversation, not an outage.
- **Individual task failures.** One publish failing is normal — platforms have bad
  minutes. The *rate* is in SLO 4.

## 🔴 Status: defined, not deployed

Every objective and alert above is written down and none of it is running.

- `alerts.yaml` is valid Prometheus rule syntax and has never been loaded.
- No dashboard exists.
- `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so nothing is exported at all.

To close it, in order:

1. Stand up a collector (Grafana Cloud, Honeycomb, or an OTel Collector +
   Prometheus + Tempo). Set `OTEL_EXPORTER_OTLP_ENDPOINT` on all four services.
2. Point a Prometheus scrape at the engine's `/metrics`.
3. Load `alerts.yaml`.
4. Take one screenshot of a trace spanning web → api → engine → worker, which is
   the artifact rubric row 4 asks for, and attach it here.

Until step 4, this row is scored on the instrumentation existing, not on
anything being observed.
