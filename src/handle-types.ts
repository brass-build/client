// The handle surface's public types, kept apart from the `handles.ts` code
// that implements them against Loro. Every type the package entry re-exports
// pulls its declaring module into a consumer's typecheck graph, so declaring
// them here is what makes the public surface engine-neutral all the way down
// rather than only in the signatures an app calls.
// `public-types-engine-free.test.ts` holds that line.

// What changed on a map, the first argument to a map subscriber. Reconcile
// by it: upsert every entry in `set` (it carries the new value, so reconcile
// never calls `get`), drop every key in `deleted`. The first fire carries
// the whole map as `set`, so a subscriber is one loop with no
// initial-vs-update branch. Each later fire is proportional to what the change
// wrote, never to the map's size.
export interface Change<T = unknown> {
  // Entries the change wrote, by key, with the value the map now holds for
  // them. `set` names what a change WROTE, which is a wider answer than what
  // differs: assigning a record the value it already holds names it, and above
  // the size at which a large map stores its records in groups, a mutation
  // that replaces every record of a group names every record in it. An edit of
  // one record names that record at every size. So reconcile by value and the
  // two readings agree; to attribute a change instead (highlight a peer's
  // edit, mark a record dirty, recompute per record), compare the value
  // against the one you hold and act on the entries that moved.
  readonly set: ReadonlyMap<string, T>;
  // Keys removed from the map.
  readonly deleted: readonly string[];
  // Live keys in order, present ONLY on an ordered-map fire whose order
  // changed. Re-sequence the views you hold to it; absent on a plain map and
  // on an order-preserving field edit, keeping re-sequencing off the
  // per-keystroke path.
  readonly order?: readonly string[];
}

// What produced a change: read-only metadata, the optional SECOND argument
// to a map subscriber. A render never needs it (the projection reconciles by
// value regardless of cause, which makes local / remote / undo one path);
// read it only to attribute a change, e.g. highlight a peer's edit
// (`source === 'remote'`). It says who wrote the change, and `set` says what
// the change wrote, so an attributing subscriber pairs it with the value
// comparison `set` describes.
//
// A move through version history is not among them: it swaps the whole
// container rather than writing into it, so it reaches a subscriber as a
// whole-container fire with no origin. `doc.subscribe` reports that move as
// `{ kind: 'history' }`, carrying the version it landed on.
export type ChangeSource = 'local' | 'remote' | 'undo' | 'redo';
export interface ChangeOrigin {
  readonly source: ChangeSource;
}

// A map subscriber. Fires once on registration (the whole map as
// `change.set`), then on every change. Both fires are synchronous: the
// registration fire runs before `subscribe` returns, and a change fire runs
// inside the `mutate` that caused it. So a subscriber cannot reach a `const`
// its own registration fire initialises, and work it defers to a later tick
// runs after the mutation has finished.
export type MapSubscriber<T = unknown> = (
  change: Change<T>,
  origin?: ChangeOrigin,
) => void;

// Internal (not exported): a map subscriber that also learns whether a fire is
// a whole-container catch-up (`resync: true`: registration, or a checkout /
// return-to-head / hydrate swapping the source) or an incremental delta
// (`false`). This is the "full re-sync vs incremental" distinction, ORTHOGONAL
// to `origin` (which is authorship: local / remote / undo / redo, all one path
// to a render). The ordered map needs it because a source swap can reorder
// `instance_order` with the same key set, which its key-set move test cannot
// see; keying off this explicit flag keeps that check gated to the rare
// re-sync fires without overloading `origin`. The public `subscribe` wraps an
// app `MapSubscriber` and drops the flag, so it never reaches an app.
export type InternalMapSubscriber<T> = (
  change: Change<T>,
  origin: ChangeOrigin | undefined,
  resync: boolean,
) => void;

/**
 * One positional edit, applied in the order the change carries them.
 *
 * `at` indexes the sequence as the preceding splices in the same change left
 * it, so applying them in order to what you already hold leaves you current.
 * That is the whole contract: a subscriber never has to ask what the list
 * holds, because every fire says how to get from its last state to this one.
 */
