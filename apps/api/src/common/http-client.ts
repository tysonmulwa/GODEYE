import { Logger, ServiceUnavailableException } from "@nestjs/common";

/**
 * The only place this API is allowed to call `fetch`. Finding B-4.
 *
 * Node's `fetch` (undici) applies **no total-request timeout** — only a
 * 300-second headers timeout. So a hung engine, a slow Paystack, or an
 * unresponsive Meta endpoint held an API request, an event-loop slot and a
 * database connection for up to five minutes. All eleven outbound calls in this
 * service were bare `fetch(...)`; `rg "AbortSignal|signal:" apps/api/src`
 * returned zero.
 *
 * The worst instance was `/health`, which called the engine synchronously: the
 * health check itself could hang for five minutes, which is the precise inverse
 * of its purpose.
 *
 * Every call therefore states its deadline, and a lint rule (eslint.config.js,
 * `no-restricted-globals: fetch`) makes a bare `fetch(` outside this file an
 * error.
 */

export interface HttpRequestOptions extends Omit<RequestInit, "signal"> {
  /** Hard deadline for the whole request, in milliseconds. Required. */
  timeoutMs: number;
  /**
   * Retry only when the operation is safe to repeat. Never a payment charge and
   * never a publish: at-most-once matters more than at-least-once when the side
   * effect is somebody's money or somebody's timeline.
   */
  retries?: number;
  /** Names the upstream for the circuit breaker and the logs. */
  upstream: string;
}

/** Consecutive failures before an upstream is considered down. */
const FAILURE_THRESHOLD = 5;
/** How long the breaker stays open before it lets one probe through. */
const OPEN_MS = 30_000;

type BreakerState = { failures: number; openedAt: number | null };

const breakers = new Map<string, BreakerState>();
const logger = new Logger("HttpClient");

function breaker(upstream: string): BreakerState {
  let state = breakers.get(upstream);
  if (!state) {
    state = { failures: 0, openedAt: null };
    breakers.set(upstream, state);
  }
  return state;
}

/** Exposed for tests and for a future /health/ready readout. */
export function breakerState(upstream: string): Readonly<BreakerState> {
  return breaker(upstream);
}

export function resetBreakers(): void {
  breakers.clear();
}

class UpstreamUnavailable extends ServiceUnavailableException {
  constructor(upstream: string, detail: string) {
    super(`${upstream} is unavailable: ${detail}`);
  }
}

/** Full jitter (AWS's "Exponential Backoff and Jitter"): every retry picks a
 *  random point in its window, so N clients retrying do not do it in lockstep. */
function backoffMs(attempt: number): number {
  return Math.floor(Math.random() * Math.min(2_000, 100 * 2 ** attempt));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fetch` with a mandatory deadline, a circuit breaker, and optional retries.
 *
 * The breaker matters as much as the timeout: without it, a dead dependency
 * means every request waits its full budget before failing, and the pool drains
 * anyway — slower, but just as completely.
 */
export async function httpRequest(
  url: string,
  { timeoutMs, retries = 0, upstream, ...init }: HttpRequestOptions,
): Promise<Response> {
  const state = breaker(upstream);

  if (state.openedAt !== null) {
    if (Date.now() - state.openedAt < OPEN_MS) {
      // Fail fast rather than queue behind a dependency that is already down.
      throw new UpstreamUnavailable(upstream, "circuit open after repeated failures");
    }
    // Half-open: let exactly this request through and judge by its result.
    state.openedAt = null;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        // AbortSignal.timeout covers the WHOLE request, unlike undici's
        // headers-only default.
        signal: AbortSignal.timeout(timeoutMs),
      });
      // A 5xx is an upstream failure for breaker purposes; a 4xx is our fault
      // and retrying it is pointless.
      if (response.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (response.status < 500) state.failures = 0;
      else recordFailure(state, upstream);
      return response;
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }

  recordFailure(state, upstream);
  const detail =
    lastError instanceof Error
      ? lastError.name === "TimeoutError"
        ? `no response within ${timeoutMs}ms`
        : lastError.message
      : String(lastError);
  throw new UpstreamUnavailable(upstream, detail);
}

function recordFailure(state: BreakerState, upstream: string): void {
  state.failures += 1;
  if (state.failures >= FAILURE_THRESHOLD && state.openedAt === null) {
    state.openedAt = Date.now();
    logger.error(
      `Circuit opened for ${upstream} after ${state.failures} consecutive failures; ` +
        `failing fast for ${OPEN_MS / 1000}s`,
    );
  }
}

/**
 * Budgets, in one place so they can be reviewed together.
 *
 * `/health` is 3s because a health check that can hang is not a health check.
 * Payments and platform APIs get 15s because they are user-visible and slow.
 */
export const TIMEOUTS = {
  health: 3_000,
  engineEnqueue: 10_000,
  paystack: 15_000,
  platform: 15_000,
} as const;
