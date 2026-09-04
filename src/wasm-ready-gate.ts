// The once-only gate the browser runtime half readies its WASM behind, kept
// separate from it so it can be exercised without a real engine: the half
// itself names a WASM-shipping dependency, which pins it to an environment
// that can load one.

/**
 * Build a function that runs `inits` once and hands every caller the same
 * result.
 *
 * A rejection is NOT retained. Each init is a multi-megabyte fetch over
 * whatever connection the reader has, and a page navigating away mid-download
 * aborts it, so a retained rejection would answer every later call with a
 * failure the network has long since recovered from. Dropping it makes the
 * next call start over, which is what a reader who opens a document a minute
 * later needs.
 */
export function createReadyGate(
  inits: readonly (() => Promise<unknown>)[],
): () => Promise<void> {
  let readying: Promise<void> | null = null;
  return () => {
    readying ??= Promise.all(inits.map((init) => init()))
      .then(() => undefined)
      .catch((err: unknown) => {
        readying = null;
        throw err;
      });
    return readying;
  };
}