export interface Splice<E> {
  readonly at: number;
  readonly removed: number;
  readonly inserted: readonly E[];
}

/**
 * What changed in a list. Fires once on registration carrying the whole list,
 * then on every change carrying only what moved. No splice inserts more than
 * 10,000 elements, so a spread apply stays inside the engine's argument limit.
 *
 * A registration fire and a resync are not special cases a subscriber has to
 * recognise: both arrive as splices that replace what it was last told, so
 * one apply loop is the entire subscriber.
 */
export interface ListChange<T> {
  readonly splices: readonly Splice<T>[];
}

export type ListSubscriber<T = unknown> = (change: ListChange<T>) => void;

// Internal (not exported): a list subscriber that also learns what produced
// the change, so the ordered map can stamp an `order` frame its order list's
// own move produced. Undefined on a whole-container catch-up (registration, or
// a checkout / return-to-head / hydrate swapping the source), which describes
// no authored transition, matching `MapSubscriber`'s optional origin.
export type InternalListSubscriber = (
  change: ListChange<unknown>,
  origin?: ChangeOrigin,
) => void;

export type HandleUnsubscribe = () => void;

// Hooks the owning Document provides so handles participate in the SDK's
// commit + origin machinery. Defined here (not in documents.ts) so handles.ts
// has no compile-time dependency on the Document class.
export interface HandleOwner {
  // Throws if the Document is closed, suspended, or read-only.
  assertWritable(): void;
  // Throws if the Document is closed. `close()` releases the CRDT state the
  // handles read through, so a read taken after it reaches released memory and
  // fails with whatever the engine says about that. An app holds a handle
  // across a close by design (it is what a subscription is registered on), so
  // this is an ordinary race: a callback, a frame, or a settled promise
  // reading one tick after the close. The gate is what makes that answer
  // `Document is closed` in the app's own vocabulary, like a write does.
  //
  // Closed only, never suspended: a parked Document keeps its state, and its
  // reads answer from it.
  assertReadable(): void;
  // Lazily, idempotently attaches the local-updates hook before first mutate.
  ensureLocalUpdatesSubscribed(): void;
  // Stamps the next commit with the mutate origin tag and commits, so the
  // change's `origin.source` reads `'local'`.
  commitMutate(): void;
  // Runs a handle's `mutate` body, so every commit it takes carries the
  // origin `options` asks for and the reference writes queued inside it
  // commit after its last one.
  runMutate(options: MutateOptions | undefined, fn: () => void): void;
  // Classify a Loro event by what produced it. Derived from the commit's
  // `by` + origin tag, so it survives microtask-deferred delivery.
  originOf(event: unknown): ChangeSource;
  // Report an app subscriber that threw. The handle carries on delivering to
  // the others; this is how the app hears that its own callback failed.
  reportSubscriberThrow(err: unknown): void;
}

/** Options every `mutate` takes. */
export interface MutateOptions {
  /**
   * `false` keeps the write off the reader's Undo stack, for a pass the app
   * runs on its own rather than one the reader asked for. Defaults to true.
   */
  undoable?: boolean;
}

// Public handle interfaces. Concrete classes below.

export interface MapHandle<T = unknown> {
  /** Per-entry read. Returns undefined when missing. */
  get(entryKey: string): T | undefined;
  /** Keys currently in the map. */
  keys(): string[];
  /** Whether an entry exists at `entryKey`. */
  has(entryKey: string): boolean;
  /** Every `[key, value]`, as a walk. Each step hands over one entry, so a
   *  caller that does not keep them never holds the whole map at once. */
  entries(): IterableIterator<[string, T]>;
  /** Mutate through a typed JS-proxy, scoped to this container; same
   *  ergonomics as `doc.mutate(d => { d.entities[id].field = ... })`. */
  mutate(fn: (draft: Record<string, T>) => void, options?: MutateOptions): void;
  /** ONE channel for every change whatever produced it (local / remote / undo
   *  / redo / checkout): the projection reconciles by value. The callback gets
   *  `change` and optional `origin` a render ignores. Fires once on
   *  registration with the whole map as `change.set`, then on every change
   *  (each later fire proportional to what that change wrote). */
  subscribe(cb: MapSubscriber<T>): HandleUnsubscribe;
  /**
   * Report each time this container has been delivered whole: on
   * registration, and again after a version checkout, a return to head or a
   * hydrate replaces it.
   *
   * This is where the work that follows on the collection belongs rather than
   * on any single change: frame the camera on what arrived, run the first pass
   * over it. It repeats because that work is owed again each time the
   * container is replaced.
   *
   * It reports that this peer holds what it had converged to when the delivery
   * began, which is the only claim available: more always arrives afterwards.
   */
  onSettled(cb: () => void): HandleUnsubscribe;

