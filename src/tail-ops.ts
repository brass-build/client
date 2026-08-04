// Tail ops arrive in one of two shapes and are used in only one.
//
// An op that fit its durable row carries its bytes inline. One that
// spilled to storage carries a short-lived signed URL instead, because a
// join response holding several megabytes of base64 is a response the
// server cannot build. Both mean the same thing to a reader: bytes to
// apply, in seq order.
//
// Resolving at the parse boundary is what keeps that difference from
// spreading. Every path that folds a tail in (a cold open, a reconnect,
// a version preview) then works on inline blobs exactly as before, and
// none of them has to be async to do it.

import { BrassError } from './errors.js';

/** A tail op as the server sends it. */
export type WireTailOp =
  | { seq: number; op_blob_b64: string }
  | { seq: number; op_blob_url: string };

/** A tail op with its bytes in hand. */
export interface ResolvedTailOp {
  seq: number;
  op_blob_b64: string;
}

function isUrlOp(op: WireTailOp): op is { seq: number; op_blob_url: string } {
  return typeof (op as { op_blob_url?: unknown }).op_blob_url === 'string';
}

/**
 * Fetch any tail op whose bytes live behind a signed URL, leaving inline
 * ops untouched, and return the tail in its original order.
 *
 * Ordering matters and concurrency does not disturb it: the fetches run
 * together but each result lands back at its own index, so the caller
 * still applies ops in ascending seq.
 *
 * A failed fetch throws rather than dropping the op. Skipping one would
 * leave the reader a document missing an edit it will never be sent
 * again, which reads as data loss; failing the join sends it back through
 * a path that can succeed.
 */
export async function resolveTailOps(
  tailOps: readonly WireTailOp[],
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedTailOp[]> {
  if (!tailOps.some(isUrlOp)) {
    return tailOps as ResolvedTailOp[];
  }
  return Promise.all(
    tailOps.map(async (op) => {
      if (!isUrlOp(op)) return op;
      // The URL is pre-signed, so it carries no Brass headers: adding one
      // would fall outside the signature and be refused.
      const response = await fetchImpl(op.op_blob_url, { method: 'GET' });
      if (!response.ok) {
        throw new BrassError('Tail op fetch failed', { status: response.status });
      }
      return { seq: op.seq, op_blob_b64: await response.text() };
    }),
  );
}
