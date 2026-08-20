import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import type { Request, Response } from "express";
import { Observable } from "rxjs";
import { catchError, tap } from "rxjs/operators";
import type { AuthenticatedRequest } from "./jwt-auth.guard";
import { meter } from "./telemetry";

/**
 * RED metrics on every endpoint: Rate, Errors, Duration. Rubric row 4.
 *
 * One histogram, not three: a histogram with a `status` and an `outcome`
 * attribute answers all three questions and cannot disagree with itself, which
 * a separate counter and timer eventually will.
 *
 * ## Cardinality
 *
 * The route TEMPLATE, never the URL. `/seo/audits/:id` is one series;
 * `/seo/audits/clx8...` is one series per audit, which is how a metrics bill
 * arrives that costs more than the servers. Same reason `orgId` is deliberately
 * absent: per-tenant latency is a question for traces, which are sampled, not
 * for metrics, which are not.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  /**
   * Seconds, not milliseconds.
   *
   * OpenTelemetry's Prometheus exporter appends the unit to the metric name, so
   * `unit: "ms"` produces `http_server_request_duration_milliseconds_bucket`
   * and every alert expression written against `_seconds_` silently matches
   * nothing. Base units are the Prometheus convention for exactly this reason.
   */
  private readonly duration = meter.createHistogram("http.server.request.duration", {
    description: "Time to produce an HTTP response",
    unit: "s",
  });

  private readonly inFlight = meter.createUpDownCounter("http.server.active_requests", {
    description: "Requests currently being served",
  });

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<AuthenticatedRequest>();
    const res = http.getResponse<Response>();

    // The template Nest matched, not the path the client sent.
    const route = (req as Request & { route?: { path?: string } }).route?.path ?? "unmatched";
    const base = { method: req.method, route };
    const started = process.hrtime.bigint();
    this.inFlight.add(1, base);

    // Two attributes every trace in this system carries, so a span can be found
    // from a workspace and a workspace from a span. On the SPAN, not the metric:
    // spans are sampled, metrics are not, and orgId on a metric is unbounded
    // cardinality.
    const span = trace.getActiveSpan();
    if (span && req.auth) {
      span.setAttribute("godeye.org_id", req.auth.orgId);
      span.setAttribute("godeye.user_id", req.auth.sub);
      span.setAttribute("godeye.role", req.auth.role);
    }

    const record = (status: number, outcome: "ok" | "error") => {
      const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      this.inFlight.add(-1, base);
      this.duration.record(seconds, {
        ...base,
        status,
        // A 4xx is the API working correctly and is not an error budget event.
        // Counting it as one is how a team ends up loosening validation to make
        // a dashboard green.
        outcome,
        // Broken out because it has its own SLO and its own meaning: sustained
        // 429s mean the limiter is the ceiling, not the system.
        throttled: status === 429,
      });
    };

    return next.handle().pipe(
      tap(() => record(res.statusCode, res.statusCode >= 500 ? "error" : "ok")),
      catchError((error: unknown) => {
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? Number((error as { status: unknown }).status)
            : 500;
        record(status, status >= 500 ? "error" : "ok");
        throw error;
      }),
    );
  }
}
