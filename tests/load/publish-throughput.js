/**
 * Publish throughput at 10x the current peak. Rubric row 3.
 *
 * Run:
 *   k6 run -e BASE_URL=https://api-staging.godeyeautomation.com \
 *          -e TOKEN=<owner access token> tests/load/publish-throughput.js
 *
 * WHAT THIS MEASURES, and what it does not.
 *
 * The API's job on the publish path is to accept a schedule and hand it to the
 * dispatcher. It does NOT publish; the Celery worker does, on its own clock.
 * So this measures the API's admission path under load, plus the read paths a
 * customer hits while that is happening. The worker's own ceiling is measured
 * separately by tests/load/dispatch-ceiling.sql, because a k6 script cannot
 * make a platform accept 500 posts a minute and should not pretend to.
 *
 * Thresholds are the SLOs from docs/ops/SLOs.md. If they change there, they
 * change here; a load test whose pass mark drifts from the stated objective is
 * measuring its own opinion.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:4000";
const TOKEN = __ENV.TOKEN;

const scheduleLatency = new Trend("schedule_latency", true);
const readLatency = new Trend("read_latency", true);
const throttled = new Rate("throttled");
const accepted = new Counter("posts_accepted");

/**
 * Current peak is ~25 posts/hour of actual publishing, and the API sees roughly
 * 20 read requests per write. 10x peak is therefore ~250 writes/hour plus the
 * reads around them — but a per-hour rate says nothing about a burst, and
 * bursts are what break admission paths. So this runs 10x peak as a SUSTAINED
 * per-second arrival rate, which is far harsher than 10x the daily average.
 */
export const options = {
  scenarios: {
    reads: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "3m",
      preAllocatedVUs: 50,
      maxVUs: 200,
      exec: "readPath",
    },
    writes: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: 100,
      stages: [
        { target: 5, duration: "30s" }, // warm
        { target: 10, duration: "2m" }, // 10x peak, sustained
        { target: 0, duration: "30s" },
      ],
      exec: "writePath",
    },
  },
  thresholds: {
    // SLO: 99% of reads under 400ms.
    "read_latency{expected_response:true}": ["p(99)<400"],
    // SLO: 99% of schedule admissions under 800ms — it writes rows.
    "schedule_latency{expected_response:true}": ["p(99)<800"],
    // SLO: availability 99.9%. A 429 is NOT a failure; it is the rate limiter
    // doing its job, and counting it as one would push us to weaken the limiter
    // to pass a load test, which is exactly backwards.
    http_req_failed: ["rate<0.001"],
    // But it must not be the main answer either: if most of a 10x burst is
    // refused, the ceiling is the limiter's, not the system's, and the report
    // needs to say so.
    throttled: ["rate<0.25"],
  },
};

const auth = () => ({
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  tags: { name: "authed" },
});

export function readPath() {
  const res = http.get(`${BASE}/schedule?days=7`, auth());
  readLatency.add(res.timings.duration, { expected_response: res.status === 200 });
  throttled.add(res.status === 429);
  check(res, {
    "read ok or throttled": (r) => r.status === 200 || r.status === 429,
    // The one thing a load test must never see: a limit that opens under load.
    "rate-limit headers present": (r) => !!r.headers["Ratelimit-Limit"],
  });
  sleep(0.1);
}

export function writePath() {
  const payload = JSON.stringify({
    contentItemId: __ENV.CONTENT_ITEM_ID,
    connectionIds: [__ENV.CONNECTION_ID],
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    timezone: "Africa/Nairobi",
  });
  const res = http.post(`${BASE}/schedule`, payload, auth());
  scheduleLatency.add(res.timings.duration, { expected_response: res.status < 400 });
  throttled.add(res.status === 429);
  if (res.status < 400) accepted.add(1);
  check(res, {
    "accepted or throttled": (r) => r.status < 400 || r.status === 429,
    "never a 5xx": (r) => r.status < 500,
  });
}

export function handleSummary(data) {
  return {
    "docs/ops/load/publish-throughput.json": JSON.stringify(data, null, 2),
    stdout: `
Publish throughput, 10x peak
  reads   p99 ${Math.round(data.metrics.read_latency?.values?.["p(99)"] ?? 0)}ms
  writes  p99 ${Math.round(data.metrics.schedule_latency?.values?.["p(99)"] ?? 0)}ms
  429s    ${((data.metrics.throttled?.values?.rate ?? 0) * 100).toFixed(1)}%
  posts   ${data.metrics.posts_accepted?.values?.count ?? 0} accepted
`,
  };
}