  /** Child handle for `entries[entryKey]` when that entry is itself a map /
   *  list. Reads see empty until the container exists; the first mutate
   *  creates it, and a subscription taken before that delivers the container
   *  whole on whichever write creates it. */
  map<U>(entryKey: string): MapHandle<U>;
  list<U>(entryKey: string): ListHandle<U>;
}

/**
 * The array a list `mutate` hands its callback: an ordinary `T[]` plus
 * `move`.
 *
 * `move` is here because a plain array has no way to say "this entry is now
 * at that position", and the difference matters once two people edit at once.
 * Spelled as a removal and an insertion, a reposition merges with another
 * peer's reposition of the SAME entry by keeping BOTH insertions, so the entry
 * ends up in the list twice and a reader has to guess which position was
 * meant. `move` states the reposition, and the two merge to one entry.
 */
export interface ListDraft<T> extends Array<T> {
  /** Reposition the entry at `from` so it sits at `to`. Indices are clamped
   *  to the list, and a `from` outside it does nothing. */
  move(from: number, to: number): void;
}

export interface ListHandle<T = unknown> {
  length(): number;
  /** The element at `index`, or undefined outside the list. */
  get(index: number): T | undefined;
  /** Every element in order, as a walk. */
  values(): IterableIterator<T>;
  mutate(fn: (draft: ListDraft<T>) => void, options?: MutateOptions): void;
  /** Fires once on registration carrying the whole list, then on
   *  every change carrying only what moved, so a subscriber applies splices to
   *  what it already holds and never re-reads. A keyed collection belongs in a
   *  map (or `orderedMap`), which reconciles by key; a list is for ordering
   *  keys and small positional data. */
  subscribe(cb: ListSubscriber<T>): HandleUnsubscribe;
  /**
   * Report each time this container has been delivered whole: on
   * registration, and again after a version checkout, a return to head or a
   * hydrate replaces it.
   *
   * This is where the work that follows on the collection belongs rather than
   * on any single change: frame the camera on what arrived, run the first pass
   * over it. It repeats because that work is owed again each time the
   * container is replaced.
   *
   * It reports that this peer holds what it had converged to when the delivery
   * began, which is the only claim available: more always arrives afterwards.
   */
  onSettled(cb: () => void): HandleUnsubscribe;
}

// An ordered map: a keyed map whose key insertion order is mirrored into a
// sibling list, kept in lockstep. The record store (`instances` +
// `instance_order`) is the motivating adopter, reached as
// `doc.orderedMap('instances', 'instance_order')`, but the primitive names no
// format: two ordinary root containers bound so an app cannot forget to
// update the order list on add / remove.
//
// Add appends to the order list, delete removes from it, both in ONE commit
// (one undo step). Reassigning a key's value (a `params` edit) leaves the
// order untouched and stays O(1): only structural add / delete touches it.
// `insert` and `move` place a key somewhere other than the end.

/**
 * Where an ordered map puts a key.
 *
 * The two anchor forms name a neighbouring key, which is what a reader's
 * gesture actually means (insert after the paragraph the caret is in, drop
 * this step on that one) and what survives a peer editing the collection
 * between the render and the write. `index` counts positions in `keys()`, for
 * a surface that works in indices; anything at or past the end appends, and a
 * negative index goes to the front.
 *
 * An anchor key the order list does not name puts the key at the end.
 */
