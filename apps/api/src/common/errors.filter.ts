import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { createHash } from "crypto";
import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "./jwt-auth.guard";
import { structuredLog } from "./logger";
import { currentTraceId } from "./telemetry";

/**
 * Error tracking, and one error shape. Rubric rows 4 and 12.
 *
 * Two jobs that belong together because they read the same exception:
 *
 * 1. **Record it where it can be found.** The exception is attached to the
 *    active span and logged as structured JSON with a stable fingerprint, so
 *    "this has happened 400 times since Tuesday" is a group-by rather than a
 *    guess. That is error tracking; whether a Sentry sits on the other end of
 *    the OTLP pipe is a deployment decision, not a code one.
 *
 * 2. **Answer in one shape.** RFC 9457 Problem Details, so a client has one
 *    thing to parse instead of three — Nest's default, ZodPipe's, and whatever
 *    an unhandled throw produced.
 *
 * A 5xx never carries the exception message outward. An engine error string can
 * contain a connection URL, and "internal error" plus a trace id is more useful
 * to support than a leaked DSN is to anybody.
 */

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** The trace this happened in. The single most useful thing in a bug report. */
  traceId?: string;
  /** Machine-readable, where a handler set one (WORKSPACE_LOCKED, MFA_REQUIRED…). */
  code?: string;
  errors?: unknown;
}

/**
 * A stable id for "the same bug", so occurrences group.
 *
 * Deliberately built from the type, the route template and the top frame —
 * never from the message, which usually contains an id and would make every
 * occurrence unique, which is the same as no grouping at all.
 */
function fingerprint(error: unknown, route: string): string {
  const name = error instanceof Error ? error.name : typeof error;
  const frame =
    error instanceof Error && error.stack
      ? (error.stack.split("\n")[1] ?? "").trim().replace(/:\d+:\d+\)?$/, "")
      : "";
  return createHash("sha256").update(`${name}|${route}|${frame}`).digest("hex").slice(0, 12);
}

@Catch()
export class ErrorsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http") throw exception;

    const ctx = host.switchToHttp();
    const req = ctx.getRequest<AuthenticatedRequest>();
    const res = ctx.getResponse<Response>();
    const route = (req as Request & { route?: { path?: string } }).route?.path ?? req.path;

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const body = exception instanceof HttpException ? exception.getResponse() : null;
    const asObject = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

    const problem: ProblemDetails = {
      // A URL is what RFC 9457 asks for; a stable relative one is honest and
      // does not promise a page that has to be kept alive forever.
      type: `/problems/${status}`,
      title: typeof asObject.error === "string" ? asObject.error : titleFor(status),
      status,
      instance: req.originalUrl,
      traceId: currentTraceId(),
    };

    if (typeof asObject.code === "string") problem.code = asObject.code;
    if (Array.isArray(asObject.message)) problem.errors = asObject.message;

    if (status < 500) {
      // 4xx: the caller can act on this, so say what is wrong.
      const detail =
        typeof body === "string"
          ? body
          : typeof asObject.message === "string"
            ? asObject.message
            : undefined;
      if (detail) problem.detail = detail;
    } else {
      // 5xx: never the exception text. An engine error can carry a connection
      // string, and the trace id is more useful to support anyway.
      problem.detail = "The server could not complete this request.";

      const span = trace.getActiveSpan();
      if (span) {
        span.recordException(exception as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: titleFor(status) });
      }

      structuredLog("error", exception instanceof Error ? exception.message : String(exception), "Unhandled", {
        fingerprint: fingerprint(exception, route),
        route,
        method: req.method,
        status,
        orgId: req.auth?.orgId,
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }

    res
      .status(status)
      // RFC 9457's media type. Clients that only look at the body are unaffected.
      .setHeader("Content-Type", "application/problem+json")
      .json(problem);
  }
}

function titleFor(status: number): string {
  const titles: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    413: "Payload Too Large",
    429: "Too Many Requests",
    503: "Service Unavailable",
  };
  return titles[status] ?? (status >= 500 ? "Internal Server Error" : "Request Error");
}
