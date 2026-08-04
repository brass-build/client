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
// roughly this much JSON, which keeps each op in the tens of KB: an
// encoded op runs close to the JSON length of its values, and base64 adds
// a third. Budgeting on size rather than on a record count is what keeps
// that true for narrow and wide records alike, so where it splits depends
// on width (measured: ~800 spreadsheet cells, ~200 wider rows).
export const MUTATE_BATCH_JSON_BUDGET_CHARS = 48 * 1024;

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

  constructor(private readonly _flush: () => void) {}

  /** Account for one assignment, from the proxy's set trap. */
  record(value: unknown): void {
    const chars = approximateChars(value);
    // Commit BEFORE adding, so one assignment larger than the whole budget
    // lands in a batch of its own instead of dragging its neighbours over
    // the line with it.
    if (this._chars > 0 && this._chars + chars > MUTATE_BATCH_JSON_BUDGET_CHARS) {
      this._flush();
      this._chars = 0;
    }
    this._chars += chars;
  }

  recordDelete(): void {
    this.record(null);
  }
}
