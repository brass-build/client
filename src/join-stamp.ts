// The document's `updated_at` as the join that produced a copy read it. The
// join reads the document's row before its content, so this stamp is never
// later than what the copy holds.
const stamps = new WeakMap<object, string>();

export function setJoinStamp(doc: object, updatedAt: unknown): void {
  if (typeof updatedAt === 'string') stamps.set(doc, updatedAt);
}

export function joinStampOf(doc: object): string | undefined {
  return stamps.get(doc);
}
