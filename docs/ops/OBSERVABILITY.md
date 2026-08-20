# Observability

**Rubric row 4.** SLOs: [SLOs.md](./SLOs.md) · Alerts: [alerts.yaml](./alerts.yaml)

---

## What was there before

Nothing. No traces, no metrics, no error tracking, no alerting, no structured
logging, in any of the four services.

That is worse than it sounds, because it is the row that makes every other row
unprovable. The P0 phase added a rate limiter that fails closed, a circuit
breaker, a token-refresh sweep and an SSRF guard — and **none of them could be
observed in production**. You could not see the limiter refuse, the breaker
open, or the refresh sweep start failing. You could only see the support ticket
that followed, days later.

## The four signals

### Traces — one id from the click to the platform

```
browser (traceparent)  →  API  →  engine  →  Celery worker  →  Meta / TikTok
```

| Link | How |
|---|---|
| browser → API | `apps/web/src/lib/trace.ts` mints a W3C `traceparent` per page view |
| API → engine | `@opentelemetry/instrumentation-http` propagates it outbound |
| engine → worker | `CeleryInstrumentor` carries it through the message |
| worker → platform | `HTTPXClientInstrumentor` makes each platform call a span |

The browser side is ~40 lines rather than the browser OTel SDK. The SDK's value
is automatic instrumentation of fetch, XHR and page load — a large bundle
shipped to a customer's phone to answer a question this repository does not yet
ask. **The header format is the contract, not the library**, so swapping it in
later changes no call site.

One trace id per **page view**, not per request: "the composer page was slow" is
one trace containing every call it made, not eleven unrelated ones.

`traceparent` is not a CORS-safelisted header, so `main.ts` lists it explicitly
in `allowedHeaders`. Without that, every cross-origin request fails preflight and
the browser reports it as a generic CORS error.

### Metrics — RED for the API, USE for the worker

**RED** (`MetricsInterceptor`): one histogram,
`http.server.request.duration`, with `method`, `route`, `status`, `outcome` and
`throttled`. One instrument rather than three because a histogram answers rate,
errors and duration at once and cannot disagree with itself, which a separate
counter and timer eventually will.

**USE** (`metrics_registry.py`): a worker is a resource, not an endpoint.

| | Metric |
|---|---|
| Utilisation | `godeye_tasks_in_flight`, `godeye_task_duration_seconds` |
| Saturation | `godeye_queue_depth`, `godeye_publish_lateness_seconds`, `godeye_due_posts_backlog` |
| Errors | `godeye_publish_total`, `godeye_connection_refresh_total`, `godeye_egress_blocked_total` |

**Queue depth and publish lateness are the two numbers that predict a customer
noticing.** Everything else is diagnosis after the fact.

#### Two decisions worth knowing

**Cardinality.** The route *template*, never the URL. `/seo/audits/:id` is one
series; `/seo/audits/clx8…` is one series per audit, which is how a metrics bill
arrives that costs more than the servers. `orgId` is deliberately absent from
every metric and present on every *span* — spans are sampled, metrics are not.

**Units.** Seconds, not milliseconds. OTel's Prometheus exporter appends the
unit to the name, so `unit: "ms"` produces
`http_server_request_duration_milliseconds_bucket` and every alert written
against `_seconds_` silently matches nothing.

**Saturation is sampled on scrape**, not pushed on a timer, so a scraper that
stops produces a gap rather than a flat line. A flat line reads as healthy and is
the worst possible answer to "is anything wrong".

### Logs — JSON, with the trace id, PII removed before it is written

`StructuredLogger` (Node) and `JsonFormatter` (Python) emit one JSON object per
line carrying `ts`, `level`, `service`, `context`, **`traceId`** and `msg`.

Development keeps the readable coloured output. A JSON line per request is
unreadable in a terminal, and a log format nobody can read while developing is a
log format people turn off.

**Redaction happens before the write, not in the dashboard.** GDPR Art. 5(1)(c)
is an obligation on what is *stored*, and a log store is storage. `redact()`
removes ~20 secret-bearing keys outright, masks emails to `j***@domain` — the
domain survives because "which customer's users are affected" is a real question
that does not need a person's name — and truncates anything token-shaped even
inside a free-text exception message, which is where most leaks actually are.

24 assertions in `apps/api/src/common/logger.spec.ts`, including that a
redactor which removes *everything* is as useless as one that removes nothing.

### Errors — recorded, grouped, and shaped

`ErrorsFilter` does two jobs on one exception:

1. Attaches it to the active span and logs it with a **stable fingerprint** built
   from type + route + top frame — never the message, which usually contains an
   id and would make every occurrence unique, which is the same as no grouping.
2. Answers in **RFC 9457 Problem Details**, so a client has one shape to parse
   instead of three.

A 5xx never carries the exception text outward. An engine error string can
contain a connection URL; "the server could not complete this request" plus a
trace id is more useful to support than a leaked DSN is to anybody.

## Turning it on

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.your-collector.example
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20…
LOG_FORMAT=json          # implied by NODE_ENV=production
OTEL_DEBUG=true          # only while proving the pipe works
```

Set on **all four** Railway services. Then point a Prometheus scrape at the
engine's `GET /metrics` and load `alerts.yaml`.

**Unset, nothing is exported and the SDK is not started at all** — a tracer
batching spans nobody collects is CPU spent on a queue that gets dropped. In
production, that state logs a warning once, because it should be a deliberate
choice. `trace.getTracer()` still returns a working no-op, so no instrumented
code needs a branch.

Never started in tests: exporters and timers that outlive a suite produce
failures with nothing to do with the code under test.

## 🔴 Status: instrumented, not observed

Everything above exists and runs. **None of it has been observed**, because
`OTEL_EXPORTER_OTLP_ENDPOINT` is unset and there is no collector.

Specifically not done:

- No collector, so **no trace has ever been exported** — including the
  web → api → engine → worker trace that is this row's evidence artifact.
- No dashboard.
- `alerts.yaml` is valid Prometheus syntax and **has never been loaded**, so no
  rule has evaluated even once.
- Sampling is 100%, which is right at this volume and wrong at 100×.

Every metric name in `alerts.yaml` has a matching instrument in
`common/metrics.ts` or `metrics_registry.py`, and every instrument there has a
rule — an alert referencing a metric nobody emits is a rule that silently never
fires, which looks like coverage and is worse than nothing. That correspondence
was checked by reading both files, **not by running Prometheus.**

To close the row, in order:

1. Stand up a collector — Grafana Cloud, Honeycomb, or OTel Collector +
   Prometheus + Tempo. Set the endpoint on all four services.
2. Scrape the engine's `/metrics`.
3. `promtool check rules docs/ops/alerts.yaml`, then load it.
4. Capture one trace spanning web → api → engine → worker and attach it here.

Until step 4, this row is scored on the instrumentation existing, not on
anything having been seen.
