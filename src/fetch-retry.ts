// Bounded transient-retry for HTTP requests, with the replay policy as an
// explicit argument so the read path and the one write path we replay share
// a single implementation instead of hand-rolling a loop per call site.
//
// A cold Brass API container can reject a request at the gateway with a
// transient 5xx (503 while the API scales into a concurrent burst, 502 /
// 504 on a cold-start blip) or 429 (a short rate spike). These are not
// the caller's error and clear within a second or two, so a single hard
// failure on a document open reads as "the app is broken" when a brief
// wait-and-retry would have succeeded.
//
// What is safe to replay depends on whether the request is idempotent,
// which is why the policy is a parameter rather than a constant:
//
// - A GET is idempotent, so replaying it is always safe: retry the whole
//   transient 5xx / 429 set AND a thrown network error (`RETRY_READ`).
// - A write is NOT idempotent, so only a 503 is safe to replay: the API
//   gateway returns a 503 BEFORE the request reaches the handler (a transient
//   throttle / scale-up / deploy-window blip), so the write never ran and
//   a replay cannot double-apply it. A 502 / 504 / 429 or a network throw
//   might mean the handler ran, so those stay hard failures (`RETRY_WRITE_503`).
// - A 500 is never retried under either policy: an unhandled server error
//   is usually deterministic, so a replay just doubles the cost without
//   changing the outcome.
// A 4xx other than 429 (403 app_not_installed, 404) is a definitive answer
// and is never in a policy's replay set.

export interface RetryPolicy {
  // HTTP statuses whose response is replayed rather than returned.
  replayStatuses: ReadonlySet<number>;
  // Whether a thrown network error (DNS, connection reset, TLS) is replayed.
  // Safe only for an idempotent request: a throw on a write might mean the
  // handler ran, so a write policy leaves this false.
  replayNetworkErrors: boolean;
}

// Idempotent GET: replay the full transient set and network throws.
export const RETRY_READ: RetryPolicy = {
  replayStatuses: new Set([429, 502, 503, 504]),
  replayNetworkErrors: true,
};

// Non-idempotent write: replay ONLY a pre-handler 503, never a network throw.
export const RETRY_WRITE_503: RetryPolicy = {
  replayStatuses: new Set([503]),
  replayNetworkErrors: false,
};

// Idempotent write: replay the full transient set AND a network throw, exactly
// like a read. Safe only when the request carries a STABLE idempotency key the
// server dedupes on, so a replay the handler already applied returns the
// original result instead of applying twice. This is what lets document create
// stop assuming a 503 is always pre-handler (`RETRY_WRITE_503`'s constraint):
// with a key, even a post-handler 503 or a network throw is replay-safe.
export const RETRY_IDEMPOTENT_WRITE: RetryPolicy = {
  replayStatuses: new Set([429, 502, 503, 504]),
  replayNetworkErrors: true,
};

export interface RetryOptions {
  // Which statuses / throws replay. Defaults to the idempotent read policy.
  policy?: RetryPolicy;
  // Total attempts including the first. Default 3 (so up to 2 replays).
  maxAttempts?: number;
  // Base backoff; attempt N waits ~base * 2^(N-1) with jitter. Default 300.
  baseDelayMs?: number;
  // Invoked before each replay with the 1-based attempt that just failed and
  // the response (absent on a network throw). For diagnostics only.
  onRetry?: (attempt: number, response: Response | undefined) => void;
  // Injected for tests; defaults to the real timer.
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Run `doFetch` (which performs one request) up to `maxAttempts` times,
// replaying per `policy` with exponential backoff plus jitter between tries.
// Returns the last Response (replayable or not) so the caller keeps its own
// status handling; rethrows the last network error only if the policy replays
// throws and every attempt threw. A network throw the policy does not replay
// propagates immediately.
export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  options: RetryOptions = {},
): Promise<Response> {
  const policy = options.policy ?? RETRY_READ;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await doFetch();
    } catch (err) {
      // A network-level throw is only replayable for an idempotent request;
      // a write policy rethrows it rather than risk a double-apply.
      if (!policy.replayNetworkErrors) throw err;
      lastError = err;
    }
    if (response && !policy.replayStatuses.has(response.status)) {
      return response;
    }
    if (attempt === maxAttempts) {
      if (response) return response;
      throw lastError;
    }
    options.onRetry?.(attempt, response);
    // Exponential backoff with jitter so a burst of clients that all
    // failed together do not re-collide on the same retry tick.
    const backoff = baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.random() * baseDelayMs;
    await sleep(backoff + jitter);
  }
  // Unreachable: the loop returns or throws on the final attempt.
  throw lastError ?? new Error('fetchWithRetry: no attempts made');
}
