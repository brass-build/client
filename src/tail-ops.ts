// Tail ops arrive in one of two shapes and are used in only one.
//
// An op small enough to store inline carries its bytes. A larger one
// carries a short-lived signed URL instead, because a
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
  // `op_blob_bytes` is what this entry costs to fetch, which is what lets a
  // load know the whole of its download before it starts one. Optional
  // because a server that predates it names no size, and a total built from
  // what is named is still better than none.
  | { seq: number; op_blob_url: string; op_blob_bytes?: number };

/** A tail op with its bytes in hand. */
export interface ResolvedTailOp {
  seq: number;
  op_blob_b64: string;
}

function isUrlOp(op: WireTailOp): op is { seq: number; op_blob_url: string } {
  return typeof (op as { op_blob_url?: unknown }).op_blob_url === 'string';
}

/**
 * What the spilled entries in this tail say they will cost to fetch.
 *
 * Read before any of them is fetched, so a load can state the whole of what it
 * is about to download rather than discovering it. An entry naming no size
 * counts zero, which understates the total: a bar that finishes early is a
 * worse answer than one that never moves, and a much better one than a bar
 * that goes backwards when the rest arrives.
 */
export function declaredTailBytes(tailOps: readonly WireTailOp[]): number {
  let total = 0;
  for (const op of tailOps) {
    if (!isUrlOp(op)) continue;
    const declared = (op as { op_blob_bytes?: unknown }).op_blob_bytes;
    if (typeof declared === 'number' && declared > 0) total += declared;
  }
  return total;
}

/**
 * How many spilled ops a join fetches at once.
 *
 * A browser refuses to open an unbounded number of sockets: past a few
 * hundred in flight it fails the rest of them outright with
 * `ERR_INSUFFICIENT_RESOURCES`, which arrives as a rejected fetch and
 * fails the whole join. Chrome's own per-host cap is 6, so a higher bound
 * here only queues inside the browser; this is low enough to stay clear of
 * the failure and high enough that the queue drains at the connection
 * limit rather than the loop's.
 */
const TAIL_FETCH_CONCURRENCY = 8;

/**
 * Fetch any tail op whose bytes live behind a signed URL, leaving inline
 * ops untouched, and return the tail in its original order.
 *
 * Ordering matters and concurrency does not disturb it: each result lands
 * back at its own index, so the caller still applies ops in ascending seq.
 *
 * A failed fetch throws rather than dropping the op. Skipping one would
 * leave the reader a document missing an edit it will never be sent
 * again, which reads as data loss; failing the join sends it back through
 * a path that can succeed.
 */
export async function resolveTailOps(
  tailOps: readonly WireTailOp[],
  fetchImpl: typeof fetch = fetch,
  // Told how many BYTES of the spilled ops are in hand, as each lands. A
  // document whose tail spilled fetches hundreds of objects here, eight at a
  // time, inside the join and before anything else reports: without this the
  // whole stretch is silent, and a load that is working looks exactly like one
  // that has hung.
  //
  // Bytes rather than objects because this is half of one download, not a
  // stage of its own. The snapshot that follows is measured in bytes, and a
  // reader watching a load has no use for the distinction between an op that
  // spilled and the snapshot it will be folded into.
  onProgress?: (loadedBytes: number) => void,
): Promise<ResolvedTailOp[]> {
  const spilled = tailOps.filter(isUrlOp).length;
  if (spilled === 0) {
    return tailOps as ResolvedTailOp[];
  }
  const out: ResolvedTailOp[] = Array.from({ length: tailOps.length });
  let loadedBytes = 0;
  onProgress?.(0);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= tailOps.length) return;
      const op = tailOps[i]!;
      if (!isUrlOp(op)) {
        out[i] = op;
        continue;
      }
      // The URL is pre-signed, so it carries no Brass headers: adding one
      // would fall outside the signature and be refused.
      const response = await fetchImpl(op.op_blob_url, { method: 'GET' });
      if (!response.ok) {
        throw new BrassError('Tail op fetch failed', { status: response.status });
      }
      const body = await response.text();
      out[i] = { seq: op.seq, op_blob_b64: body };
      loadedBytes += body.length;
      onProgress?.(loadedBytes);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TAIL_FETCH_CONCURRENCY, tailOps.length) }, () =>
      worker(),
    ),
  );
  return out;
}
