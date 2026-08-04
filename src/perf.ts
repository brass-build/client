// Optional load-phase timing for diagnosing document-open cost. Off by
// default and zero-cost when off, so it is safe to leave wrapped around hot
// paths in shipped code.
//
// Enable at runtime (no rebuild) from a browser console:
//   globalThis.__BRASS_PERF__ = true
// then reopen the document. Each phase prints as
//   [brass perf] <label>: <ms> ms { ...fields }
// the fields carrying the numbers that explain the cost (snapshot bytes,
// response size, op counts).

interface PerfGlobal {
  __BRASS_PERF__?: unknown;
}

function perfEnabled(): boolean {
  try {
    return Boolean((globalThis as PerfGlobal).__BRASS_PERF__);
  } catch {
    return false;
  }
}

function perfNow(): number {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Called to close a timing span; logs elapsed ms plus any fields. */
export type PerfEnd = (fields?: Record<string, unknown>) => void;

/**
 * Start a timing span. Returns an `end(fields?)` to call when the phase
 * completes. A no-op (returns a no-op `end`) when timing is disabled, so
 * callers wrap unconditionally without branching.
 */
export function perfStart(label: string): PerfEnd {
  if (!perfEnabled()) return () => {};
  const t0 = perfNow();
  return (fields) => {
    const ms = Math.round((perfNow() - t0) * 10) / 10;
    console.info(`[brass perf] ${label}: ${ms} ms`, fields ?? {});
  };
}
