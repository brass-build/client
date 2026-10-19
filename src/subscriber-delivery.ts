// What every handle kind shares about handing data to an app's callback.

import type { Splice } from './handle-types.js';

// The natural apply is `rows.splice(at, removed, ...inserted)`, and a spread
// passes every item as a call argument, which overflows the engine's stack
// somewhere past tens of thousands of items. A large insert is therefore
// delivered as consecutive splices, which applied in order make the same edit.
const SPLICE_MAX_INSERTED = 10_000;

export function pushBoundedSplice<E>(out: Splice<E>[], splice: Splice<E>): void {
  const { at, removed, inserted } = splice;
  if (inserted.length <= SPLICE_MAX_INSERTED) {
    out.push(splice);
    return;
  }
  for (let i = 0; i < inserted.length; i += SPLICE_MAX_INSERTED) {
    out.push({
      at: at + i,
      removed: i === 0 ? removed : 0,
      inserted: inserted.slice(i, i + SPLICE_MAX_INSERTED),
    });
  }
}

/** The error `Brass.onError` receives when an app's own callback threw while
 *  being handed a document or a change to one. The app usually shows an empty
 *  or stale view after that, so the sentence is one it can show the reader;
 *  the throw rides as `cause`. */
export function appCallbackError(err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  const report: Error & { cause?: unknown } = new Error(
    `The app could not display a change: ${detail}`,
  );
  report.cause = err;
  return report;
}
