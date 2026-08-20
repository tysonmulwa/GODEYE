/**
 * OpenTelemetry, started before anything else imports a module it patches.
 *
 * Rubric row 4. Before this there were no traces, no metrics, no error tracking
 * and no structured logs anywhere in the tree — which meant every control added
 * during the P0 phase was invisible in production. You could not see the rate
 * limiter fail closed, the circuit breaker open, or the token-refresh sweep
 * start failing; you could only see the support ticket that followed.
 *
 * ## Why this file is imported first
 *
 * Auto-instrumentation works by monkey-patching `http`, `express` and `ioredis`
 * as they are required. Anything that requires them before the SDK starts is
 * never instrumented, silently — the traces simply have holes in them and
 * nothing says why. Hence `import "./common/telemetry"` as the first line of
 * main.ts, and hence the side-effectful shape of this module.
 *
 * ## What it does when nothing is configured
 *
 * Nothing, loudly once. Without `OTEL_EXPORTER_OTLP_ENDPOINT` the SDK is not
 * started at all: a tracer that batches spans nobody collects is memory and CPU
 * spent on a queue that is dropped. `trace.getTracer()` still returns a working
 * no-op, so instrumented code needs no branches.
 */
import { diag, DiagConsoleLogger, DiagLogLevel, metrics, trace } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

export const SERVICE_NAME = "godeye-api";

/** The build, so a trace can be attributed to a deploy rather than to "prod". */
const BUILD = (process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown").slice(0, 8);

let sdk: NodeSDK | undefined;

function shouldStart(): boolean {
  // Never in tests: the SDK opens exporters and timers that outlive a suite,
  // and a test that fails because a span queue was still flushing teaches
  // people to distrust the suite.
  if (process.env.NODE_ENV === "test") return false;
  return !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

export function startTelemetry(): void {
  if (sdk) return;
  if (!shouldStart()) {
    if (process.env.NODE_ENV === "production") {
      // Worth a line. A production deploy with no telemetry endpoint is a
      // choice somebody should have made on purpose.
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          level: "warn",
          service: SERVICE_NAME,
          msg: "OTEL_EXPORTER_OTLP_ENDPOINT is not set; traces and metrics are not being exported",
        }),
      );
    }
    return;
  }

  if (process.env.OTEL_DEBUG === "true") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: BUILD,
      "deployment.environment": process.env.NODE_ENV ?? "development",
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [
      new HttpInstrumentation({
        // Health checks are the highest-volume route in any deployment and the
        // least interesting. Tracing them buries every real request.
        ignoreIncomingRequestHook: (req) => (req.url ?? "").startsWith("/health"),
        // The outbound span is what makes an engine call visible as a child of
        // the request that caused it, which is the whole point of the trace.
        requestHook: (span, request) => {
          const upstream = (request as { host?: string }).host;
          if (upstream) span.setAttribute("peer.service", upstream);
        },
      }),
      new ExpressInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });

  sdk.start();

  // Flush on the way out. Without this the last spans before a deploy — which
  // are the ones you want during a rollback — are dropped.
  const shutdown = () => {
    // lint-rules:allow — shutdown. The process is exiting either way, and a
    // failed flush has nowhere left to be reported to.
    void sdk?.shutdown().catch(() => undefined);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

export const tracer = trace.getTracer(SERVICE_NAME, BUILD);
export const meter = metrics.getMeter(SERVICE_NAME, BUILD);

/** The active trace id, for stamping onto a log line or an error response. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  const id = span?.spanContext().traceId;
  // All-zeros is what a no-op span reports; it is not a trace id.
  return id && id !== "00000000000000000000000000000000" ? id : undefined;
}

startTelemetry();
