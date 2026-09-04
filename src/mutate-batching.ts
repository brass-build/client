// Committing a very large mutation as it goes, so an app can write a
// file's worth of records through the same `mutate` it uses for one.
//
// Encoding a commit costs more per record the more containers that commit
// creates: 20,000 records in one commit take ~60s and produce an op too
// large to store, where the same records committed every ~500 take under
// 3s (`scripts/bench/`). Above the budget below, a mutation therefore
// commits and continues.
//
// The consequence a caller can observe is that peers receive such a write
// as several updates instead of one, so they can see it part-applied. It
// converges normally and stays one undo step.

// A batch closes once the values assigned since the last commit reach
// roughly this much JSON, so op size tracks the budget rather than the
// mutation, for narrow and wide records alike.
//
// The budget answers to STORAGE, not to the socket: an op past the frame cap
// takes the HTTP write, which carries about 190x a frame. What storage meters
// is op COUNT: each op costs the same bookkeeping whatever its size, and
// takes a place in the join's tail budget. Measured on a
// 500,000-element write, 48 KB produces 526 ops and 512 KB produces 158, past
// which the budget stops binding for that shape, while encode time stays flat
// throughout: a smaller budget spends op count and buys nothing.
export const MUTATE_BATCH_JSON_BUDGET_CHARS = 512 * 1024;

/** Rough size of one assigned value. Runs on every assignment, so it only
 *  has to be proportional; an unserializable value counts as nominal
 *  rather than throwing, since the assignment itself is where that error
 *  belongs. */
function approximateChars(value: unknown): number {
  if (value === null || value === undefined) return 8;
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return 8;
  if (t === 'string') return (value as string).length + 2;
  try {
    return JSON.stringify(value)?.length ?? 64;
  } catch {
    return 64;
  }
}

/**
 * Decides when a mutation should commit. The caller supplies what a commit
 * means, since an ordered map reconciles its order list first.
 */
export class MutateBatcher {
  private _chars = 0;
  // The record keys whose writes have landed since the last commit, handed to
  // the flush so a caller with something to land BESIDE those records (an
  // ordered map's order entries) can name exactly the ones this commit
  // carries. A paged write assembles its whole overlay before it writes any of
  // it, so the mutation's added keys are all known by the time the first
  // commit comes round; without this the order list would be appended whole at
  // that first commit, which is the oversized op the split exists to avoid.
  private _keys: string[] = [];
  // Run just before each commit. A paged write registers one here to seal
  // the pages it has accumulated, so they ride the same commit rather than
  // arriving after it.
  private _before: (() => void) | null = null;

  constructor(private readonly _flush: (keys: readonly string[]) => void) {}

  /** Register work to run immediately before every commit this batcher
   *  takes, including the caller's final one via `flushNow`. */
  onFlush(before: () => void): void {
    this._before = before;
  }

  /** Name the record keys a write that has just landed covers. Called AFTER
   *  the write, so a key is never named to a commit that precedes it. */
  noteKeys(keys: Iterable<string>): void {
    for (const key of keys) this._keys.push(key);
  }

  /** Account for one assignment, from the proxy's set trap. */
  record(value: unknown): void {
    this.recordChars(approximateChars(value));
  }

  /** Account for a write whose caller already knows its size in the same
   *  unit `record` charges, the UNCOMPRESSED JSON the write carries.
   *
   *  A page is stored gzipped, so charging the bytes it occupies would price
   *  the same records about five times cheaper than the map path prices them,
   *  and the same write would produce ops an order of magnitude apart
   *  depending on whether the store was already paged when it arrived. The
   *  budget answers for the records a commit carries, so a page charges what
   *  it packs. */
  recordChars(chars: number): void {
    // Commit BEFORE adding, so one assignment larger than the whole budget
    // lands in a batch of its own instead of dragging its neighbours over
    // the line with it.
    if (this._chars > 0 && this._chars + chars > MUTATE_BATCH_JSON_BUDGET_CHARS) {
      this._before?.();
      const keys = this._keys;
      this._keys = [];
      this._flush(keys);
      this._chars = 0;
    }
    this._chars += chars;
  }

  /** Account for one deletion. What a delete puts in the op is its KEY, so
   *  that is what it costs: charging a flat nominal instead prices a bulk
   *  delete at a fraction of the bytes it writes, and a store big enough to
   *  page is big enough for the difference to carry the whole delete into one
   *  op. */
  recordDelete(key: string): void {
    this.record(key);
  }
}
