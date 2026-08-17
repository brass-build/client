// Which seqs a join response actually delivered.
//
// A join carries a snapshot sealed at `snapshot_seq`, the op rows above it,
// and `current_seq`, the branch's seq counter. The counter is NOT a delivery
// claim: the server allocates a seq on it before writing that op's row, so
// while someone is writing in bulk the counter names ops whose rows the
// tail query cannot see yet. A reader that treats the counter as covered
// records itself as holding ops it was never sent, and every later prompt
// for them short-circuits on that record.
//
// What a response can vouch for is the snapshot plus the unbroken run of
// tail seqs above it. Anything past the first gap is applied but not
// covered, so it parks until the gap fills.

/** The contiguous floor a join delivered: `snapshotSeq` plus its tail run. */
export function joinCoverageFloor(
  snapshotSeq: number,
  tailSeqs: readonly number[],
): number {
  const present = new Set(tailSeqs);
  let floor = snapshotSeq;
  while (present.has(floor + 1)) floor += 1;
  return floor;
}

/**
 * Where the snapshot in a join response ends, for a response that may not
 * say. Our server always reports `snapshot_seq`; a response without it
 * (an older server, a fixture) leaves only the tail's own lower edge, which
 * is the true boundary except when the first op above the snapshot is one of
 * the rows still in flight. With no tail at all there is nothing to infer
 * from, and the counter is all that is on offer.
 */
export function snapshotSeqOf(
  reported: number | undefined,
  tailSeqs: readonly number[],
  currentSeq: number,
): number {
  if (typeof reported === 'number') return reported;
  if (tailSeqs.length === 0) return currentSeq;
  return Math.min(...tailSeqs) - 1;
}
