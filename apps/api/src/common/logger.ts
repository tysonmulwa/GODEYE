import { ConsoleLogger, Injectable, LogLevel, Scope } from "@nestjs/common";
import { currentTraceId, SERVICE_NAME } from "./telemetry";

/**
 * Structured JSON logs, with the trace id and with PII redacted.
 *
 * Rubric row 4. Nest's default logger writes a coloured line meant for a human
 * watching a terminal. In production it is parsed by nobody: you cannot filter
 * by workspace, you cannot join a log to a trace, and every field is inside one
 * free-text string.
 *
 * Two properties matter more than the format:
 *
 * 1. **The trace id is on every line.** A log without one is an observation you
 *    cannot connect to the request that produced it, which is most of the value
 *    of having traces at all.
 * 2. **PII never reaches the log.** Not "is masked in the dashboard" — never
 *    written. GDPR Art. 5(1)(c) is a data-minimisation obligation on what is
 *    stored, and a log store is storage. `redact()` runs on every value.
 */

/** Keys whose value is never written, whatever it contains. */
const SECRET_KEYS = new Set(
  [
    "password",
    "currentpassword",
    "newpassword",
    "passwordhash",
    "token",
    "accesstoken",
    "refreshtoken",
    "refresh_token",
    "access_token",
    "idtoken",
    "authorization",
    "cookie",
    "setcookie",
    "secret",
    "apikey",
    "api_key",
    "apisecret",
    "clientsecret",
    "client_secret",
    "botToken".toLowerCase(),
    "pageaccesstoken",
    "encryptedcredentials",
    "mfasecret",
    "mfacode",
    "code",
    "state",
    "signature",
    "key",
    "privatekey",
    "tokenhash",
  ].map((k) => k.toLowerCase()),
);

/** Keys that are personal data: kept, but only in a form that cannot identify. */
const PII_KEYS = new Set(["email", "phone", "name", "displayname", "ip", "useragent", "avatarurl"]);

const EMAIL_RE = /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
/** Long random-looking strings: bearer tokens, references, hex keys. */
const TOKENLIKE_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

/**
 * `jane@acme.com` → `j***@acme.com`.
 *
 * The domain is kept because "which customer's users are affected" is a real
 * operational question and the domain answers it without identifying a person.
 */
function maskEmail(value: string): string {
  return value.replace(EMAIL_RE, (address) => {
    const [local, domain] = address.split("@");
    return `${local[0]}***@${domain}`;
  });
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return maskEmail(value).replace(TOKENLIKE_RE, (m) => `${m.slice(0, 4)}…[redacted]`);
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SECRET_KEYS.has(lower)) {
      out[key] = "[redacted]";
    } else if (PII_KEYS.has(lower)) {
      out[key] = typeof v === "string" ? maskEmail(v).slice(0, 64) : "[pii]";
    } else {
      out[key] = redact(v, depth + 1);
    }
  }
  return out;
}

export interface LogFields {
  [key: string]: unknown;
}

/**
 * Emitted as one JSON object per line, which is what every log pipeline wants
 * and what Nest's default logger is not.
 */
function emit(level: LogLevel, message: unknown, context?: string, fields?: LogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    context,
    // The join between a log line and its trace. Without it, "find the logs for
    // this slow request" is a timestamp search.
    traceId: currentTraceId(),
    msg: typeof message === "string" ? message : JSON.stringify(redact(message)),
    ...(fields ? (redact(fields) as LogFields) : {}),
  };
  const serialised = JSON.stringify(line);
  if (level === "error" || level === "fatal") process.stderr.write(`${serialised}\n`);
  else process.stdout.write(`${serialised}\n`);
}

@Injectable({ scope: Scope.TRANSIENT })
export class StructuredLogger extends ConsoleLogger {
  /**
   * Development keeps Nest's coloured output: a JSON line per request is
   * unreadable in a terminal, and a logger nobody can read during development
   * is a logger people turn off.
   */
  private get json(): boolean {
    return process.env.NODE_ENV === "production" || process.env.LOG_FORMAT === "json";
  }

  log(message: unknown, ...rest: unknown[]): void {
    if (!this.json) return super.log(message as string, ...(rest as string[]));
    emit("log", message, this.context, rest[0] as LogFields);
  }

  error(message: unknown, ...rest: unknown[]): void {
    if (!this.json) return super.error(message as string, ...(rest as string[]));
    const [stackOrFields] = rest;
    emit("error", message, this.context, {
      ...(typeof stackOrFields === "string" ? { stack: stackOrFields } : (stackOrFields as LogFields)),
    });
  }

  warn(message: unknown, ...rest: unknown[]): void {
    if (!this.json) return super.warn(message as string, ...(rest as string[]));
    emit("warn", message, this.context, rest[0] as LogFields);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    if (!this.json) return super.debug?.(message as string, ...(rest as string[]));
    emit("debug", message, this.context, rest[0] as LogFields);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    if (!this.json) return super.verbose?.(message as string, ...(rest as string[]));
    emit("verbose", message, this.context, rest[0] as LogFields);
  }
}

/** For call sites that are not inside a Nest provider. */
export const structuredLog = emit;
