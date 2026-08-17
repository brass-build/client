// A deadline for a request whose caller has no other way to stop waiting.
//
// `fetch` has no timeout of its own, so a request that draws no answer stays
// pending for as long as the page is open. On the op-write path that pins the
// op's entry in the outstanding tracker, which holds `doc.savingCount` above
// zero, which is what an app renders as "Saving...". The reader is then shown
// a save in progress that nothing will ever resolve, and no error reaches
// `Brass.onError` because nothing failed.
//
// The deadline covers reading the body as well as getting a response, because
// `fetch` resolves as soon as the headers land: a server that answers and then
// stalls mid-body is the same hang, and clearing the timer on the response
// would leave exactly the case this exists for uncovered. The helper therefore
// reads the body itself rather than handing back a `Response` whose consumption
// nothing bounds.
//
// An abort is deliberately reported as a request that drew no answer at all
// (status `null`), because that is what it is: the write may or may not have
// reached the handler. Callers price that the same way they price a network
// throw.

// How long a request that carries no meaningful body may go unanswered.
//
// The value matches the WebSocket transport's forced-resend ceiling, because
// it answers the same question about the same op: whether a request still
// outstanding this long after it went out is coming back. It sits well above
// any latency a working connection produces.
//
// What a false positive costs is bounded. Staging is replayed, which writes
// nothing durable until the op write names the key. The op write itself is
// terminal for that op, which arms the durability handshake, and the
// handshake pushes whatever the durable frontier is actually missing rather
// than replaying the op blindly.
export const OP_WRITE_TIMEOUT_MS = 60_000;

// The uplink an upload is assumed to manage in the worst case, in bytes per
// millisecond (16 KB/s). A request carrying megabytes is not unanswered while
// its body is still going out, so a flat deadline would abort a working upload
// on a slow mobile connection and fail an op that was about to land. The
// allowance is generous on purpose: a deadline that fires early on real work is
// a worse failure than one that takes longer to notice a dead request, since
// the whole point is to distinguish silence from slowness.
const ASSUMED_MIN_UPLOAD_BYTES_PER_MS = 16;

/** Deadline for a request whose body is `byteLength` bytes of upload. */
export function deadlineForUpload(byteLength: number): number {
  return (
    OP_WRITE_TIMEOUT_MS +
    Math.ceil(Math.max(0, byteLength) / ASSUMED_MIN_UPLOAD_BYTES_PER_MS)
  );
}

export class FetchDeadlineError extends Error {
  override name = 'FetchDeadlineError';
}

export interface DeadlineResponse {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * Run a fetch under a deadline covering the response and its body, aborting
 * the request when it expires.
 *
 * The timer is cleared on every exit, so a completed request leaves nothing
 * pending. An environment whose `fetch` ignores `AbortSignal` still rejects,
 * because the deadline is raced against the request rather than relying on the
 * abort landing.
 */
export async function fetchWithDeadline(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<DeadlineResponse> {
  const controller = new AbortController();
  let expired = false;
  let fire: (() => void) | undefined;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
    fire?.();
  }, timeoutMs);
  // A long-lived deadline must not hold a Node process open on its own.
  (timer as unknown as { unref?: () => void }).unref?.();

  const expiry = new Promise<never>((_resolve, reject) => {
    fire = () =>
      reject(
        new FetchDeadlineError(
          `The request did not answer within ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
  });

  try {
    return await Promise.race([
      (async (): Promise<DeadlineResponse> => {
        const response = await fetch(input, {
          ...init,
          signal: controller.signal,
        });
        const text = await response.text();
        return { ok: response.ok, status: response.status, text };
      })(),
      expiry,
    ]);
  } catch (err) {
    if (expired) {
      throw new FetchDeadlineError(
        `The request did not answer within ${Math.round(timeoutMs / 1000)}s.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
