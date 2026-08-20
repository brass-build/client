// Waiting out a document's own unsaved ops.
//
// `savingCount` counts the ops this client has committed locally and the
// server has not acked, so a caller that needs the server to hold what the
// app just wrote waits on it: the import completion, and the checkpoint
// anchor, both of which describe a state rather than an intention.

import type { Document } from './documents.js';

// How often the wait re-checks. A closing document drops its subscribers
// without firing them, so this is the only thing that ends the wait for one
// that goes while writes are draining.
const SAVED_POLL_MS = 1_000;

// How long the OLDEST outstanding op may go unacked before the wait gives
// up. An op the server never received is never acked and never re-sent
// beyond the transport's own attempts, and `savingCount` then stays above
// zero for the document's life, so a wait with no bound hangs its caller
// forever. Read off the oldest op rather than off elapsed time, so a bulk
// write that takes minutes never trips it: there, every op acks promptly
// and the oldest is always young. Three forced-resend cycles wide (the
// transport forces one at 60s), so the wait outlasts the recovery it is
// waiting on.
const SAVED_STALL_MS = 180_000;

/**
 * Resolve `true` once the document has no locally-issued op waiting for its
 * server ack; `false` when the document is no longer live, or the acks
 * stopped arriving.
 *
 * `false` does not say the writes were lost, only that this wait cannot say
 * they landed. A caller about to record something permanent against them (an
 * import completion, a checkpoint anchor) has to stop on it.
 *
 * @internal
 */
export function whenSaved(doc: Document): Promise<boolean> {
  if (doc.savingCount === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let off: (() => void) | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const settle = (saved: boolean): void => {
      off?.();
      if (poll !== undefined) clearInterval(poll);
      resolve(saved);
    };
    try {
      off = doc.subscribe(() => {
        if (doc.savingCount === 0) settle(true);
      });
    } catch {
      // The document closed, so nothing more is going to be acked.
      resolve(false);
      return;
    }
    poll = setInterval(() => {
      if (doc.savingCount === 0) return settle(true);
      if (!doc._isLive) return settle(false);
      if (doc.diagnostics().oldestUnackedMs >= SAVED_STALL_MS) settle(false);
    }, SAVED_POLL_MS);
    // Node keeps the process alive for a pending interval; this one is
    // bookkeeping for a wait that ends on its own, so it must not.
    (poll as { unref?: () => void }).unref?.();
    if (doc.savingCount === 0) settle(true);
  });
}