export type OrderedMapPosition =
  | { before: string }
  | { after: string }
  | { index: number };

export interface OrderedMapHandle<T = unknown> {
  /** Per-entry read. Returns undefined when missing. */
  get(entryKey: string): T | undefined;
  /** Whether an entry exists in the map. */
  has(entryKey: string): boolean;
  /** Keys in order-list order, filtered to keys still present in the map. */
  keys(): string[];
  /** Every `[key, value]` in order, as a walk. */
  entries(): IterableIterator<[string, T]>;
  /** @deprecated Use `entries()`, which walks the same records in the same
   *  order without building the array. */
  ordered(): { key: string; value: T }[];
  /** Mutate the map; the sibling order list reconciles in the same commit
   *  (new keys appended in insertion order, deleted keys pruned). Drive it
   *  like `MapHandle.mutate`: `m[key] = record`, `delete m[key]`,
   *  `m[key].field = ...`. */
  mutate(fn: (draft: Record<string, T>) => void, options?: MutateOptions): void;
  /** Write `value` under `entryKey` and put that key at `at`, both in ONE
   *  commit (one undo step) like every other structural edit here. A key the
   *  map already holds is written and repositioned rather than named twice. */
  insert(entryKey: string, value: T, at: OrderedMapPosition): void;
  /** Reposition a key the map already holds, writing the order list alone. A
   *  key the map does not hold does nothing, so a reorder racing a peer's
   *  delete of the same key leaves the delete standing. */
  move(entryKey: string, to: OrderedMapPosition): void;
  /** Fires once on registration (the whole map as `change.set` in order),
   *  then on every change. A field edit carries only `set` / `deleted`; a
   *  change that moves the order also carries `change.order` (live keys in
   *  order) so the app re-sequences the views it holds. A move the map does
   *  not see (an edit of the sibling order list, a merge that resequences
   *  keys already present) arrives as an `order` of its own with an empty
   *  `set`. Content stays proportional to what the change wrote; re-sequencing
   *  happens only when the order moves, and at most once per change. */
  subscribe(cb: MapSubscriber<T>): HandleUnsubscribe;
  /**
   * Report each time this container has been delivered whole: on
   * registration, and again after a version checkout, a return to head or a
   * hydrate replaces it.
   *
   * This is where the work that follows on the collection belongs rather than
   * on any single change: frame the camera on what arrived, run the first pass
   * over it. It repeats because that work is owed again each time the
   * container is replaced.
   *
   * It reports that this peer holds what it had converged to when the delivery
   * began, which is the only claim available: more always arrives afterwards.
   */
  onSettled(cb: () => void): HandleUnsubscribe;
}


/**
 * A handle on a top-level text container. `roots()` reports such a container
 * as kind `'text'`; this is what reads and writes one.
 *
 * Deliberately small. The record surface (`map` / `list` / `orderedMap`) is
 * where an app models its own data, and a text root is what a document
 * authored elsewhere may carry, so this covers reading it and replacing it
 * rather than growing a rich-text editing surface.
 */
export interface TextHandle {
  /** The container's current contents. */
  read(): string;
  /**
   * Replace the contents. Loro diffs against what is stored and applies the
   * smallest edit that gets there, so a concurrent edit elsewhere in the text
   * survives, where writing the whole string as one replacement would discard
   * it.
   */
  update(next: string): void;
  /** Fires once on registration with the current contents, then on every change. */
  subscribe(cb: TextSubscriber): HandleUnsubscribe;
}

// A text subscriber. Fires once on registration with the current contents,
// then on every change. `origin` carries who authored the change, the way
// `MapSubscriber`'s does, and is undefined on a fire that describes no
// authored transition (registration, and the whole-container catch-up a
// checkout or a return to head produces).
//
// A field bound to a text container needs it: the value arrives on the app's
// own keystroke as well as on a peer's, and only the two peers' fires ask
// the app to move a caret that a person is sitting in.
export type TextSubscriber = (value: string, origin?: ChangeOrigin) => void;
