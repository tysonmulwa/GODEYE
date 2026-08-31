import { Injectable, Logger } from "@nestjs/common";
import { env } from "../common/env";
import { httpRequest } from "../common/http-client";

/**
 * Transactional email, through Resend.
 *
 * ## Sending must not be able to break the thing that triggered it
 *
 * A welcome email is a courtesy attached to a registration that has already
 * succeeded: the row is written, the session is issued, and the person is
 * looking at their dashboard. If Resend is down, the correct outcome is a
 * logged failure and a working account, not a 500 on a registration that
 * actually worked. So `send` resolves to a result rather than throwing.
 *
 * The exception is password reset, which is not a courtesy — it is the entire
 * mechanism. `sendOrThrow` exists for that one case, and the caller decides
 * what to tell the user.
 *
 * ## Nothing is silently swallowed
 *
 * Every failure path logs the template, the upstream status and the Resend
 * error id when there is one. What it does not do is rethrow into a request
 * that had nothing to do with email.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Names the template in logs, so a failing one can be found. */
  template: string;
}

export interface SendResult {
  sent: boolean;
  /** Resend's message id, when it accepted the message. */
  id?: string;
  reason?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  /** Logged once, not per send: a missing key is a deployment fact. */
  private warnedDisabled = false;

  /** True when a key is configured. Read by the health endpoint. */
  get enabled(): boolean {
    return env.email.enabled;
  }

  /**
   * Best effort. Never throws, always reports what happened.
   */
  async send(message: EmailMessage): Promise<SendResult> {
    if (!env.email.enabled) {
      if (!this.warnedDisabled) {
        this.warnedDisabled = true;
        this.logger.warn(
          "RESEND_API_KEY is not set: transactional email is disabled and every send is a no-op",
        );
      }
      return { sent: false, reason: "not-configured" };
    }

    try {
      return await this.deliver(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Deliberately not rethrown. See the class comment: the caller's work has
      // already succeeded and an email is not allowed to undo it.
      this.logger.error(
        `email "${message.template}" was not delivered: ${detail}`,
        error instanceof Error ? error.stack : undefined,
      );
      return { sent: false, reason: detail };
    }
  }

  /**
   * For the one message whose failure the caller must know about.
   *
   * A password reset that silently fails leaves someone locked out of their
   * account with a screen telling them to check an inbox that will never
   * receive anything.
   */
  async sendOrThrow(message: EmailMessage): Promise<SendResult> {
    if (!env.email.enabled) {
      throw new Error(
        `Cannot send "${message.template}": RESEND_API_KEY is not set. ` +
          "Password reset cannot work without it.",
      );
    }
    return this.deliver(message);
  }

  private async deliver(message: EmailMessage): Promise<SendResult> {
    const response = await httpRequest(RESEND_ENDPOINT, {
      method: "POST",
      upstream: "resend",
      timeoutMs: 10_000,
      // One retry only, and only the transport kind: Resend deduplicates
      // nothing, so a retry after a request that actually landed sends a second
      // copy. The circuit breaker is what protects a sustained outage.
      retries: 1,
      headers: {
        authorization: `Bearer ${env.email.apiKey}`,
        "content-type": "application/json",
        // Resend honours this for genuine idempotency on repeated delivery.
        "idempotency-key": `${message.template}:${message.to}:${new Date().toISOString().slice(0, 13)}`,
      },
      body: JSON.stringify({
        from: env.email.from,
        to: [message.to],
        reply_to: env.email.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // 403 from Resend almost always means the From domain is not verified,
      // which reads like an auth failure and is not one. Worth saying outright.
      const hint =
        response.status === 403
          ? ` (is "${env.email.from}" on a domain verified in Resend?)`
          : "";
      throw new Error(`resend responded ${response.status}${hint}: ${body.slice(0, 300)}`);
    }

    const payload = (await response.json().catch(() => ({}))) as { id?: string };
    this.logger.log(`sent "${message.template}" to ${redact(message.to)} (${payload.id ?? "no id"})`);
    return { sent: true, id: payload.id };
  }
}

/**
 * An address in a log line, with the local part shortened.
 *
 * Logs are read by more people than the mailbox is, and a full address in a
 * shipped log is a small data leak that nobody ever notices making.
 */
export function redact(address: string): string {
  const [local, domain] = address.split("@");
  if (!domain) return "invalid-address";
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

