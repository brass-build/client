// Typed container handles. A handle is a scoped reference to a container in
// the CRDT doc; its `read` / `mutate` / `subscribe` only see (and only pay
// for) that container.
//
// Engine-neutral: Loro events are translated to a minimal `Change` shape at
// the handle boundary, so handle-only app code does not pin the SDK to Loro.

import {
  LoroMovableList,
  LoroMap,
  type LoroEventBatch,
  isContainer,
  type Delta,
} from 'loro-crdt';

import {
  PAGE_TAG,
  UNPAGED_MAX_RECORDS,
  PAGE_KEYS_FIELD,
  type EncodedPage,
  type RecordLocationSink,
  assertUsableRecordKey,
  classifyStoreKey,
  decodePageKeys,
  decodePageRecords,
  decodeRecordValue,
  encodePage,
  flattenPagedLookup,
  isReservedKey,
  overlayKeyFor,
  packWholeValue,
  parseSessionPageKey,
  repackRecord,
  parsePatchKey,
  patchKeyFor,
  type RecordPatch,
  applyRecordPatches,
  recordsPerPage,
  sampleBodyBytes,
  sessionPageKey,
  tombstoneKeyFor,
  unpackRecord,
} from './record-paging.js';
import { MutateBatcher } from './mutate-batching.js';

import type {
  ListChange,
  Splice,
  Change,
  ChangeOrigin,
  ChangeSource,
  HandleOwner,
  HandleUnsubscribe,
  InternalListSubscriber,
  InternalMapSubscriber,
  ListDraft,
  ListHandle,
  ListSubscriber,
  MapHandle,
  MapSubscriber,
  OrderedMapHandle,
  OrderedMapPosition,
} from './handle-types.js';

export type {
  Change,
  ChangeOrigin,
  ChangeSource,
  HandleOwner,
  ListDraft,
  HandleUnsubscribe,
  ListHandle,
  ListSubscriber,
  MapHandle,
  MapSubscriber,
  OrderedMapHandle,
  OrderedMapPosition,
};

// ---- Plain-JS-proxy machinery, scoped per-container --------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    (v as { constructor?: unknown }).constructor === Object
  );
}

// A value being assigned may be a live Loro container handle (a nested list
// read back through `m[key].listField`, or a nested-map proxy). Re-inserting
// an already-attached handle as a value corrupts it: it lands as an opaque
// reference and is lost on the next snapshot. Materialize it to a deep plain
// value first, so the assign path rebuilds it as a fresh container.
function materializeContainers(v: unknown): unknown {
  return isContainer(v) ? (v as { toJSON(): unknown }).toJSON() : v;
}

// Deep-plain conversion for structures stored as plain Loro VALUES: any
// nested container handle or wrapped proxy materialises to pure JSON, and
// `undefined` entries drop (the documented JSON-serialise semantics of
// `mutate`).
function toPlainDeep(v: unknown): unknown {
  if (isContainer(v)) return (v as { toJSON(): unknown }).toJSON();
  if (Array.isArray(v)) return v.map(toPlainDeep);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x !== undefined) out[k] = toPlainDeep(x);
    }
    return out;
  }
  return v;
}

/**
 * One live map entry as a plain value: a container through `toJSON`, any other
 * value passed through.
 *
 * Every container kind is materialised, not just the two a record is usually
 * written as: what a key holds is the app's choice, so an array under a record
 * key arrives as a `LoroMovableList`, and a raw handle fails the tests a caller makes
 * of it while the bulk read of the same store hands back a plain value.
 *
 * Returns the handle to wasm once the plain value is out. `m.get` mints a new
 * wasm-bindgen handle every call, finalisation lags allocation, and wasm linear
 * memory never shrinks, so a handle left undropped is held until the tab
 * closes. This runs on every keyed read and every subscriber fire, so the
 * arithmetic reaches tens of MB over a working session.
 */
function plainEntry(m: LoroMap, key: string): unknown {
  const v = m.get(key);
  if (!isContainer(v)) return v;
  const container = v as { toJSON(): unknown; free(): void };
  try {
    return container.toJSON();
  } finally {
    container.free();
  }
}

/** Whether a key is set, without keeping the handle the read minted. A
 *  presence check discards the value, so the handle is pure waste; it is
 *  still a handle, and this runs once per key on an ordered-map write. */
function entryExists(m: LoroMap, key: string): boolean {
  const v = m.get(key);
  if (v === undefined) return false;
  if (isContainer(v)) (v as { free(): void }).free();
  return true;
}

function assignPlain(target: LoroMap, value: Record<string, unknown>): void {
  // Recursively materialize nested objects / arrays as nested LoroMap /
  // LoroMovableList containers so the CRDT mirrors the JS shape. Clear keys not in
  // `value` so assignment is a replace, not a merge (property-level patching
  // uses `d.entities[id].x = ...`).
  for (const k of target.keys()) {
    if (!(k in value)) target.delete(k);
  }
  for (const [k, rawV] of Object.entries(value)) {
    assignEntry(target, k, rawV);
  }
}

// Write one value at one map key, in the shape that key should hold: a nested
// object / array becomes a child container mirroring the JS shape, anything
// else a plain value. The single definition of what assigning to a map entry
// means, shared by `assignPlain` and the mutate proxy's set trap, so the two
// cannot disagree about the shape a value lands in.
function assignEntry(target: LoroMap, key: string, rawValue: unknown): void {
  const value = materializeContainers(rawValue);
  const existing = target.get(key);
  // Plain-VALUE preservation: when the key holds a plain (non-container)
  // object or array, the new structure is written as a plain value too, never
  // promoted. This keeps a record body (`rec.params`, one JSON value whose
  // whole-replace is the merge unit) a value across edits; promoting it would
  // change the merge granularity and bloat the snapshot with per-element
  // containers.
  if (
    existing !== undefined &&
    !isContainer(existing) &&
    typeof existing === 'object' &&
    existing !== null &&
    typeof value === 'object' &&
    value !== null
  ) {
    target.set(key, toPlainDeep(value) as never);
    return;
  }
  if (isPlainObject(value)) {
    // Reuse an existing LoroMap at this key: a fresh `setContainer` mints a
    // new container ID, which under Loro's UndoManager is a structural
    // destroy+create that does NOT merge within the merge window. In-place
    // field overwrites DO merge, which whole-entity-rewrites-at-drag-cadence
    // expects.
    const sub =
      existing instanceof LoroMap
        ? existing
        : target.setContainer(key, new LoroMap());
    assignPlain(sub, value);
  } else if (Array.isArray(value)) {
    const sub =
      existing instanceof LoroMovableList
        ? existing
        : target.setContainer(key, new LoroMovableList());
    assignList(sub, value);
  } else {
    target.set(key, value as never);
  }
}

function assignList(target: LoroMovableList, value: readonly unknown[]): void {
  // Assigning a whole array writes the positions that differ, in place. Two
  // properties come out of that, and the second is why a position is SET
  // rather than deleted and re-inserted.
  //
  // A position already holding the value needs no op at all. Re-assigning an
  // array is how an app states an edit to one of its rows (`rows[1].n = 2;
  // m.rows = rows`), so most positions are unchanged, and an op written for an
  // unchanged one is both a container a peer's concurrent field edit is
  // detached from and one more thing for it to resolve against.
  //
  // A position that DOES differ is set, which is one op naming that position.
  // Deleting and re-inserting states the same intent to a movable list, but
  // the delete and the insert commute with a peer's concurrent write to the
  // same position, so the pair leaves the entry stored twice while `set`
  // leaves it stored once. That is the same reasoning `assignListPosition`
  // carries, and a whole-array assign is the write that reaches it most.
  const oldLen = target.length;
  for (let i = 0; i < value.length; i++) {
    const item = materializeContainers(value[i]);
    if (i >= oldLen) {
      insertListAt(target, i, item);
      continue;
    }
    if (samePlainValue(plainListItem(target, i), item)) continue;
    assignListPosition(target, i, item);
  }
  if (value.length < oldLen) {
    target.delete(value.length, oldLen - value.length);
  }
}

/** Whether a position already holds this value, so assigning it writes
 *  nothing. Compared as plain data, which is the form both sides are already
 *  in: the stored side through `toJSON`, the incoming side as the app wrote
 *  it. A pair that differs only in key ORDER compares unequal and is
 *  rewritten, which costs an op and stores the same thing. */
function samePlainValue(stored: unknown, next: unknown): boolean {
  if (stored === next) return true;
  if (
    stored === null ||
    next === null ||
    typeof stored !== 'object' ||
    typeof next !== 'object'
  ) {
    return false;
  }
  return JSON.stringify(stored) === JSON.stringify(next);
}

// Insert one value at `idx` (same plain-vs-container handling as the indexed-
// set trap). The proxy's native mutators build on this so an insertion costs
// one op at one position instead of a full-list replay.
function insertListAt(target: LoroMovableList, idx: number, rawItem: unknown): void {
  const item = materializeContainers(rawItem);
  if (isPlainObject(item)) {
    const child = target.insertContainer(idx, new LoroMap());
    assignPlain(child, item);
  } else if (Array.isArray(item)) {
    const child = target.insertContainer(idx, new LoroMovableList());
    assignList(child, item);
  } else {
    target.insert(idx, item as never);
  }
}

function insertListTail(target: LoroMovableList, rawItem: unknown): void {
  insertListAt(target, target.length, rawItem);
}

// Replace what an EXISTING position holds, in one op at that position.
//
// A movable list can set a position, where a plain one has to delete and
// insert. That matters beyond op count: the delete and the insert commute with
// a peer's concurrent write to the same position, so the pair leaves the entry
// stored twice, and `set` leaves it stored once.
function assignListPosition(
  target: LoroMovableList,
  idx: number,
  rawItem: unknown,
): void {
  const item = materializeContainers(rawItem);
  if (isPlainObject(item)) {
    const child = target.setContainer(idx, new LoroMap());
    assignPlain(child, item);
  } else if (Array.isArray(item)) {
    const child = target.setContainer(idx, new LoroMovableList());
    assignList(child, item);
  } else {
    target.set(idx, item as never);
  }
}

/** One element as plain data, for a mutator's return value. */
function plainListItem(target: LoroMovableList, idx: number): unknown {
  const v = target.get(idx);
  if (isContainer(v)) return (v as { toJSON(): unknown }).toJSON();
  return v;
}

/**
 * A record's BODY, wrapped so writing a field inside it lands.
 *
 * A body is one plain JSON value, not a container, so reading it hands back
 * an ordinary object. Without this, `m[key].params.height = 3` mutates that
 * object and stops there: nothing is written, and nothing says so, which is
 * the shape of every field edit a developer would reach for first. The write
 * is rebuilt into a copy and pushed back through `commit`, which reassigns
 * the whole body, so the record stays the merge unit exactly as an explicit
 * `m[key].params = {...}` does.
 *
 * Only objects and arrays are wrapped, and only as they are reached, so a
 * mutation that assigns without reading allocates nothing.
 *
 * The traps compose on ONE working copy rather than deriving a fresh copy of
 * the original per write. An array mutator (`push`, `splice`, `sort`,
 * `reverse`) writes several properties in sequence, each reading what the
 * last one left, so a per-write copy keeps only the final assignment and
 * commits an array that was never asked for: `push` on `[1,2,3]` writes index
 * 3 and then `length`, and the `length` write derived from the original
 * commits `[1,2,3,<empty>]`. The working copy is shallow and every write
 * replaces rather than mutates in place, so the value handed in is never
 * touched.
 */
function writeThroughBody(
  value: unknown,
  commit: (next: unknown) => void,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const working: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? ([...value] as unknown[])
    : ({ ...(value as Record<string, unknown>) } as Record<string, unknown>);
  const snapshot = (): Record<string, unknown> | unknown[] =>
    Array.isArray(working)
      ? ([...working] as unknown[])
      : ({ ...working } as Record<string, unknown>);
  return new Proxy(working as object, {
    get(target, prop, receiver) {
      const inner: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol') return inner;
      if (inner === null || typeof inner !== 'object') return inner;
      return writeThroughBody(inner, (next) => {
        (working as Record<string, unknown>)[prop] = next;
        commit(snapshot());
      });
    },
    set(_target, prop, next: unknown) {
      if (typeof prop === 'symbol') return false;
      (working as Record<string, unknown>)[prop] = next;
      commit(snapshot());
      return true;
    },
    deleteProperty(_target, prop) {
      if (typeof prop === 'symbol') return false;
      delete (working as Record<string, unknown>)[prop];
      commit(snapshot());
      return true;
    },
  });
}

/**
 * Where a root map's ADDITIONS go once the map has paged itself part-way
 * through a mutation.
 *
 * A mutation large enough to need paging usually starts against a map that
 * is not yet paged, so the decision cannot be made once at the top. The
 * proxy consults this on every assignment; while it declines, the mutation
 * runs exactly as an unpaged one does.
 */
interface WriteDivert {
  // Take an assignment, or decline it so it goes into the map as usual. A
  // key the map already stores is always declined: it is an edit, and the
  // record it edits is not this writer's to move.
  take(key: string, value: unknown): boolean;
  // Whether a taken assignment is being held for `key`, so the mutation's
  // own later reads see what it just wrote.
  holds(key: string): boolean;
  peek(key: string): unknown;
  drop(key: string): void;
  keys(): string[];
}

// Exported because `Document.mutate` reuses the same proxy for its
// `entities` root. Load-bearing: `getOwnPropertyDescriptor` does a single
// `loroMap.get(key)` (O(1) per key, so `Object.keys()` is O(N)). Iterating
// `loroMap.keys()` in the descriptor trap makes `Object.keys()` O(N^2) at
// 50k entities (measured at >5 min of CPU before giving up).
export function wrapLoroMapProxy(
  loroMap: LoroMap,
  // Threaded into nested record proxies too, so a field edit counts. A
  // mutation can hold thousands of them (`m[id].params = ...` in a loop),
  // which reaches the same size a bulk write does while touching no
  // top-level key.
  batcher?: MutateBatcher,
  divert?: WriteDivert,
  // Whether this map's keys are RECORD keys, and so must stay out of the
  // reserved space the store's own bookkeeping occupies. True for a root map,
  // which is what can page; false inside a record, whose field names are the
  // app's own and constrained by nothing.
  guardKeys = false,
): Record<string, unknown> {
  const handler: ProxyHandler<object> = {
    get(_t, key) {
      if (typeof key === 'symbol') return undefined;
      if (divert?.holds(key)) {
        const held = divert.peek(key);
        if (held === null || typeof held !== 'object') return held;
        return writeThroughBody(held, (next) => {
          // Charged like the set trap's own assignment: a record filled field
          // by field (`m[id] = {}` then `m[id].params = ...`) reaches the
          // divert through here and nowhere else, so without this it is
          // charged only whatever its first assigned value was and a bulk
          // write built that way rides ops sized by the mutation.
          batcher?.record(next);
          divert.take(key, next);
        });
      }
      const v = loroMap.get(key);
      if (!isContainer(v) && v !== null && typeof v === 'object') {
        // A plain object / array body: hand back a view that writes a field
        // edit through, rather than a detached copy that swallows it.
        return writeThroughBody(v, (next) => {
          handler.set!(_t, key, next, _t);
        });
      }
      if (isContainer(v)) {
        // Present an engine-neutral view, never the raw container, so app
        // code can't take a hard dependency on the CRDT engine. A LoroMap
        // recurses into another proxy; a LoroMovableList reads back via `toJSON`
        // (not `toArray`, which is shallow and hands back live element
        // handles that corrupt on reassignment; list editing goes through
        // `parent.list(key).mutate(...)`). Other container types are outside
        // the v1 portable surface, so project them via toJSON().
        if (v instanceof LoroMap) return wrapLoroMapProxy(v, batcher);
        if (v instanceof LoroMovableList) return v.toJSON();
        return (v as { toJSON(): unknown }).toJSON();
      }
      return v;
    },
    set(_t, key, value) {
      if (typeof key === 'symbol') return false;
      if (guardKeys) assertUsableRecordKey(key);
      // Before the write, so a commit it triggers seals the preceding
      // batch rather than splitting this record out of it.
      batcher?.record(value);
      if (divert?.take(key, value)) return true;
      assignEntry(loroMap, key, value);
      // Named to the batcher AFTER the write, never before: `record` above
      // may have committed the batch this call arrived in, and a key named
      // to that commit would be one whose write the commit does not carry.
      batcher?.noteKeys([key]);
      return true;
    },
    deleteProperty(_t, key) {
      if (typeof key === 'symbol') return false;
      if (guardKeys) assertUsableRecordKey(key);
      batcher?.recordDelete(key);
      divert?.drop(key);
      loroMap.delete(key);
      batcher?.noteKeys([key]);
      return true;
    },
    has(_t, key) {
      if (typeof key === 'symbol') return false;
      if (divert?.holds(key)) return true;
      return loroMap.get(key) !== undefined;
    },
    ownKeys() {
      if (!divert) return loroMap.keys();
      return [...new Set([...loroMap.keys(), ...divert.keys()])];
    },
    getOwnPropertyDescriptor(_t, key) {
      if (typeof key === 'symbol') return undefined;
      if (divert?.holds(key)) {
        return {
          enumerable: true,
          configurable: true,
          writable: true,
          value: divert.peek(key),
        };
      }
      // Single get per key. Do NOT iterate `loroMap.keys()` here: it makes
      // Object.keys() O(N^2) at 50k entities.
      const v = loroMap.get(key);
      if (v === undefined) return undefined;
      return {
        enumerable: true,
        configurable: true,
        writable: true,
        value: v,
      };
    },
  };
  return new Proxy({}, handler) as Record<string, unknown>;
}

// Array.prototype methods that mutate in place, applied to the container as
// the targeted edits they are rather than replayed over it.
//
// The list stores as a `LoroMovableList`, so a reposition is `move(from, to)`
// and a replacement is `set(pos, value)`, both of which name the position they
// touch. That keeps the ENTRY the merge unit: two peers reordering different
// entries commute, and two reordering the same one converge on a list holding
// it once, where a delete-plus-insert replay leaves it named twice. Each edit
// is also its own op, so the commit budget bounds these the way it bounds
// every other list write.
//
// `push` is fast-pathed natively above the generic fallback and never reaches
// this set; every other array method is a pure read.
const REORDERING_ARRAY_METHODS: ReadonlySet<string> = new Set([
  'sort',
  'reverse',
]);
const REPLACING_ARRAY_METHODS: ReadonlySet<string> = new Set([
  'fill',
  'copyWithin',
]);

/**
 * Bring the container's order to `want` using moves, comparing by identity of
 * the values already stored.
 *
 * A permutation is applied front to back: at each position, find where the
 * wanted entry currently sits and move it up. Every entry lands in one move at
 * most, and a position already correct costs nothing, so a `sort` over a
 * nearly-ordered list writes nearly nothing.
 *
 * Duplicate values are matched left to right from the first position not yet
 * settled, which is what keeps a list holding the same value twice from
 * collapsing onto one of them.
 */
function applyOrder(
  target: LoroMovableList,
  want: readonly unknown[],
  batcher?: MutateBatcher,
): void {
  const current = target.toJSON() as unknown[];
  const print = (v: unknown): string => JSON.stringify(v) ?? 'undefined';
  // Where each value still sits, in order, so a lookup does not rescan.
  const positions = new Map<string, number[]>();
  for (let i = 0; i < current.length; i += 1) {
    const k = print(current[i]);
    const at = positions.get(k);
    if (at) at.push(i);
    else positions.set(k, [i]);
  }
  for (let i = 0; i < want.length && i < current.length; i += 1) {
    const k = print(want[i]);
    const at = positions.get(k);
    if (!at || at.length === 0) continue;
    // The leftmost occurrence at or after `i`; anything before it is settled.
    let pick = -1;
    for (let j = 0; j < at.length; j += 1) {
      if (at[j]! >= i) {
        pick = j;
        break;
      }
    }
    if (pick === -1) continue;
    const from = at[pick]!;
    at.splice(pick, 1);
    if (from === i) continue;
    // A move costs the entry, not the list, so it is charged like one write.
    batcher?.record(want[i]);
    target.move(from, i);
    // Everything between the destination and the source shifted up by one.
    for (const list of positions.values()) {
      for (let j = 0; j < list.length; j += 1) {
        const p = list[j]!;
        if (p >= i && p < from) list[j] = p + 1;
      }
    }
  }
}

// An array-proxy for list mutators: index assignments, `.push` / `.splice`,
// and length-set route into the underlying LoroMovableList so the user writes
// idiomatic JS. Reads delegate to a fresh snapshot per access so a sequence
// of reads inside the mutator sees each write.
function wrapLoroListProxy(
  loroList: LoroMovableList,
  // Threaded into nested element proxies too, so a field edit inside an
  // element counts. A list takes the same bulk writes a map does (an app
  // building rows, the record store's own order list), and nothing else bounds
  // what one call puts in a single op.
  batcher?: MutateBatcher,
): unknown[] {
  const handler: ProxyHandler<unknown[]> = {
    get(_t, key) {
      if (key === 'length') return loroList.length;
      if (typeof key === 'symbol') {
        // `toJSON` (deep-plain), not `toArray` (shallow), so iterating the
        // draft (`for (const c of l)`, `[...l]`) yields plain objects an app
        // can read fields off, matching the array-method snapshot below.
        return (loroList.toJSON() as unknown as Record<symbol, unknown>)[key];
      }
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        const idx = Number(key);
        const v = loroList.get(idx);
        if (isContainer(v)) {
          // Engine-neutral view only (see the map proxy's get trap).
          if (v instanceof LoroMap) return wrapLoroMapProxy(v, batcher);
          if (v instanceof LoroMovableList) return v.toJSON();
          return (v as { toJSON(): unknown }).toJSON();
        }
        if (v !== null && typeof v === 'object') {
          // A plain object / array element, the same case the map proxy
          // wraps: hand back a view that writes a field edit through instead
          // of a detached copy that swallows it.
          //
          // The write-back replaces the element as a plain VALUE rather than
          // going through the `set` trap, which promotes a plain object to a
          // container. Promoting here would change what merges on a field
          // edit, and a field edit is exactly the operation that should not
          // move the merge boundary.
          //
          // `set` rather than a delete plus an insert, for the reason
          // `assignListPosition` carries: the pair commutes with a peer's
          // concurrent write to this position and leaves the element stored
          // twice. `set` takes a plain value, so it keeps the shape this
          // branch exists to preserve.
          return writeThroughBody(v, (next) => {
            batcher?.record(next);
            if (idx < loroList.length) loroList.set(idx, next as never);
            else loroList.insert(idx, next as never);
          });
        }
        return v;
      }
      // Reposition an entry, which is the operation a plain array cannot
      // state: spelled as a removal plus an insertion it merges with a peer's
      // reposition of the same entry by keeping both insertions, and the entry
      // ends up in the list twice.
      if (key === 'move') {
        return (rawFrom: unknown, rawTo: unknown) => {
          const len = loroList.length;
          const from = Math.trunc(Number(rawFrom));
          let to = Math.trunc(Number(rawTo));
          if (!Number.isFinite(from) || from < 0 || from >= len) return;
          if (!Number.isFinite(to)) return;
          to = to < 0 ? Math.max(len + to, 0) : Math.min(to, len - 1);
          if (to === from) return;
          // A move writes one entry, so it is charged like one write.
          batcher?.record(plainListItem(loroList, from));
          loroList.move(from, to);
        };
      }
      // `push` is the hot path (the ordered-map primitive appends every new
      // key through it; apps bulk-build lists with it), so append natively.
      // The toArray + replay below is O(list) PER call, turning N appends
      // into O(N^2) and faulting Loro at a few thousand keys; a tail insert
      // is O(1).
      if (key === 'push') {
        return (...items: unknown[]) => {
          for (const item of items) {
            // Before the write, so a commit it triggers seals the preceding
            // batch rather than splitting this element out of it.
            batcher?.record(item);
            insertListTail(loroList, item);
          }
          return loroList.length;
        };
      }
      // The mutators that name the positions they touch, so each writes those
      // positions and leaves the rest of the list alone. This is what keeps an
      // element the merge unit: two peers removing different entries produce
      // two targeted deletes that commute, where a replay of the whole list
      // from each produces two full re-insertions that both survive.
      if (key === 'splice') {
        return (...args: unknown[]) => {
          if (args.length === 0) return [];
          const len = loroList.length;
          const rawStart = Number(args[0]);
          let start = Number.isFinite(rawStart) ? Math.trunc(rawStart) : 0;
          start = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
          const deleteCount =
            args.length === 1
              ? len - start
              : Math.min(
                  Math.max(Math.trunc(Number(args[1])) || 0, 0),
                  len - start,
                );
          // Read before writing, so the return value matches Array#splice.
          const removed: unknown[] = [];
          for (let i = 0; i < deleteCount; i += 1) {
            removed.push(plainListItem(loroList, start + i));
          }
          const items = args.slice(2);
          // A splice that removes and inserts over the same positions is a
          // REPLACEMENT of them, which `l.splice(i, 1, x)` is the common way
          // to write. Setting each such position states that as one op naming
          // it, where deleting the run and re-inserting states it as a pair
          // that commutes with a peer's concurrent write to the same position
          // and leaves both entries stored. Only the part of the splice that
          // genuinely changes the list's length is a delete or an insert.
          const replaced = Math.min(deleteCount, items.length);
          for (let i = 0; i < replaced; i += 1) {
            batcher?.record(items[i]);
            assignListPosition(loroList, start + i, items[i]);
          }
          if (deleteCount > replaced) {
            loroList.delete(start + replaced, deleteCount - replaced);
          }
          for (let i = replaced; i < items.length; i += 1) {
            batcher?.record(items[i]);
            insertListAt(loroList, start + i, items[i]);
          }
          return removed;
        };
      }
      if (key === 'pop') {
        return () => {
          const len = loroList.length;
          if (len === 0) return undefined;
          const last = plainListItem(loroList, len - 1);
          loroList.delete(len - 1, 1);
          return last;
        };
      }
      if (key === 'shift') {
        return () => {
          if (loroList.length === 0) return undefined;
          const first = plainListItem(loroList, 0);
          loroList.delete(0, 1);
          return first;
        };
      }
      if (key === 'unshift') {
        return (...items: unknown[]) => {
          for (let i = 0; i < items.length; i += 1) {
            batcher?.record(items[i]);
            insertListAt(loroList, i, items[i]);
          }
          return loroList.length;
        };
      }
      // Remaining array methods: bind to a deep-plain `toJSON` snapshot so a
      // callback reading an element's fields (`findIndex((c) => c.id === x)`,
      // `find`, `filter`, `map`) sees plain objects, not the raw child
      // containers `toArray` hands back (whose fields read undefined). A pure
      // read writes nothing back, so a `find` inside a mutate leaves the list
      // alone.
      const arr = loroList.toJSON() as unknown[];
      const val = (arr as unknown as Record<string | symbol, unknown>)[key];
      if (typeof val === 'function') {
        return (...args: unknown[]) => {
          const fn = val as (...a: unknown[]) => unknown;
          const result = fn.apply(arr, args);
          // The mutators run against the snapshot to decide the answer, then
          // that answer is applied to the container as the edits it implies:
          // moves for a reorder, a set per position for a replacement. What
          // reaches the document is the positions that actually changed.
          if (REORDERING_ARRAY_METHODS.has(key)) {
            applyOrder(loroList, arr, batcher);
          } else if (REPLACING_ARRAY_METHODS.has(key)) {
            for (let i = 0; i < arr.length && i < loroList.length; i += 1) {
              const next = arr[i];
              if (loroList.get(i) === next) continue;
              batcher?.record(next);
              assignListPosition(loroList, i, next);
            }
          }
          return result;
        };
      }
      return val;
    },
    set(_t, key, value) {
      if (key === 'length') {
        const newLen = Number(value);
        const oldLen = loroList.length;
        if (newLen < oldLen) loroList.delete(newLen, oldLen - newLen);
        return true;
      }
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        const idx = Number(key);
        // Before the write, so a commit it triggers seals the preceding batch
        // rather than splitting this element out of it.
        batcher?.record(value);
        // Replacing a position is `set`, which is ONE op at that position. A
        // delete plus an insert is what the list has to do without one, and it
        // leaves the entry duplicated when a peer edits the same position
        // concurrently, because a list CRDT commutes the deletes and keeps
        // both insertions.
        if (idx < loroList.length) assignListPosition(loroList, idx, value);
        else insertListAt(loroList, idx, value);
        return true;
      }
      return false;
    },
  };
  return new Proxy([] as unknown[], handler);
}

// ---- Paged record-store presentation -----------------------------------
//
// A large record-graph document stores its `instances` map PAGED: keyed
// `brass:p:<peer>:<n>` -> a `{ type: '__page__', params: <gzipped bodies>,
// keys: <gzipped key list> }` container, filled in creation order (see
// `record-paging.ts`).
// These helpers let `MapHandleImpl` present that paged map as the SAME flat
// `key -> { type, params }` record map an unpaged store reads, so an app
// reading / editing `doc.map('instances')` works unchanged. Only a root
// the `meta` markers name reaches here.

// A flattened entry: whatever the map stores under one key. A codec's record
// store holds `{ type, params }`; an app's map holds whatever the app assigns,
// which is any JSON value and which the paged path carries through unchanged.
// Deliberately not narrowed to an object: a write path that assumes fields is
// what turns `5` into an empty container and `'hello'` into one entry per
// character.
type FlatRecord = unknown;

const TAG_FIELD = 'type';
const BODY_FIELD = 'params';

// The record keys one page packs, read off the live container without
// materialising its bodies. Two fields out of wasm rather than the whole
// container: a store's bodies are its bulk, and an index build asks every page
// this question. `key` has already been classified as a page, so an entry that
// decodes to nothing is a corrupt page rather than something else.
function pageKeyList(m: LoroMap, key: string): string[] {
  const v = m.get(key);
  if (!(v instanceof LoroMap)) return [];
  try {
    return decodePageKeys(v.get(PAGE_KEYS_FIELD));
  } finally {
    v.free();
  }
}

// Decode a live paged `instances` map to the flat `key -> { type, params }`
// lookup. `toJSON` materialises the page containers to the plain shape the
// shared `flattenPagedLookup` consumes, so page flattening lives in one place.
// Only ever called on the handle's paged path (guarded by `_isPaged()` /
// the handle's page count), so the store is known paged. Pass `paged: true` rather than
// re-deriving it from a tag scan.
function flattenPagedMap(
  m: LoroMap,
  into?: RecordLocationSink,
): Record<string, FlatRecord> {
  return flattenPagedLookup(
    m.toJSON() as Record<string, unknown>,
    true,
    into,
  ) as Record<string, FlatRecord>;
}

// Resolve a single record without flattening the whole store: take the key's
// page from the index, decode only that page, find the triple. Keeps a per-key
// `get` proportional to one page, not the whole file.
function recordFromPage(
  m: LoroMap,
  recordKey: string,
  memo?: PageMemo,
  index?: PagedKeyIndex | null,
  patchIndex?: PatchIndex | null,
): FlatRecord | undefined {
  const base = recordBeforePatches(m, recordKey, memo, index);
  if (base === undefined) return undefined;
  // The patches fold on LAST, over whichever copy the passes above resolved,
  // matching `flattenPagedLookup` so a keyed read and a bulk read cannot
  // disagree about an edited record.
  const keys = patchIndex?.keysFor(recordKey);
  if (keys === undefined || keys.length === 0) return base;
  const patches: RecordPatch[] = [];
  for (const key of keys) {
    const parsed = parsePatchKey(key);
    if (parsed === null) continue;
    patches.push({
      peer: parsed.peer,
      counter: parsed.counter,
      fields: plainEntry(m, key),
    });
  }
  return applyRecordPatches(base, patches);
}

/**
 * Record key -> the patch keys editing it.
 *
 * Kept apart from `PagedKeyIndex` because the two cost different things. That
 * index answers WHICH PAGE holds a record, which costs a read of every page's
 * key list. A patch is a plain map key, so learning every patch costs a walk
 * of the key list and no decode, which every keyed read can afford. Without it
 * a `get` returns the page's pre-edit copy while `read` returns the edited
 * one.
 */
class PatchIndex {
  private readonly _byRecord = new Map<string, string[]>();
  private _version: StateVersion | null = null;

  /** Rebuild against `m` unless the document is at the version this index was
   *  built at. A mutation's own writes do not go through here: they call
   *  `note` / `clear`, which keep the index current while the open transaction
   *  holds the version still. */
  refresh(m: LoroMap, version: StateVersion): void {
    if (this._version !== null && sameStateVersion(this._version, version)) {
      return;
    }
    this._version = version;
    this._byRecord.clear();
    for (const key of m.keys()) {
      const parsed = parsePatchKey(key);
      if (parsed === null) continue;
      const list = this._byRecord.get(parsed.recordKey);
      if (list) list.push(key);
      else this._byRecord.set(parsed.recordKey, [key]);
    }
  }

  /** The patch keys editing `recordKey`, in no particular order (the fold
   *  orders them by counter and peer). */
  keysFor(recordKey: string): string[] | undefined {
    return this._byRecord.get(recordKey);
  }

  /** The counter a new patch on `recordKey` must carry: one above every
   *  counter the record already holds.
   *
   *  Per RECORD, because the fold's order has to be causal and this index is
   *  what a writer has merged. A writer that has seen an earlier patch on this
   *  record mints above it and so applies over it; two writers that have not
   *  seen each other mint the same number and are tied apart by peer id, which
   *  is the only case where the answer is arbitrary and the only case where it
   *  may be. Counting the writer's own edits instead orders patches by how
   *  busy each session was, which loses the later edit. */
  nextCounterFor(recordKey: string): number {
    const keys = this._byRecord.get(recordKey);
    if (keys === undefined) return 1;
    let highest = 0;
    for (const key of keys) {
      const parsed = parsePatchKey(key);
      if (parsed === null) continue;
      const counter = Number(parsed.counter);
      if (Number.isFinite(counter) && counter > highest) highest = counter;
    }
    return highest + 1;
  }

  /** Record a patch this build just wrote, so a read later in the same
   *  mutation sees it without a rebuild. */
  note(patchKey: string, recordKey: string): void {
    const list = this._byRecord.get(recordKey);
    if (list) list.push(patchKey);
    else this._byRecord.set(recordKey, [patchKey]);
  }

  /** Forget `recordKey`'s patches, for a caller that has just removed them. */
  clear(recordKey: string): void {
    this._byRecord.delete(recordKey);
  }
}

/**
 * The record the map holds under `recordKey` ITSELF, beside the pages rather
 * than under a reserved key, or undefined when it holds none.
 *
 * A record under its own bare key is every record written before the map
 * paged, plus what a client that did not know it was paged leaves behind. The
 * store's own entries are the ones under `RESERVED_KEY_PREFIX`, so a record
 * key never names one and the value is a record whatever it holds.
 *
 * Both the read path and the write path ask through this, so they cannot
 * disagree about which entries of a paged map are records.
 */
function strayRecordAt(m: LoroMap, recordKey: string): unknown {
  if (isReservedKey(recordKey)) return undefined;
  return plainEntry(m, recordKey);
}

function recordBeforePatches(
  m: LoroMap,
  recordKey: string,
  memo?: PageMemo,
  index?: PagedKeyIndex | null,
): FlatRecord | undefined {
  // A reserved key names one of the store's own entries, never a record, so a
  // read of one answers as it would for a key nothing holds.
  if (isReservedKey(recordKey)) return undefined;
  // A delete a page still holds is its own entry, and it outranks every copy
  // of the record, so it is resolved first. That is one map read this path
  // would not otherwise make, and it is what keeps a concurrent edit from
  // resurrecting a record its own reader was told is gone.
  if (entryExists(m, tombstoneKeyFor(recordKey))) return undefined;
  // Same precedence as `flattenPagedLookup`, so a keyed read and a bulk read
  // cannot disagree about which copy of a record wins: an edit written beside
  // the pages, then a record held under its own key, then the page.
  //
  // The overlay slot is checked before the index is consulted, and its
  // presence decides on its own: a remote edit that landed after the index was
  // built rewrites that container, which this read reaches whatever the index
  // says.
  const own = plainEntry(m, overlayKeyFor(recordKey));
  if (own !== undefined) return own;
  const stray = strayRecordAt(m, recordKey);
  if (stray !== undefined) return stray;
  // A page is filled in creation order, so the index is the only thing that
  // says which one holds this record. No index, no page answer.
  const pageKey = index?.readsFromPage(recordKey);
  if (pageKey === undefined) return undefined;
  const page = plainEntry(m, pageKey);
  if (memo) return memo.resolve(pageKey, page).get(recordKey);
  for (const packed of decodePageRecords(page)) {
    if (packed[0] === recordKey) return unpackRecord(packed);
  }
  return undefined;
}

/**
 * Which page each record in a paged map lives in.
 *
 * A page is filled in creation order (see `SESSION_PAGE_PREFIX`), so the only
 * way to find a record in one is to have read the pages' key lists. This reads
 * them once and keeps the answer.
 *
 * Validity is stamped with the document's version, the same way `PatchIndex`
 * stamps itself: one commit that both removes an entry and adds one leaves the
 * map's entry COUNT where it found it while moving which keys are there, and a
 * count-stamped index then answers from a page set the map no longer has, with
 * nothing to correct it. That divergence has no read that resolves it, since a
 * whole-store `read` walks the map and a keyed `get` walks the index, so the
 * two disagree for as long as the handle lives; and a write consulting the
 * stale index takes a key it already holds for an addition and seals a second
 * copy of it into a new page.
 */
class PagedKeyIndex {
  // Record key -> the page whose body PACKS it. One map for the whole store,
  // so a build costs one insert per record: a second map alongside it costs
  // far more than the extra inserts (measured at 250,000 records, 415 ms
  // against 62 ms, the two together outgrowing what one keeps resident).
  private readonly _inPage = new Map<string, string>();
  // The records a container of its own answers for, which outrank the page's
  // copy on a read, and the ones a tombstone removes. Both are bounded by the
  // records actually edited rather than by the store's size, so they stay
  // small beside the page map.
  //
  // Kept apart from the page map because the two answer different questions
  // and diverge: a record read through its overlay container is still packed
  // into the page it was written into, and a page cannot be rewritten to drop
  // it. That is exactly what decides whether deleting the record needs a
  // tombstone or can just remove its container, so conflating the two loses
  // the record's deletion.
  private readonly _contained = new Set<string>();
  private readonly _removed = new Set<string>();
  // The document version this index's answers were last known to match, or
  // null while it has never been built.
  private _version: StateVersion | null = null;
  // Rebuilds this index has done. A rebuild decodes every page, so an edit
  // that forces one costs the whole store rather than one record; a test
  // reads this to pin that an ordinary edit does not.
  rebuilds = 0;

  constructor(private readonly _stateVersion: () => StateVersion) {}

  /** Whether the document has moved since the last build, and so whether this
   *  index has to be built again before it answers. */
  stale(): boolean {
    return (
      this._version === null ||
      !sameStateVersion(this._version, this._stateVersion())
    );
  }

  /** Take this index's answers from a walk that is already resolving them (a
   *  whole-store read decodes every page, which is the same question), rather
   *  than decoding the store a second time on the first keyed read. The sink
   *  is called from `flattenPagedLookup`'s own three passes, so the entries
   *  arrive in the order `refresh` walks them.
   *
   *  The stamp is dropped up front and set again by `stamp`, so a walk that
   *  throws leaves an index that rebuilds rather than an empty one that reads
   *  as current. */
  harvest(): RecordLocationSink {
    this.rebuilds += 1;
    this._version = null;
    this._inPage.clear();
    this._contained.clear();
    this._removed.clear();
    return {
      page: (recordKey, pageKey) => {
        this._inPage.set(recordKey, pageKey);
      },
      contained: (recordKey) => {
        this._contained.add(recordKey);
      },
      removed: (recordKey) => {
        this._removed.add(recordKey);
      },
    };
  }

  /** Stamp a harvested index as current. */
  stamp(): void {
    this._version = this._stateVersion();
  }

  /** Rebuild against `m` if the document has moved since the last build. */
  refresh(m: LoroMap): void {
    const version = this._stateVersion();
    if (this._version !== null && sameStateVersion(this._version, version)) {
      return;
    }
    this.rebuilds += 1;
    this._inPage.clear();
    this._contained.clear();
    this._removed.clear();
    // Same passes, in the same order, as `flattenPagedLookup`: pages, then
    // records under their own key, then the edits beside them, then the
    // deletes. A key's location has to agree with which copy of it a read
    // returns, and resolving in one pass would make that depend on the order
    // the map hands its keys back, so a record a tombstone removes could be
    // indexed to the page still holding it.
    const strays: string[] = [];
    const overlays: string[] = [];
    const removed: string[] = [];
    for (const key of m.keys()) {
      const entry = classifyStoreKey(key);
      switch (entry.kind) {
        case 'record':
          strays.push(key);
          break;
        case 'overlay':
          overlays.push(entry.recordKey);
          break;
        case 'tombstone':
          removed.push(entry.recordKey);
          break;
        case 'page':
          // A page is asked for its KEY LIST alone. Materialising the whole
          // container instead would copy every record body in the store out of
          // wasm and then decompress and parse it, to learn what the keys
          // already say: measured at 250,000 records, 1.48 s against 0.45 s.
          for (const recordKey of pageKeyList(m, key)) {
            this._inPage.set(recordKey, key);
          }
          break;
        // A patch names no record of its own, so it must not be taken for a
        // stray. Which records they edit is `PatchIndex`'s business.
        case 'patch':
        case 'unknown':
          break;
      }
    }
    for (const key of strays) this._contained.add(key);
    for (const recordKey of overlays) this._contained.add(recordKey);
    for (const recordKey of removed) {
      this._removed.add(recordKey);
      this._contained.delete(recordKey);
    }
    this._version = version;
  }

  /** Every record key the map stores, from the page key lists and the entries
   *  that outrank them. Answered without decoding a page BODY, which is what
   *  separates it from a whole-store read: the key lists alone are measured at
   *  0.45 s against 1.48 s for the bodies at 250,000 records. */
  liveKeys(): Set<string> {
    const out = new Set<string>();
    for (const key of this._inPage.keys()) {
      if (!this._removed.has(key)) out.add(key);
    }
    for (const key of this._contained) out.add(key);
    return out;
  }

  /** Whether the map stores a record under `recordKey`. */
  has(recordKey: string): boolean {
    if (this._removed.has(recordKey)) return false;
    return this._contained.has(recordKey) || this._inPage.has(recordKey);
  }

  /** The page a keyed read should decode for `recordKey`, or undefined when a
   *  container of its own answers for it (or it is not stored at all). */
  readsFromPage(recordKey: string): string | undefined {
    if (this._contained.has(recordKey) || this._removed.has(recordKey)) {
      return undefined;
    }
    return this._inPage.get(recordKey);
  }

  /** Whether some page's body still holds `recordKey`, and so whether deleting
   *  it has to be stated as a tombstone. */
  packedInPage(recordKey: string): boolean {
    return this._inPage.has(recordKey);
  }

  /** Record a page write this handle just made: every record `pageKey` now
   *  packs. Takes the whole page rather than a record at a time so the version
   *  is read once for the write instead of once per record, which a bulk write
   *  reaches hundreds of thousands of times. */
  notePage(pageKey: string, recordKeys: Iterable<string>): void {
    for (const recordKey of recordKeys) {
      this._inPage.set(recordKey, pageKey);
      this._contained.delete(recordKey);
      this._removed.delete(recordKey);
    }
    this._restamp();
  }

  /** Record that a container of its own now answers for `recordKey`. */
  noteContained(recordKey: string): void {
    this._contained.add(recordKey);
    this._removed.delete(recordKey);
    this._restamp();
  }

  /** Note a write that moved no record between a page and a container, so the
   *  stamp stays current and the next read does not rebuild.
   *
   *  A patch is this: it names no record of its own, so writing or removing
   *  one leaves every answer this index gives unchanged while moving the
   *  document the stamp is taken against. Without it a session-paged store
   *  rebuilds on the access after each edit, and a rebuild decodes every page:
   *  measured at 20,000 records, 79 ms per edit against 2.8 ms. */
  noteSideEntries(): void {
    this._restamp();
  }

  /** Record that `recordKey` is no longer stored. What a page still holds is
   *  left alone: the page keeps its copy, and a later re-add has to know that
   *  removing the tombstone alone would resurrect it. */
  noteRemoved(recordKey: string): void {
    this._removed.add(recordKey);
    this._contained.delete(recordKey);
    this._restamp();
  }

  // Carry the stamp forward over a write this index has just taken account of.
  // Every caller notes AFTER its writes, so the version read here is the one
  // the noted content matches. Committing does not move the version, so a
  // mutation that commits as it goes stays stamped throughout.
  //
  // An index that has never been built stays unbuilt: stamping one fresh would
  // leave it empty and authoritative.
  private _restamp(): void {
    if (this._version === null) return;
    this._version = this._stateVersion();
  }
}

/**
 * A one-entry memo of the last decoded page, so repeated keyed reads inside
 * one page decode it once. Keyed on the page's stored BODY, which is one
 * immutable string, so any write that changes the page misses and a stale
 * read is not expressible.
 */
class PageMemo {
  private _pageKey: string | null = null;
  private _body: unknown = undefined;
  private _records: Map<string, FlatRecord> = new Map();

  resolve(pageKey: string, page: unknown): Map<string, FlatRecord> {
    const body = decodeRecordValue(page)?.body;
    if (this._pageKey === pageKey && this._body === body) return this._records;
    const records = new Map<string, FlatRecord>();
    for (const packed of decodePageRecords(page)) {
      records.set(packed[0], unpackRecord(packed));
    }
    this._pageKey = pageKey;
    this._body = body;
    this._records = records;
    return records;
  }
}

/** Whether a page still holds this record, which decides whether a delete
 *  needs a marker or can just remove the record's own container. */
function pageHoldsRecord(
  recordKey: string,
  index: PagedKeyIndex | null,
): boolean {
  return index !== null && index.packedInPage(recordKey);
}

// ---- Change deltas (`{ delta: true }` map subscribers) ----------------
//
// A delta subscriber reports which keys changed since the previous fire so a
// render loop patches O(changed) rather than re-reading the container.
//
// Unpaged: read it off Loro's diff. A value reassign / add / delete shows on
// the map's own diff (`target === m.id`); a field edit fires on the record's
// nested container, so the record's key is the first path segment under root.
//
// Paged: a record edit rewrites the whole page container, so the diff names
// the changed PAGE. Recover record granularity with a per-subscription
// page -> keys index, diffing a changed page's current keys against it; a
// deleted record was in the prior key set and absent from the rewritten page.

// How many path segments name `m` itself. An event's `path` is absolute from
// the document root, so a descendant event's entry key is the segment at this
// index: 1 for a root container (`path[0]` is the root key), one more for each
// container it is nested inside.
//
// Measured from the container rather than from the handle's anchor chain
// because the two can disagree: a scoped handle over a paged store resolves
// its record through the copy that answers for it, which sits one level below
// the root either way but under a key the anchor does not name.
function containerDepth(m: LoroMap | LoroMovableList): number {
  let depth = 0;
  let current: { parent(): unknown } | undefined = m;
  while (current) {
    depth += 1;
    current = current.parent() as { parent(): unknown } | undefined;
  }
  return depth;
}

// Decode one page to its `key -> { type, params }` records in a single pass,
// so a paged delta gets the changed records' VALUES from the same decode it
// uses to find the changed keys (a second per-key decode would make a large
// initial build O(records x page-size)). Null for a page key nothing holds,
// which is how a delta tells a rewritten page from a removed one.
function pageRecords(m: LoroMap, pageKey: string): Map<string, FlatRecord> | null {
  const page = plainEntry(m, pageKey);
  if (page === undefined) return null;
  const records = new Map<string, FlatRecord>();
  for (const packed of decodePageRecords(page)) {
    records.set(packed[0], unpackRecord(packed));
  }
  return records;
}

/**
 * What one subscription has been told about a paged store.
 *
 * `pages` is the record keys each page held at the last fire, which is what
 * recovers record granularity from a page-level change. `shadowed` is the
 * records the store answers for from OUTSIDE its pages: an edit written beside
 * them, a record under its own key, a delete marker, a patch. A page keeps its
 * copy of such a record, because nothing rewrites a page to drop one, so a
 * rewrite carries that copy forward and it is the value the store replaced.
 *
 * `shadowed` only grows, which is the safe direction: an entry that goes
 * leaves the record answered by its page again, and a resolve of it reads that
 * page.
 */
interface PagedDeltaIndex {
  readonly pages: Map<string, Set<string>>;
  readonly shadowed: Set<string>;
}

/** Note the record a store entry answers for, if it answers for one. */
function noteShadowedRecord(shadowed: Set<string>, key: string): void {
  const entry = classifyStoreKey(key);
  switch (entry.kind) {
    case 'patch':
      shadowed.add(entry.parsed.recordKey);
      break;
    case 'overlay':
    case 'record':
    case 'tombstone':
      shadowed.add(entry.recordKey);
      break;
    case 'page':
    case 'unknown':
      break;
  }
}

function shadowedRecords(m: LoroMap): Set<string> {
  const shadowed = new Set<string>();
  for (const key of m.keys()) noteShadowedRecord(shadowed, key);
  return shadowed;
}

function buildPagedDeltaIndex(m: LoroMap): PagedDeltaIndex {
  const pages = new Map<string, Set<string>>();
  const shadowed = new Set<string>();
  for (const key of m.keys()) {
    if (classifyStoreKey(key).kind === 'page') {
      pages.set(key, new Set(pageKeyList(m, key)));
      continue;
    }
    noteShadowedRecord(shadowed, key);
  }
  return { pages, shadowed };
}

function unpagedMapDelta(
  m: LoroMap,
  depth: number,
  batch: LoroEventBatch,
): Change<unknown> {
  const setKeys = new Set<string>();
  const deleted = new Set<string>();
  for (const ev of batch.events) {
    if (ev.target === m.id) {
      if (ev.diff.type !== 'map') continue;
      for (const [key, value] of Object.entries(ev.diff.updated)) {
        if (value === undefined) deleted.add(key);
        else setKeys.add(key);
      }
    } else {
      // A descendant event (a field edit on an entry's nested container).
      // Every batch event is within this map's subtree, so the entry's key is
      // the path segment directly under it, at this map's own depth.
      const key = ev.path[depth];
      if (typeof key === 'string') setKeys.add(key);
    }
  }
  for (const key of deleted) setKeys.delete(key);
  const set = new Map<string, unknown>();
  for (const key of setKeys) set.set(key, plainEntry(m, key));
  return { set, deleted: [...deleted] };
}

/**
 * Read a changed page out to the records it holds, and name the ones it lost.
 *
 * A page is one value, so a change to it says nothing about WHICH of its
 * records moved; the index of what the page held before is what recovers that.
 * Both routes a page change arrives by resolve through here so they cannot
 * disagree about what a rewrite meant.
 *
 * A record something outside the page answers for is RESOLVED rather than read
 * out of the page, for the same reason the entry cases resolve: the page's copy
 * of it is one of several the store holds, and it is the one every read
 * discards. Reading it out hands a subscriber the value an edit replaced, or
 * puts a deleted record back into a view that then holds it for good.
 */
function expandPage(
  m: LoroMap,
  pageKey: string,
  index: PagedDeltaIndex,
  set: Map<string, unknown>,
  deleted: Set<string>,
  expanded: Set<string>,
  resolve: (recordKey: string) => unknown,
): void {
  if (expanded.has(pageKey)) return;
  expanded.add(pageKey);
  const before = index.pages.get(pageKey);
  const after = pageRecords(m, pageKey);
  if (after) {
    for (const [key, value] of after) {
      if (!index.shadowed.has(key)) {
        set.set(key, value);
        continue;
      }
      const live = resolve(key);
      if (live === undefined) deleted.add(key);
      else set.set(key, live);
    }
    index.pages.set(pageKey, new Set(after.keys()));
  } else {
    index.pages.delete(pageKey);
  }
  if (before) {
    for (const key of before) {
      if (after?.has(key)) continue;
      // A record the page dropped that the store still answers for is not
      // gone, and the copy that answers for it is one this rewrite did not
      // touch, so the change says nothing about its value either.
      if (index.shadowed.has(key) && resolve(key) !== undefined) continue;
      deleted.add(key);
    }
  }
}

function pagedMapDelta(
  m: LoroMap,
  batch: LoroEventBatch,
  index: PagedDeltaIndex,
  resolve: (recordKey: string) => unknown,
): Change<unknown> {
  const set = new Map<string, unknown>();
  const deleted = new Set<string>();
  // Every entry that answers for a record is noted before any page is read
  // out. An entry and a page carrying the same record can arrive in either
  // order within one batch, and both write the record into `set`, so a page
  // read out first would report the copy the entry supersedes.
  for (const ev of batch.events) {
    if (ev.target === m.id && ev.diff.type === 'map') {
      for (const changedKey of Object.keys(ev.diff.updated)) {
        noteShadowedRecord(index.shadowed, changedKey);
      }
      continue;
    }
    const segment = ev.path[1];
    if (typeof segment === 'string') noteShadowedRecord(index.shadowed, segment);
  }
  // Pages this batch has already been read out of. One rewrite can reach here
  // from both directions (the map-level diff and the page's own container
  // event), and a page body is gzipped, so decoding it twice per batch is real
  // work on a store whose pages a pass rewrites all at once.
  const expanded = new Set<string>();
  // A patch key names no record, so the record it edits is resolved once at
  // the end however many patches this batch carried for it. Reporting the
  // patch key itself would name a record no reader has, and dropping it (it
  // is neither an overlay key nor a page) would leave a subscriber's view
  // showing the pre-edit value.
  const patched = new Set<string>();
  for (const ev of batch.events) {
    if (ev.target === m.id && ev.diff.type === 'map') {
      for (const changedKey of Object.keys(ev.diff.updated)) {
        const entry = classifyStoreKey(changedKey);
        switch (entry.kind) {
          case 'patch':
            patched.add(entry.parsed.recordKey);
            break;
          // An entry that names one record: the record's own container beside
          // the pages, or the record under its own bare key. Either is one of
          // several copies a paged store can hold, so the record is RESOLVED
          // rather than read off the entry and a subscriber is handed the
          // value a reader gets. A peer's patch outranks the container it was
          // written over, and a page copy survives the container going, so
          // the entry alone answers neither what the record holds nor whether
          // it is still there.
          case 'overlay':
          case 'record': {
            const value = resolve(entry.recordKey);
            if (value === undefined) deleted.add(entry.recordKey);
            else set.set(entry.recordKey, value);
            break;
          }
          // The marker arriving removes the record; the marker going is a
          // re-add, whose own entry the same batch carries, so the record is
          // resolved rather than reported from here.
          case 'tombstone': {
            if (entryExists(m, changedKey)) {
              deleted.add(entry.recordKey);
              break;
            }
            const value = resolve(entry.recordKey);
            if (value !== undefined) set.set(entry.recordKey, value);
            break;
          }
          case 'page':
            expandPage(m, changedKey, index, set, deleted, expanded, resolve);
            break;
          case 'unknown':
            break;
        }
      }
      continue;
    }
    // An event on a container under the root, whose key is the path segment
    // there. Two shapes reach here.
    //
    // A field edit fires on the record's own container, and names that record.
    //
    // A PAGE fires here when a covering mutation rewrites it: the page's
    // container already exists, so the rewrite sets fields on it rather than
    // assigning a key of the store's own map, and the map-level diff carries
    // nothing. Reading only that diff drops every record in every page a pass
    // covered, which is the whole store for a pass over the whole store, and
    // drops them silently: the writer's own app repaints the few records that
    // took another route and leaves the rest drawn where they were.
    const segment = ev.path[1];
    if (typeof segment === 'string') {
      const entry = classifyStoreKey(segment);
      if (entry.kind === 'page') {
        expandPage(m, segment, index, set, deleted, expanded, resolve);
      } else if (entry.kind === 'overlay' || entry.kind === 'record') {
        // Resolved for the same reason the map-level cases are: the container
        // this event fired on is one copy of the record, not the answer.
        const value = resolve(entry.recordKey);
        if (value !== undefined) set.set(entry.recordKey, value);
      }
    }
  }
  for (const recordKey of patched) {
    if (set.has(recordKey) || deleted.has(recordKey)) continue;
    const value = resolve(recordKey);
    if (value === undefined) deleted.add(recordKey);
    else set.set(recordKey, value);
  }
  for (const key of deleted) set.delete(key);
  return { set, deleted: [...deleted] };
}

// Run a flat-draft `mutate` against a PAGED store. The draft proxies an
// OVERLAY of in-batch changes (key -> record, or a tombstone for a delete);
// reads consult the overlay first then the stored page, so an edit is
// visible to later reads in the same `fn` as on an unpaged live proxy.
// Afterwards `applyOverlay` writes each EDITED record to its own container
// beside the pages, leaving every existing page byte-identical. That is what
// keeps two people editing different records in one page from overwriting each
// other: a page body is a single gzipped value, so rewriting it would make the
// page the merge unit and hand the whole page to the last writer. A `pruneRefs`
// sweep that iterates the whole draft is the only path that reads every page,
// the rare structural-delete case already treated as O(file).
function mutatePaged<T>(
  m: LoroMap,
  fn: (draft: Record<string, T>) => void,
  pager: SessionPager | null,
  batcher?: MutateBatcher,
): void {
  const TOMBSTONE = Symbol('deleted');
  // In-batch changes: key -> new record, or TOMBSTONE when deleted. Absent
  // means "unchanged, read from the page".
  const overlay = new Map<string, FlatRecord | typeof TOMBSTONE>();
  // One decoded page shared by every read this mutation makes. Reading a
  // record through the draft (`m[key].params`) resolves it once per field
  // touched, and the ordinary edit shape touches several, so without this a
  // single-record edit gunzips and parses its whole page a handful of times.
  // `applyOverlay` never rewrites a page, so a page decoded here stays valid
  // for the whole mutation.
  const memo = new PageMemo();
  // Taken ONCE, before the first write. The version advances as the mutation
  // writes, so taking it again per record would rebuild the index per record;
  // the write path keeps this instance current instead (`note` / `clear`).
  const patchIndex = pager ? pager.patches(m) : null;

  // The record a draft read should see: the overlay value if touched this
  // batch, else the stored record.
  const currentRecord = (key: string): FlatRecord | undefined => {
    if (overlay.has(key)) {
      const v = overlay.get(key)!;
      return v === TOMBSTONE ? undefined : v;
    }
    return recordFromPage(m, key, memo, pager?.liveIndex ?? null, patchIndex);
  };

  // Per-record sub-proxy: a field assignment writes through to the overlay
  // record so a later read sees it and the page rewrite picks it up. Field
  // reads return the deep-plain stored value, so spreading `{ ...rec.params }`
  // never leaks a live handle.
  const recordProxy = (key: string): Record<string, unknown> => {
    // The record a field write starts from. A value that is not an object has
    // no fields to keep, so the write starts from an empty record rather than
    // from that value's own entries (`'ab'` would contribute `0` and `1`).
    const fieldBase = (): Record<string, unknown> => {
      const rec = currentRecord(key);
      return isPlainObject(rec) ? { ...rec } : {};
    };
    return new Proxy(
      {},
      {
        get(_t, field) {
          if (typeof field === 'symbol') return undefined;
          const rec = currentRecord(key);
          const v = isPlainObject(rec) ? rec[field] : undefined;
          if (v !== null && typeof v === 'object') {
            // Same reason as the unpaged proxy: a body is a plain value, so
            // a field edit inside it has to be written back rather than
            // applied to the copy the read handed out.
            return writeThroughBody(v, (next) => {
              const base = fieldBase();
              base[field] = toPlainDeep(next);
              overlay.set(key, base);
            });
          }
          return v;
        },
        set(_t, field, value) {
          if (typeof field === 'symbol') return false;
          const base = fieldBase();
          base[field] = toPlainDeep(value);
          overlay.set(key, base);
          return true;
        },
        // A field removal has to write through here as an assignment does.
        // The default trap would delete from this proxy's own empty target
        // and report success, so `delete d[key].field` would apply on a small
        // store and silently do nothing once the store paged.
        deleteProperty(_t, field) {
          if (typeof field === 'symbol') return false;
          const base = fieldBase();
          if (!(field in base)) return true;
          delete base[field];
          overlay.set(key, base);
          return true;
        },
        // Enumerating a record is what `{ ...rec }`, `Object.keys(rec)` and
        // `JSON.stringify(rec)` all reach for, so the record answers with its
        // stored fields here as it does through the unpaged proxy. Without
        // these the proxy enumerates its own empty target, and an app that
        // copies a record reads it as `{}` on a paged store while the same
        // code works on a small one.
        has(_t, field) {
          if (typeof field === 'symbol') return false;
          const rec = currentRecord(key);
          return isPlainObject(rec) && field in rec;
        },
        ownKeys() {
          const rec = currentRecord(key);
          return isPlainObject(rec) ? Object.keys(rec) : [];
        },
        getOwnPropertyDescriptor(_t, field) {
          if (typeof field === 'symbol') return undefined;
          const rec = currentRecord(key);
          if (!isPlainObject(rec) || !(field in rec)) return undefined;
          return {
            enumerable: true,
            configurable: true,
            writable: true,
            value: rec[field],
          };
        },
      },
    ) as Record<string, unknown>;
  };

  const draft = new Proxy(
    {},
    {
      get(_t, key) {
        if (typeof key === 'symbol') return undefined;
        const rec = currentRecord(key as string);
        if (rec === undefined) return undefined;
        // As on an unpaged map: a stored value that is not an object is handed
        // back as itself, and a plain array as a view that writes an element
        // edit through instead of into a copy the caller then drops. Only an
        // object has the fields the per-record sub-proxy answers for.
        if (!isPlainObject(rec)) {
          if (!Array.isArray(rec)) return rec;
          return writeThroughBody(rec, (next) => {
            overlay.set(key as string, toPlainDeep(next));
          });
        }
        return recordProxy(key as string);
      },
      set(_t, key, value) {
        if (typeof key === 'symbol') return false;
        assertUsableRecordKey(key as string);
        overlay.set(key as string, toPlainDeep(value));
        return true;
      },
      deleteProperty(_t, key) {
        if (typeof key === 'symbol') return false;
        assertUsableRecordKey(key as string);
        overlay.set(key as string, TOMBSTONE);
        return true;
      },
      has(_t, key) {
        if (typeof key === 'symbol') return false;
        return currentRecord(key as string) !== undefined;
      },
      ownKeys() {
        // Stored keys plus added, minus deleted.
        const keys = new Set(Object.keys(flattenPagedMap(m)));
        for (const [k, v] of overlay) {
          if (v === TOMBSTONE) keys.delete(k);
          else keys.add(k);
        }
        return [...keys];
      },
      getOwnPropertyDescriptor(_t, key) {
        if (typeof key === 'symbol') return undefined;
        if (currentRecord(key as string) === undefined) return undefined;
        return { enumerable: true, configurable: true, writable: true };
      },
    },
  ) as Record<string, T>;

  fn(draft);
  if (overlay.size === 0) return;

  applyOverlay(m, overlay, TOMBSTONE, patchIndex, memo, pager, batcher);
}

// The container holding one record beside the pages, reusing the one already
// at this key. A fresh `setContainer` is a destroy+create rather than a write
// (the same reason `assignPlain` reuses), so minting one per edit charges the
// snapshot for every edit instead of for every edited RECORD: 2,000 edits to
// one record cost 71.8 KB minting and 8.6 KB reusing. A drag, a slider, and a
// rename are all repeated edits to one record, and every reader downloads the
// difference on every open.
function overlayContainer(m: LoroMap, overlayKey: string): LoroMap {
  const existing = m.get(overlayKey);
  return existing instanceof LoroMap
    ? existing
    : m.setContainer(overlayKey, new LoroMap());
}

// State that a record a page still holds is deleted. The marker carries
// nothing but its own existence, so it is a plain value under a key of its
// own: a field on the record's container would be a field of the app's record,
// and a record that happened to carry it would read as its own deletion.
function markDeleted(m: LoroMap, recordKey: string): void {
  m.set(tombstoneKeyFor(recordKey), true);
}

// Take back a record's delete marker, and report whether there was one.
// Called wherever a record's own container is written, since that container is
// the record being there again.
function clearTombstone(m: LoroMap, recordKey: string): boolean {
  const key = tombstoneKeyFor(recordKey);
  if (!entryExists(m, key)) return false;
  m.delete(key);
  return true;
}

// Write out what a paged mutation changed.
//
// An EDITED record is written OUTSIDE the page holding it, as a patch naming
// the fields that changed or, once this session has patched it before, as a
// container of its own. A page body is one value, so writing the edit into the
// page would make the page the merge unit: two peers changing different
// records in one page would resolve last-writer-wins, and an undo would
// restore the whole page over a peer's record. What that costs is an entry per
// record edited, bounded by the records actually edited rather than by the
// store's size.
//
// The exception is a mutation that replaces EVERY record a page holds, which
// `writeEdits` rewrites in place: nothing in the page is left for the rewrite
// to resolve on another writer's behalf, so the merge unit does not move. That
// is the one route by which an edited store returns to the entry count it
// imported at, and it is why a pass over the whole store is much cheaper than
// the same edits made a scattered subset at a time.
//
// A bulk ADD is written as fresh pages instead, in the writer's own key space,
// which is safe for the same reason an edit in place is not: those keys are
// new, so no peer holds a copy to lose.
function applyOverlay(
  m: LoroMap,
  overlay: Map<string, FlatRecord | symbol>,
  tombstone: symbol,
  patchIndex: PatchIndex | null,
  memo?: PageMemo,
  pager?: SessionPager | null,
  // Commits as the writes accumulate, on the same size budget an unpaged
  // mutation uses. Without it every page a mutation writes rides one op,
  // whose size then scales with the mutation rather than with the budget.
  batcher?: MutateBatcher,
): void {
  let index = pager?.liveIndex ?? null;
  // Records that MIGHT be additions: nothing holds a container for them yet,
  // so each is either new or living in a page. Held back so a bulk add is
  // written as whole pages instead of a container each. A record that already
  // has a container keeps it: the page holding a record cannot be rewritten to
  // carry an edit (see above), and moving it would mean deleting a container a
  // peer may be writing to at that moment.
  const candidates: [string, FlatRecord][] = [];

  for (const [key, rec] of overlay) {
    const overlayKey = overlayKeyFor(key);
    if (rec === tombstone) {
      // Charged before the writes, so a commit it triggers closes the batch
      // that precedes this delete rather than splitting it out of one. A
      // paged store's deletes are unbounded where an unpaged store's stop at
      // the threshold, so this is the path where a bulk delete would
      // otherwise ride one op sized by the delete instead of by the budget.
      batcher?.recordDelete(key);
      // A record held under its own key outgoes the page on every read, so a
      // delete that left it would not remove the record. Off the hot read
      // path: only a delete pays for this.
      if (entryExists(m, key)) m.delete(key);
      if (entryExists(m, overlayKey)) m.delete(overlayKey);
      dropPatches(m, patchIndex, key);
      // A record a page still holds needs the delete stated, since the page
      // cannot be rewritten to drop it. One that exists only as its own
      // container is simply removed, so an add-then-delete leaves nothing and
      // no marker outlives the record it was about.
      if (pageHoldsRecord(key, index)) markDeleted(m, key);
      index?.noteRemoved(key);
      batcher?.noteKeys([key]);
      continue;
    }
    const r = rec;
    // A record already answering for itself beside the pages: rewrite that
    // container in place, so repeated edits merge per field and cost one write
    // each rather than a fresh container.
    if (m.get(overlayKey) !== undefined) {
      dropPatches(m, patchIndex, key);
      writeRecordContainer(m, key, r);
      index?.noteContained(key);
      batcher?.noteKeys([key]);
      batcher?.record(r);
      continue;
    }
    // A record under its own BARE key is edited where it already is, exactly
    // as an unpaged store edits it.
    //
    // Giving it an overlay container instead is a `setContainer` at a key no
    // peer holds yet, so two peers making that record's first edit at the same
    // time each mint one and the map entry resolves last-writer-wins, dropping
    // an edit outright. Writing into the container already there merges per
    // field, and leaves the record stored once rather than twice.
    if (strayRecordAt(m, key) !== undefined) {
      dropPatches(m, patchIndex, key);
      // The record is present again, so its delete marker goes, exactly as it
      // does when a record is written to a container of its own. A marker
      // outranks every copy of a record on a read, so an edit that left one
      // behind would store the new record and answer that it is gone.
      clearTombstone(m, key);
      assignEntry(m, key, r);
      index?.noteContained(key);
      batcher?.noteKeys([key]);
      batcher?.record(r);
      continue;
    }
    if (pager) {
      candidates.push([key, r]);
      continue;
    }
    dropPatches(m, patchIndex, key);
    writeRecordContainer(m, key, r);
    index?.noteContained(key);
    batcher?.noteKeys([key]);
    batcher?.record(r);
  }

  if (candidates.length === 0) return;
  // Below a page's worth there is nothing to PAGE, so nothing here adds a
  // page; the two branches differ only in whether a bulk write refreshes the
  // index up front before telling an edit from an addition.
  const perPage = recordsPerPage(sampleBodyBytes(candidates, pagedBodyOf));
  const added: [string, FlatRecord][] = [];
  if (candidates.length >= perPage && pager) {
    index = pager.ensureIndex(m);
    const edits: [string, FlatRecord][] = [];
    for (const entry of candidates) {
      // The page already holds this record, so this is an EDIT rather than an
      // addition. That covers a record this store DELETED as well: the page
      // keeps its copy whatever the marker says, so re-adding it has to write
      // beside the page rather than into a second one.
      if (pager.holds(entry[0]) || index.packedInPage(entry[0])) {
        edits.push(entry);
      } else added.push(entry);
    }
    writeEdits(m, pager, index, patchIndex, edits, memo, batcher);
  } else if (pager) {
    for (const [key, r] of candidates) {
      if (pageHoldsRecord(key, index)) {
        writeRecordEdit(m, pager, index, patchIndex, key, r, memo, batcher);
        continue;
      }
      writeRecordContainer(m, key, r);
      index?.noteContained(key);
      batcher?.noteKeys([key]);
      batcher?.record(r);
    }
    return;
  } else {
    for (const [key, r] of candidates) {
      writeRecordContainer(m, key, r);
      index?.noteContained(key);
      batcher?.noteKeys([key]);
      batcher?.record(r);
    }
    return;
  }

  const written = pager!.writePages(m, added, perPage, batcher);
  for (let i = written; i < added.length; i += 1) {
    const [key, r] = added[i]!;
    writeRecordContainer(m, key, r);
    index.noteContained(key);
    batcher?.noteKeys([key]);
    batcher?.record(r);
  }
}

/**
 * Write a mutation's edits to records their pages hold.
 *
 * A page whose every record this mutation replaces is REWRITTEN in place, and
 * the patches on those records go with it. That is what keeps a transform over
 * the whole store from landing it in its worst state: a patch each would add
 * an entry per record, where rewriting leaves the store at the entry count it
 * had. A bulk pass naturally covers whole pages, because a read hands its keys
 * back grouped by page.
 *
 * The rewrite is safe against the edits that are not rewrites, which is every
 * other route an edit can take. A page body is one value, so a rewrite is
 * last-writer-wins on the PAGE, but a peer's patch and a peer's own container
 * both live outside it and both outrank it on read, so a concurrent edit
 * survives a rewrite that did not see it. Only another rewrite of the same
 * page can lose one, and that is two people transforming one model at once.
 *
 * Patches are dropped only for the records this rewrite absorbed, so a patch
 * written concurrently, under a key this writer never saw, is left to apply
 * over the rewritten page.
 */
function writeEdits(
  m: LoroMap,
  pager: SessionPager,
  index: PagedKeyIndex,
  patchIndex: PatchIndex | null,
  edits: [string, FlatRecord][],
  memo: PageMemo | undefined,
  batcher: MutateBatcher | undefined,
): void {
  const byPage = new Map<string, [string, FlatRecord][]>();
  const loose: [string, FlatRecord][] = [];
  for (const entry of edits) {
    const pageKey = index.readsFromPage(entry[0]);
    if (pageKey === undefined || pageKey === null) {
      loose.push(entry);
      continue;
    }
    const group = byPage.get(pageKey);
    if (group) group.push(entry);
    else byPage.set(pageKey, [entry]);
  }

  for (const [pageKey, group] of byPage) {
    if (!rewritePage(m, pageKey, group, batcher)) {
      for (const [key, r] of group) {
        writeRecordEdit(m, pager, index, patchIndex, key, r, memo, batcher);
      }
      continue;
    }
    for (const [key] of group) dropPatches(m, patchIndex, key);
    index.noteSideEntries();
    batcher?.noteKeys(group.map(([key]) => key));
  }
  for (const [key, r] of loose) {
    writeRecordEdit(m, pager, index, patchIndex, key, r, memo, batcher);
  }
}

/**
 * Rewrite `pageKey`'s body with `group`'s values, or report that this mutation
 * does not cover the page and leave it untouched.
 *
 * Covering means every record the body holds is one this mutation replaces, or
 * one a container already answers for, whose page copy is dead either way. A
 * partial rewrite would be the merge unit moving from the record to the page,
 * which is what patches exist to prevent.
 */
function rewritePage(
  m: LoroMap,
  pageKey: string,
  group: [string, FlatRecord][],
  batcher: MutateBatcher | undefined,
): boolean {
  const page = plainEntry(m, pageKey);
  if (page === undefined) return false;
  // The RAW triples, not the memo's unpacked records: a triple carries either
  // a codec's tag beside its body or one whole value, and `repackRecord` needs
  // the original to keep each one in the shape its readers expect.
  const held = decodePageRecords(page);
  if (held.length === 0) return false;
  const next = new Map(group);
  for (const packed of held) {
    if (next.has(packed[0])) continue;
    if (entryExists(m, overlayKeyFor(packed[0]))) continue;
    if (entryExists(m, tombstoneKeyFor(packed[0]))) continue;
    return false;
  }

  const triples = held.map((packed) => {
    const value = next.get(packed[0]);
    return value === undefined ? packed : repackRecord(packed, value);
  });
  const encoded = encodePage(triples);
  writePage(m, pageKey, encoded);
  // Charged by what the page PACKS rather than by the gzipped bytes it
  // occupies, so a record costs the same here as it costs assigned into an
  // unpaged map and one budget means one thing on every route.
  batcher?.recordChars(encoded.chars);
  return true;
}

// Write an encoded page into its container: the tag, the bodies, and the keys
// they belong to. The two strings are set together because a reader zips them
// by index, so a page carrying one without the other holds no records.
function writePage(m: LoroMap, pageKey: string, encoded: EncodedPage): void {
  const container = overlayContainer(m, pageKey);
  container.set(TAG_FIELD, PAGE_TAG);
  container.set(BODY_FIELD, encoded.body);
  container.set(PAGE_KEYS_FIELD, encoded.keys);
}

/**
 * Remove the patches a whole-record write supersedes.
 *
 * A read folds patches on LAST, over whichever copy of the record the page and
 * container passes resolved, so a patch left behind by an earlier edit would
 * overwrite the record this write is putting there. Every site that makes a
 * record's own container authoritative (an edit, a re-add over a tombstone,
 * the tombstone itself) therefore clears them first.
 *
 * This races nothing. A patch key is never written twice, so a peer editing
 * the same record concurrently writes a key this cannot have seen, and that
 * patch survives to apply over the container, which is the merge the record
 * would have had anyway.
 */
function dropPatches(
  m: LoroMap,
  patchIndex: PatchIndex | null,
  key: string,
): void {
  const keys = patchIndex?.keysFor(key);
  if (keys === undefined) return;
  for (const patchKey of keys) m.delete(patchKey);
  patchIndex!.clear(key);
}

/**
 * Write an edit to a record a page already holds.
 *
 * A patch carries only the fields this edit changed, under a key nothing will
 * write again, so the record stays in its page and two peers changing
 * different fields of it both keep theirs. A whole-record write cannot do
 * either: it takes the record out of its page for good, and the second writer
 * overwrites the first.
 *
 * Removing a field is the one edit a patch cannot state, since a patch is
 * applied by overlaying its keys. That falls back to the whole-record write,
 * which is correct and merely gives up the packing for that record.
 *
 * A record this session has ALREADY patched takes that fallback too. Patches
 * accumulate where a container's keys are rewritten in place, so a record
 * edited over and over (one drag is many edits to one record) would grow the
 * document without bound. Making the first edit a patch and the second a
 * container bounds it at one patch per record: an entropy sweep that touches
 * every record once stays packed, and a hot record costs what it always did.
 * The FIRST edit is the one that has to be a patch, because that is the moment
 * two peers editing one record would otherwise mint a container at the same
 * key and lose one of the two.
 */
function writeRecordEdit(
  m: LoroMap,
  pager: SessionPager,
  index: PagedKeyIndex | null,
  patchIndex: PatchIndex | null,
  key: string,
  record: FlatRecord,
  memo: PageMemo | undefined,
  batcher: MutateBatcher | undefined,
): void {
  const previous = recordFromPage(m, key, memo, index, patchIndex);
  const patch = alreadyPatchedHere(patchIndex, key, pager.token)
    ? null
    : changedFields(previous, record);
  if (patch === null) {
    dropPatches(m, patchIndex, key);
    writeRecordContainer(m, key, record);
    index?.noteContained(key);
    batcher?.noteKeys([key]);
    batcher?.record(record);
    return;
  }
  if (Object.keys(patch).length === 0) return;
  const patchKey = pager.nextPatchKey(key, patchIndex);
  m.set(patchKey, toPlainDeep(patch) as never);
  patchIndex?.note(patchKey, key);
  index?.noteSideEntries();
  batcher?.noteKeys([key]);
  batcher?.record(patch);
}

/** Whether this session already holds a patch on `key`. Another peer's patch
 *  does not count: every peer's FIRST edit has to be a patch for two of them
 *  editing one record to merge. */
function alreadyPatchedHere(
  patchIndex: PatchIndex | null,
  key: string,
  token: string,
): boolean {
  const keys = patchIndex?.keysFor(key);
  if (keys === undefined) return false;
  for (const patchKey of keys) {
    if (parsePatchKey(patchKey)?.peer === token) return true;
  }
  return false;
}

/** The fields `next` changes, or null when this edit is not one a patch can
 *  express: a field was removed, or either side is not an object, and a patch
 *  is applied by overlaying field names. */
function changedFields(
  previous: unknown,
  next: unknown,
): Record<string, unknown> | null {
  if (!isPlainObject(previous) || !isPlainObject(next)) return null;
  for (const field of Object.keys(previous)) {
    if (!(field in next)) return null;
  }
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(next)) {
    const before = previous[field];
    if (before === value) continue;
    if (JSON.stringify(before) === JSON.stringify(value)) continue;
    patch[field] = value;
  }
  return patch;
}

// Write one record beside the pages, under the key that shadows the page copy.
// A record store's record is `{ type, params }`; an app's is whatever the app
// assigned, and both are stored the same way here so the paged path carries an
// app's own shape through unchanged.
//
// An OBJECT takes a container, field by field as PLAIN values: every field
// stays a plain value rather than being promoted to a child container, which is
// what keeps the RECORD the merge unit (see the proxy's plain-value
// preservation). Any other value an app assigned (a number, a string, an
// array) is stored as that value, because a container cannot hold one and
// walking its entries into fields is what destroys it: `5` has none, so it
// would store as an empty container, and `'hello'` has one per character.
//
// Takes back the record's delete marker, if it had one: this entry IS the
// record being present. Every write that puts a record back clears the marker,
// here and on the in-place edit of a record still under its own bare key,
// because a marker outranks every copy of a record on a read, so a route that
// left one would re-add a record nothing can read.
function writeRecordContainer(
  m: LoroMap,
  recordKey: string,
  record: unknown,
): void {
  // The RECORD's key, not the key it is written under. Both are strings, so a
  // caller that hands over the key it already computed writes the record one
  // prefix deeper, where every reader resolves a different record. The draft
  // refuses a reserved key at the write, so one arriving here is that mistake.
  assertUsableRecordKey(recordKey);
  clearTombstone(m, recordKey);
  const overlayKey = overlayKeyFor(recordKey);
  if (!isPlainObject(record)) {
    m.set(overlayKey, toPlainDeep(record) as never);
    return;
  }
  const container = overlayContainer(m, overlayKey);
  for (const field of container.keys()) {
    if (!(field in record)) container.delete(field);
  }
  for (const [field, value] of Object.entries(record)) {
    container.set(field, toPlainDeep(value) as never);
  }
}

/**
 * One editing session's writer of dense pages, and the key index that finds
 * records in them.
 *
 * A page is one value, so two writers appending to the same page container
 * resolve last-writer-wins and one writer's records are lost. Each session
 * therefore writes only pages carrying its own token, and never rewrites one
 * it has sealed. Nothing is ever moved out of a container into a page, so no
 * write here can race a peer's edit of a record.
 */
class SessionPager {
  private readonly _index: PagedKeyIndex;
  private readonly _patchIndex = new PatchIndex();
  // Whether the index has been built. A pager over an unpaged root never needs
  // one, so it stays unbuilt until something asks the map where a record is.
  private _live = false;
  private readonly _token: string;
  private _next = -1;

  constructor(private readonly _paging: PagedRootHooks) {
    this._token = _paging.sessionToken();
    this._index = new PagedKeyIndex(() => _paging.stateVersion());
  }

  /** The index, if it is being kept; null when nothing has needed it. */
  get liveIndex(): PagedKeyIndex | null {
    return this._live ? this._index : null;
  }

  /** How many times the page index has been rebuilt. */
  get indexRebuilds(): number {
    return this._index.rebuilds;
  }

  /** Build the index if it does not exist, and bring it up to date. */
  ensureIndex(m: LoroMap): PagedKeyIndex {
    this._live = true;
    this._index.refresh(m);
    return this._index;
  }

  /** The sink a whole-store read feeds the index through, or null when the
   *  index already answers for the map as it stands. Close it with
   *  `endHarvest` once the read has walked every entry. */
  beginHarvest(): RecordLocationSink | null {
    if (this._live && !this._index.stale()) return null;
    this._live = true;
    return this._index.harvest();
  }

  /** Stamp the harvested index as current. */
  endHarvest(): void {
    this._index.stamp();
  }

  /** The patch lookup, brought up to date against the document. Always kept,
   *  unlike the page index: it costs a walk of the keys with no page decode,
   *  and a keyed read that skipped it would return the record's pre-edit copy.
   *
   *  A WRITE takes this once, before its first write, and the `note` / `clear`
   *  calls under it keep that one instance current. Taking it again per record
   *  would rebuild per record, since the version advances as the mutation
   *  writes. */
  patches(m: LoroMap): PatchIndex {
    this._patchIndex.refresh(m, this._paging.stateVersion());
    return this._patchIndex;
  }

  /** Whether the map already stores a record under `key`. Only meaningful
   *  after `ensureIndex`. */
  holds(key: string): boolean {
    return this._index.has(key);
  }

  /** Whether some page's body holds `key`, which stays true after the record
   *  is deleted: a page cannot be rewritten to drop it. Only meaningful after
   *  `ensureIndex`. */
  packedInPage(key: string): boolean {
    return this._index.packedInPage(key);
  }

  /** This writer's token, which names the page and patch keys it may write. */
  get token(): string {
    return this._token;
  }

  /** A patch key for an edit to `recordKey`: this session's token, plus a
   *  counter one above what the record already carries, so the fold applies
   *  this edit over every patch the writer had merged.
   *
   *  `patchIndex` is the same instance `patches` hands out, which the write
   *  path keeps current as it goes; the counter has to come from it rather
   *  than from a rebuild, since a patch this mutation just wrote is one this
   *  one must still mint above. */
  nextPatchKey(recordKey: string, patchIndex: PatchIndex | null): string {
    const counter = (patchIndex ?? this._patchIndex).nextCounterFor(recordKey);
    return patchKeyFor(recordKey, this._token, counter);
  }

  /** Write as many of `records` as fill whole pages, and return how many were
   *  written. A remainder shorter than one page is left to the caller, which
   *  gives it a container each. */
  writePages(
    m: LoroMap,
    records: [string, FlatRecord][],
    perPage: number,
    batcher?: MutateBatcher,
  ): number {
    const pages = Math.floor(records.length / perPage);
    if (pages === 0) return 0;
    for (let p = 0; p < pages; p += 1) {
      const slice = records.slice(p * perPage, (p + 1) * perPage);
      const key = this._mintPageKey(m);
      const encoded = encodePage(slice.map(([k, r]) => packWholeValue(k, r)));
      writePage(m, key, encoded);
      this._index.notePage(
        key,
        slice.map(([k]) => k),
      );
      batcher?.noteKeys(slice.map(([k]) => k));
      // Charged by what the page PACKS rather than by the gzipped bytes it
      // occupies: this is the only charge a bulk add into an already-paged
      // store takes, so pricing it compressed would let the same records ride
      // one op here and several on the route that pages part-way through.
      batcher?.recordChars(encoded.chars);
    }
    return pages * perPage;
  }

  // The next unused page key for this token. Seeded above whatever the store
  // already holds, so a session that reopens a document cannot overwrite the
  // pages an earlier session under the same token sealed, and stepped past any
  // key already occupied by something that is not one of this session's pages.
  private _mintPageKey(m: LoroMap): string {
    if (this._next < 0) {
      let highest = -1;
      for (const key of m.keys()) {
        const parsed = parseSessionPageKey(key);
        if (parsed && parsed.token === this._token) {
          highest = Math.max(highest, parsed.index);
        }
      }
      this._next = highest + 1;
    }
    let key = sessionPageKey(this._token, this._next);
    while (m.get(key) !== undefined) {
      this._next += 1;
      key = sessionPageKey(this._token, this._next);
    }
    this._next += 1;
    return key;
  }
}

// The value a page holds of one record, which is what `sampleBodyBytes` weighs
// to size a page. An app's map packs each record's whole stored value as its
// triple's body (`packWholeValue`), so the record itself is that value.
function pagedBodyOf(entry: [string, FlatRecord]): FlatRecord {
  return entry[1];
}

// ---- Concrete handle implementations ----------------------------------
//
// Both handles wrap an "anchor": a root LoroMap/LoroMovableList directly, or a
// (parent LoroMap, key) pair. The anchor gives the handle stable identity
// even before the container exists (a `doc.map('foo').map('bar')` chain
// returns a working handle for `foo.bar`, created on the first mutate).

interface MapAnchor {
  // The current LoroMap, or null if it doesn't exist yet. MUST return the
  // SAME instance across calls once created; Loro container identity is what
  // its per-container subscribe attaches to.
  resolve(): LoroMap | null;
  // The LoroMap, creating it if necessary. Only called inside a mutate
  // context (the caller has entered the commit pipeline).
  resolveOrCreate(): LoroMap;
  // Drop any memoized container so the next `resolve` re-derives from the
  // parent. A child anchor memoizes its resolved container for stable
  // subscribe identity; on a source swap (version checkout / return-to-head)
  // the parent rebinds but the child would keep returning the old source's
  // container, so `_resync` invalidates it. A no-op for root anchors, which
  // re-point via `rebind`.
  invalidate(): void;
  // The plain value at this anchor's key, when the key holds one instead of a
  // container. Only a CHILD anchor can be in that state (a root key is always
  // a container), so a root anchor omits it.
  plain?(): unknown;
}

interface ListAnchor {
  resolve(): LoroMovableList | null;
  resolveOrCreate(): LoroMovableList;
  invalidate(): void;
  // See `MapAnchor.plain`: a child key can hold a plain array instead of a
  // container, and a scoped handle must read it rather than report it empty.
  plain?(): unknown;
}

// A root anchor is re-pointable: a version checkout swaps the Document's
// active source from the live doc to a materialized preview doc (a DIFFERENT
// LoroDoc), and the handles the app already holds must follow. `rebind` moves
// the anchor to the new container; every read (`read` / `get` / `keys` /
// `has`) already routes through `resolve()`, so it reflects the new source
// with no further change. Between rebinds `resolve()` returns the same
// instance, satisfying the per-container subscribe contract.
interface RootMapAnchor extends MapAnchor {
  rebind(next: LoroMap): void;
}
interface RootListAnchor extends ListAnchor {
  rebind(next: LoroMovableList): void;
}

// A root anchor holds one container that a version checkout swaps in place
// (`rebind`). Between rebinds `resolve()` returns the same instance, so the
// per-container Loro subscription attaches to a stable identity. `LoroMap` and
// `LoroMovableList` roots share this; the kind is the type parameter.
function rootAnchor<C extends LoroMap | LoroMovableList>(
  root: C,
): {
  resolve(): C;
  resolveOrCreate(): C;
  invalidate(): void;
  rebind(next: C): void;
} {
  let current = root;
  return {
    resolve: () => current,
    resolveOrCreate: () => current,
    invalidate: () => {},
    rebind: (next) => {
      current = next;
    },
  };
}

// A child anchor resolves `parent[key]` lazily, then caches the container so
// per-container subscribers attach to a stable instance. `ctor` selects the
// container kind: a value of the wrong kind at the key reads as absent, and
// `resolveOrCreate` mints one only inside a mutate context.
function childAnchor<C extends LoroMap | LoroMovableList>(
  parent: MapAnchor,
  key: string,
  ctor: new () => C,
): {
  resolve(): C | null;
  resolveOrCreate(): C;
  invalidate(): void;
  plain(): unknown;
} {
  // `invalidate` clears the cache on a source swap so the next resolve
  // re-derives through the (rebound) parent.
  let cached: C | null = null;
  // A cached container is stale once it has been detached from the document
  // (deleted from `parent[key]`), which happens on a delete-then-recreate of
  // the key: the recreate mints a NEW container, so a cache holding the old
  // one would read and subscribe against a dead container. `isDeleted()` is
  // the cheap per-resolve check that keeps the cache without going stale;
  // `invalidate()` still handles the source swap (checkout / resync).
  const live = (c: C | null): c is C => c !== null && !c.isDeleted();
  return {
    resolve: () => {
      if (live(cached)) return cached;
      cached = null;
      const p = parent.resolve();
      if (!p) return null;
      const v = p.get(key);
      if (v instanceof ctor) {
        cached = v as C;
        return cached;
      }
      // A container of the OTHER kind reads as absent, and the handle this
      // read minted is one nothing keeps. A live subscription resolves on
      // every change to the document it hangs off, so a handle left undropped
      // here ratchets wasm memory for the length of the session.
      if (isContainer(v)) (v as { free(): void }).free();
      return null;
    },
    resolveOrCreate: () => {
      if (live(cached)) return cached;
      cached = null;
      const p = parent.resolveOrCreate();
      const v = p.get(key);
      if (v instanceof ctor) {
        cached = v as C;
        return cached;
      }
      // The key may hold a PLAIN value rather than a container: that is how a
      // record body is stored above the paging threshold, and how a promoted
      // record is stored beside its pages. Taking a scoped handle there is a
      // request for finer granularity on that record, so the container is
      // seeded from the value it replaces. Creating an empty one instead
      // discards every field the record already had, which the caller cannot
      // see coming: it asked for a handle, not for a delete.
      const created = p.setContainer(key, new ctor());
      if (created instanceof LoroMap && isPlainObject(v)) {
        assignPlain(created, v);
      } else if (created instanceof LoroMovableList && Array.isArray(v)) {
        assignList(created, v);
      }
      cached = created;
      return created;
    },
    // The plain value at this key, when it holds one instead of a container.
    // A read through a scoped handle answers from this rather than reporting
    // the key empty, so `read()` agrees with what the parent map returns.
    plain: () => {
      const p = parent.resolve();
      if (!p) return undefined;
      const v = p.get(key);
      // A container is what `resolve` answers for, whatever kind it is, so
      // what this reports is a plain value or nothing. The handle the read
      // minted goes back either way (see `plainEntry`).
      if (isContainer(v)) {
        (v as { free(): void }).free();
        return undefined;
      }
      return v;
    },
    invalidate: () => {
      cached = null;
    },
  };
}

/**
 * What a composed handle's subscription needs from its handle to follow the
 * entry it was taken for. `read` answers what the entry holds as any other
 * reader sees it, `print` reduces that to a value the tracker can compare, and
 * `catchUp` hands the subscriber the whole entry.
 */
interface EntryTracking<C extends LoroMap | LoroMovableList, V> {
  resolve(): C | null;
  read(): V;
  print(value: V): string;
  catchUp(value: V): void;
  attach(container: C): () => void;
}

/**
 * Keep a composed handle's per-container subscription bound to whatever
 * currently answers for its entry.
 *
 * Which container that is moves under the app. A map key deleted and written
 * again holds a NEW one, and over a paged record store an edit is parked
 * beside the pages first, so for a while none answers for the record at all.
 * Loro's subscribe is per-container, so a subscription bound once goes silent
 * on the record it was taken for while `read()` follows that record, and the
 * app keeps rendering what it last heard with nothing to correct it.
 *
 * `root` is the topmost container of the handle's chain, which the document
 * holds for its whole life, so every write that could reach this entry passes
 * through its subtree and no delete takes the watch down with it. A watch on
 * the nearest live ancestor cannot promise that: deleting that ancestor
 * strands the subscription on a dead container, including for the write that
 * puts the ancestor back.
 *
 * Each fire compares what answers for the entry now against what the
 * subscription is bound to, and on a difference hands the subscriber the whole
 * entry before re-binding, the sequence `_resync` runs for a source swap.
 * `catchUp` runs inside the root's fire, so the subscription `attach` returns
 * misses the batch that made the difference, which is why the whole entry goes
 * first.
 *
 * The print covers an entry no container answers for: its value still moves (a
 * page rewritten around it, an edit beside the pages, a delete marker), and
 * comparing it is the only way to see that. It is taken only while nothing is
 * bound, so an entry with a container of its own costs one cached resolve per
 * fire and no read.
 */
function trackEntryContainer<C extends LoroMap | LoroMovableList, V>(
  root: LoroMap | null,
  spec: EntryTracking<C, V>,
): () => void {
  if (!root) return () => {};
  let bound = spec.resolve();
  let print = bound === null ? spec.print(spec.read()) : '';
  let detach = bound === null ? () => {} : spec.attach(bound);
  const watch = root.subscribe(() => {
    const next = spec.resolve();
    if (next === bound) {
      // A bound container reports its own changes, so there is nothing to
      // compare and nothing to re-bind.
      if (next !== null) return;
      const value = spec.read();
      const current = spec.print(value);
      if (current === print) return;
      print = current;
      spec.catchUp(value);
      return;
    }
    detach();
    bound = next;
    const value = spec.read();
    print = next === null ? spec.print(value) : '';
    spec.catchUp(value);
    detach = next === null ? () => {} : spec.attach(next);
  });
  return () => {
    watch();
    detach();
  };
}

// Shared per-container subscription bookkeeping for both handle kinds. Holds
// the active { callback, detach } records so a version checkout can re-fire
// and re-attach each against the swapped source, and a suspend / close can
// detach them all. Each kind passes in its own whole-container fire and its
// per-container change-attach; this owns only the record set and its
// lifecycle. (The `createEmitter` primitive is a value-fanout with retain /
// dedup, a different shape: it models no per-listener external resource, and
// the Loro subscription each record must re-create on rebind is exactly
// that.)
/** Run a callback the SDK owns, without letting it break the caller. */
/** Report a subscriber that threw, then carry on. One app callback failing
 *  must not break a registration or stop the other subscribers, but swallowing
 *  it leaves an app that stalled inside its own callback with nothing in the
 *  console to read. */
function reportSubscriberThrow(err: unknown): void {
  console.error('[Brass] subscriber threw:', err);
}

function fireQuietly(cb: () => void): void {
  try {
    cb();
  } catch (err) {
    reportSubscriberThrow(err);
  }
}

class SubscriptionRegistry<Cb> {
  private readonly _subs = new Set<{ cb: Cb; detach: () => void }>();
  private readonly _settled = new Set<() => void>();
  // Whether a whole-container delivery is in progress. Always false while a
  // delivery is one synchronous call, and the reason `onSettled` is defined
  // against a delivery rather than against a call: when a delivery arrives in
  // several parts, registering mid-way waits for the end instead of reporting
  // a container the caller has only some of.
  private _delivering = false;

  /**
   * Report each time this container has been delivered whole.
   *
   * Fires on registration, and again after every re-delivery: a version
   * checkout, a return to head, a hydrate. Repeating rather than one-shot is
   * what an app needs, since the work it hangs here (frame the camera, run the
   * first scan, decide whether seeding is safe) is owed again each time the
   * container is replaced under it. A one-shot signal is the bug four demos
   * hand-rolled, where a `firstFire` flag never re-arms and the camera never
   * frames the version the reader switched to.
   *
   * It does NOT fire when some OTHER subscriber registers: that delivery went
   * to one new subscriber, and says nothing to the callers already holding the
   * container.
   *
   * What it can claim is what this peer had converged to when the delivery
   * began. More always arrives afterwards.
   */
  onSettled(cb: () => void): HandleUnsubscribe {
    this._settled.add(cb);
    if (!this._delivering) fireQuietly(cb);
    return () => {
      this._settled.delete(cb);
    };
  }

  private _settle(): void {
    // Copied before the walk: a callback that unsubscribes another would
    // otherwise remove it from the set mid-iteration, and an entry deleted
    // before it is reached is never visited.
    const listeners = Array.from(this._settled);
    for (const cb of listeners) fireQuietly(cb);
  }

  // Fire the whole-container catch-up once, attach the per-container change
  // subscription, track the record, and return an idempotent unsubscribe.
  subscribe(
    cb: Cb,
    fireWhole: (cb: Cb) => void,
    attach: (cb: Cb) => () => void,
  ): HandleUnsubscribe {
    this._delivering = true;
    try {
      fireWhole(cb);
    } finally {
      this._delivering = false;
    }
    const rec = { cb, detach: attach(cb) };
    this._subs.add(rec);
    return () => {
      rec.detach();
      this._subs.delete(rec);
    };
  }

  // Re-fire every active subscriber with the whole current container and
  // re-attach its change subscription to it (checkout / return-to-head).
  resync(fireWhole: (cb: Cb) => void, attach: (cb: Cb) => () => void): void {
    this._delivering = true;
    try {
      for (const rec of this._subs) {
        rec.detach();
        fireWhole(rec.cb);
        rec.detach = attach(rec.cb);
      }
    } finally {
      this._delivering = false;
    }
    // The container has been delivered whole again, which is the transition
    // `onSettled` exists to report.
    this._settle();
  }

  // Detach every active subscription and forget it (suspend / close).
  teardown(): void {
    for (const rec of this._subs) rec.detach();
    this._subs.clear();
    this._settled.clear();
  }
}

/**
 * What a ROOT map handle needs from its owning Document to present a paged
 * store. Bundled rather than passed one by one: every member is read off the
 * ACTIVE source's `meta` at call time (a version checkout swaps the source),
 * and a handle that can never be a paged root is given none of them.
 */
/**
 * The document's version, as the freshness stamp a cached index checks.
 *
 * Loro's frontiers, which advance on every op whatever produced it: a local
 * write, a remote import, an undo, a version checkout. A cached index cannot
 * key on the map's SIZE instead, because a remote change and a local undo can
 * leave the size they found it at while changing which keys are there, and the
 * index then answers from keys the map no longer holds. Reading it costs about
 * 2 us and does not close the open transaction, so a mutation still commits as
 * one change.
 */
export type StateVersion = readonly { peer: string; counter: number }[];

function sameStateVersion(a: StateVersion, b: StateVersion): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.peer !== b[i]!.peer || a[i]!.counter !== b[i]!.counter) {
      return false;
    }
  }
  return true;
}

export interface PagedRootHooks {
  // Whether the root is paged.
  isPaged(): boolean;
  // Mark this root paged. Called when a local write pushes an unpaged root
  // past the threshold.
  page(): void;
  // A token unique to this writer, naming the page keys it may write.
  sessionToken(): string;
  // The document's version, for a cached index to check itself against.
  stateVersion(): StateVersion;
}

/**
 * Hide a handle's own fields from enumeration.
 *
 * A handle is a VIEW onto a container, not the container, so `Object.keys` on
 * one is a natural thing to reach for and it type-checks. Enumerable, it
 * answers with the handle's own fields, which look enough like record keys to
 * pass and are the same handful whatever the document holds, so the mistake
 * reads as a small document rather than as a mistake. Hidden, the answer is
 * empty, and the reader goes looking for `keys()`.
 *
 * Every field is declared with an initialiser, so they all exist by the time
 * this runs and a later assignment keeps the descriptor this sets.
 */
function hideOwnFields(handle: object): void {
  for (const key of Object.keys(handle)) {
    Object.defineProperty(handle, key, { enumerable: false });
  }
}

class MapHandleImpl<T> implements MapHandle<T> {
  private readonly _anchor: MapAnchor;
  private readonly _owner: HandleOwner;
  // How this root reaches its store's paging state. `null` for handles that
  // can never be a paged root (composed child handles, and doc-less roots),
  // which skip the paged paths entirely.
  private readonly _paging: PagedRootHooks | null;
  // Writes this session's own dense pages and indexes the store's records.
  // Built on first use over a paged store and kept for the handle's life; see
  // `SessionPager`.
  private _pager: SessionPager | null = null;
  // Memo for this handle's keyed reads over a paged store; see `PageMemo`.
  private readonly _pageMemo = new PageMemo();
  private readonly _childMaps = new Map<string, MapHandleImpl<unknown>>();
  private readonly _childLists = new Map<string, ListHandleImpl<unknown>>();
  // Active subscriptions, tracked so a version checkout (which swaps the
  // active source doc) can re-fire and re-attach each one against the new
  // container.
  private readonly _registry = new SubscriptionRegistry<
    InternalMapSubscriber<T>
  >();
  // Keys captured just before a rebind (`_rebindAnchor`), consumed by the
  // matching `_resync` to report the keys the source swap removed. Null
  // outside a rebind cycle, so a bare `_resync` reports no removals.
  private _priorKeys: Set<string> | null = null;
  // The handle this one is composed off, or null for a root. A subscription
  // taken before the container exists watches up this chain for the write
  // that creates it (`_nearestLiveContainer`).
  private readonly _parent: MapHandleImpl<unknown> | null;

  constructor(
    anchor: MapAnchor,
    owner: HandleOwner,
    paging: PagedRootHooks | null = null,
    parent: MapHandleImpl<unknown> | null = null,
  ) {
    this._anchor = anchor;
    this._owner = owner;
    this._paging = paging;
    this._parent = parent;
    hideOwnFields(this);
  }

  // The container at the top of this handle's composition chain: the root it
  // is composed off, which the document holds for its whole life (`getMap` is
  // get-or-create, and a root anchor always resolves). A composed handle's
  // subscription watches it rather than its nearest live ancestor, which a
  // delete can take away. Internal: `ListHandleImpl` walks the same chain from
  // its parent.
  _chainRoot(): LoroMap | null {
    return this._parent ? this._parent._chainRoot() : this._anchor.resolve();
  }

  // Whether the map is a PAGED record store. Defined by the root's own `meta`
  // marker (set once when the root is paged, never changed by a field edit),
  // read through the hooks in O(1). MUST stay O(1): it is on the hot path of every
  // `read` / `mutate` (twice per ordered-map edit), so scanning the map to
  // peek tags would make a single field edit O(file).
  private _isPaged(): boolean {
    return this._paging !== null && this._paging.isPaged();
  }

  // This handle's pager, over a store known to be paged. A page is filled in
  // creation order, so the index is what locates a record; it is refreshed
  // against the map here, and every entry point that resolves a record reads a
  // current one.
  private _sessionPager(m: LoroMap): SessionPager {
    this._pager ??= new SessionPager(this._paging!);
    this._pager.ensureIndex(m);
    return this._pager;
  }

  // The plain object this handle's key holds, when it holds a value rather
  // than a container. A record body above the paging threshold is stored that
  // way, so a scoped handle onto one must read it rather than report the key
  // empty; the alternative is a handle that answers `{}` over data the parent
  // map returns in full.
  private _plainBody(): Record<string, unknown> | undefined {
    const v = this._anchor.plain?.();
    return isPlainObject(v) ? v : undefined;
  }

  read(): Record<string, T> {
    this._owner.assertReadable();
    const m = this._anchor.resolve();
    if (!m) return (this._plainBody() ?? {}) as Record<string, T>;
    // A paged map flattens back to the flat lookup, so a read is identical
    // paged or not.
    if (this._isPaged()) return this._readPaged(m);
    return m.toJSON() as Record<string, T>;
  }

  // The whole-store read, which decodes every page. That walk answers the same
  // question a keyed read asks (which page holds which record), so the index
  // takes its answers from it and a `get` after a read costs one page rather
  // than the store.
  private _readPaged(m: LoroMap): Record<string, T> {
    this._pager ??= new SessionPager(this._paging!);
    const sink = this._pager.beginHarvest();
    if (sink === null) return flattenPagedMap(m) as Record<string, T>;
    const flat = flattenPagedMap(m, sink) as Record<string, T>;
    this._pager.endHarvest();
    return flat;
  }

  get(entryKey: string): T | undefined {
    this._owner.assertReadable();
    const m = this._anchor.resolve();
    if (!m) return this._plainBody()?.[entryKey] as T | undefined;
    if (this._isPaged()) {
      const pager = this._sessionPager(m);
      return recordFromPage(
        m,
        entryKey,
        this._pageMemo,
        pager.liveIndex,
        pager.patches(m),
      ) as T | undefined;
    }
    return plainEntry(m, entryKey) as T | undefined;
  }

  keys(): string[] {
    return [...this.liveKeySet()];
  }

  /**
   * The keys this map holds, as a set, without materialising a record.
   *
   * A paged store answers from the page index, which is built from each page's
   * key list and never decodes a body, so asking which keys exist costs a
   * fraction of asking what they hold. Everything that needs membership rather
   * than content goes through here.
   */
  liveKeySet(): Set<string> {
    this._owner.assertReadable();
    const m = this._anchor.resolve();
    if (!m) return new Set(Object.keys(this._plainBody() ?? {}));
    if (this._isPaged()) return this._sessionPager(m).ensureIndex(m).liveKeys();
    return new Set(m.keys());
  }

  has(entryKey: string): boolean {
    this._owner.assertReadable();
    const m = this._anchor.resolve();
    if (!m) {
      const body = this._plainBody();
      return body !== undefined && Object.prototype.hasOwnProperty.call(body, entryKey);
    }
    if (this._isPaged()) return this.get(entryKey) !== undefined;
    return entryExists(m, entryKey);
  }

  mutate(fn: (draft: Record<string, T>) => void): void {
    this._owner.assertWritable();
    this._owner.ensureLocalUpdatesSubscribed();
    // Commits as it goes past a size budget; see `mutate-batching.ts`.
    this._runMutate(
      fn,
      new MutateBatcher(() => {
        this._owner.commitMutate();
      }),
    );
    this._owner.commitMutate();
  }

  // Run a mutate WITHOUT the commit pipeline (the caller owns
  // assertWritable / ensureLocalUpdatesSubscribed / commit). The seam the
  // ordered-map primitive drives so a map edit and its sibling order-list
  // edit land in ONE commit (one undo step).
  _runMutate(
    fn: (draft: Record<string, T>) => void,
    batcher?: MutateBatcher,
  ): void {
    const m = this._anchor.resolveOrCreate();
    this._pageIfOutgrown(m);
    if (this._isPaged()) {
      const pager = this._sessionPager(m);
      mutatePaged(m, fn, pager, batcher);
      return;
    }
    const divert = this._paging ? this._pagingDivert(m, batcher) : null;
    const proxy = wrapLoroMapProxy(
      m,
      batcher,
      divert?.hooks,
      this._paging !== null,
    ) as Record<string, T>;
    fn(proxy);
    divert?.finish();
  }

  // Route this mutation's ADDITIONS into pages from the moment the map
  // outgrows the threshold, rather than only from the next mutation.
  //
  // One `mutate` is allowed to be as large as an app likes (it commits as it
  // goes past a size budget), so the mutation that fills a map is routinely
  // the same one that pushes it past the threshold, and a map checked only on
  // the way in would never page at all for an app that writes in one call.
  //
  // Only additions divert. A key the map already stores is an edit of a record
  // this writer does not own, and moving it would mean deleting a container a
  // peer may be writing to at that moment.
  private _pagingDivert(
    m: LoroMap,
    batcher?: MutateBatcher,
  ): { hooks: WriteDivert; finish: () => void } {
    // Additions waiting to be sealed into a page, in creation order. A page
    // packs whatever value a record is, and `writeRecordContainer` writes an
    // object as fields and anything else as the value it is, so a buffer here
    // carries the app's value through whichever of the two it ends up taking.
    const held = new Map<string, FlatRecord>();
    // Additions taken before this mutation is known to be bulk. They are held
    // rather than written as a container each, because a container written now
    // is one this write can never take back: nothing already stored moves, so
    // the first `UNPAGED_MAX_RECORDS` records of a bulk write would stay
    // containers for the life of the document. Holding them costs their size
    // until the decision and lets the whole write be paged.
    //
    // Holding is not the fold that is unsafe. A record created inside a
    // mutation that is still running has never been visible to a peer, so
    // nothing is deleted and nothing is raced; the choice is only which shape
    // to write it in.
    const pending = new Map<string, FlatRecord>();
    // Additions that must take a container of their own instead: a key this
    // mutation deleted out of a sealed page keeps its tombstone (the page
    // cannot be rewritten to drop the old copy), and the container is what
    // outranks both. Paging it again would leave two pages claiming the key.
    const contained = new Map<string, FlatRecord>();
    // Keys the mutation deleted that a sealed page still holds. A page cannot
    // be rewritten to drop one, so each becomes a tombstone at the end.
    const removed = new Set<string>();
    const memo = new PageMemo();
    let pager: SessionPager | null = null;

    // The record count this mutation will leave behind: what the map holds
    // plus what is held out of it. Counting only the map would never reach the
    // threshold once records are held rather than written.
    const totalRecords = (): number => m.size + pending.size + held.size;

    const startPaging = (): boolean => {
      if (pager) return true;
      if (totalRecords() <= UNPAGED_MAX_RECORDS) return false;
      this._paging!.page();
      pager = this._sessionPager(m);
      // Built while the map is still all containers, so this is a walk of the
      // keys rather than a decode of every page.
      pager.ensureIndex(m);
      // Everything held back before the threshold was crossed goes into pages
      // with the rest, which is the whole point of having held it.
      for (const [key, record] of pending) held.set(key, record);
      pending.clear();
      return true;
    };

    // A record this mutation already sealed into a page. Once sealed it is no
    // longer in `held` and not in the live map either, so without this the
    // mutation's own later read of it comes back undefined and its own later
    // delete of it silently does nothing.
    const sealedRecord = (key: string): FlatRecord | undefined => {
      const index = pager?.liveIndex;
      const pageKey = index?.readsFromPage(key);
      if (pageKey === undefined) return undefined;
      return memo.resolve(pageKey, plainEntry(m, pageKey)).get(key);
    };

    // Seal whole pages out of what is held, leaving any remainder for the next
    // boundary. Runs at each commit the batcher takes, so a mutation of any
    // size ships its pages as it goes instead of as one op at the end.
    const sealPages = (): void => {
      if (!pager || held.size === 0) return;
      const records = [...held];
      const perPage = recordsPerPage(sampleBodyBytes(records, pagedBodyOf));
      const written = pager.writePages(m, records, perPage);
      const sealed: string[] = [];
      for (let i = 0; i < written; i += 1) {
        sealed.push(records[i]![0]);
        held.delete(records[i]![0]);
      }
      // Named to the commit this seal runs just ahead of, which is what lets
      // an ordered map append the order entries for these records alongside
      // them instead of appending the whole list at the first commit. The
      // batcher is not passed to `writePages` above, since charging a page
      // there would take a commit inside a commit.
      batcher?.noteKeys(sealed);
    };
    batcher?.onFlush(sealPages);

    const hooks: WriteDivert = {
      take: (key, value) => {
        // A key this mutation is already buffering keeps its buffer, whatever
        // shape the new value is. Declining it would write to the map behind
        // the buffer, which `finish` would then overwrite with the value the
        // buffer still held.
        if (held.has(key)) {
          held.set(key, toPlainDeep(value));
          return true;
        }
        if (contained.has(key)) {
          contained.set(key, toPlainDeep(value));
          return true;
        }
        if (pending.has(key)) {
          pending.set(key, toPlainDeep(value));
          return true;
        }
        // An existing key is an edit, and an edit keeps whatever shape the
        // record already has, so it is never held.
        if (m.get(key) !== undefined) return false;
        if (!startPaging()) {
          // Only a RECORD is held. A map entry that is a scalar, a string, an
          // array, or a container is not what paging packs, and holding one
          // would hand `finish` a value it can only write as a record: a
          // boolean comes back as an empty container. Those keep the write
          // they have always had.
          if (!isPlainObject(value)) return false;
          // Undecided: hold the addition and re-ask, since this one may be
          // what crosses the threshold.
          pending.set(key, toPlainDeep(value));
          startPaging();
          return true;
        }
        // A key this mutation already sealed into a page, or deleted out of
        // one, takes a container of its own. The page keeps its copy either
        // way, so declining the write would leave the record stored twice: the
        // map's own key beside the page's stale copy, which a keyed read and a
        // streaming read then answer differently.
        if (pager!.packedInPage(key) || removed.has(key)) {
          contained.set(key, toPlainDeep(value));
          return true;
        }
        // A container already answers for this key (a record written before
        // the crossing), so the write goes into it as an ordinary edit.
        if (pager!.holds(key)) return false;
        held.set(key, toPlainDeep(value));
        return true;
      },
      holds: (key) => {
        if (held.has(key) || contained.has(key) || pending.has(key)) return true;
        if (removed.has(key)) return false;
        return sealedRecord(key) !== undefined;
      },
      peek: (key) => {
        if (pending.has(key)) return pending.get(key);
        if (held.has(key)) return held.get(key);
        if (contained.has(key)) return contained.get(key);
        return removed.has(key) ? undefined : sealedRecord(key);
      },
      drop: (key) => {
        held.delete(key);
        pending.delete(key);
        contained.delete(key);
        if (sealedRecord(key) !== undefined) removed.add(key);
      },
      keys: () => {
        const keys = new Set([
          ...held.keys(),
          ...pending.keys(),
          ...contained.keys(),
        ]);
        for (const key of removed) {
          if (!contained.has(key)) keys.delete(key);
        }
        return [...keys];
      },
    };

    return {
      hooks,
      finish: () => {
        // The mutation ended below the threshold, so the store stays unpaged
        // and these take exactly the shape the undiverted write gives them: a
        // container under their own key, filled by `assignPlain`, which is
        // what makes a nested object a container a scoped handle can anchor
        // on. `writeRecordContainer` writes fields as plain values instead,
        // so a record written through it has no `props` container for
        // `handle.map('props')` to reach.
        //
        // Charged HERE rather than where the draft took them, because holding
        // is what decides that a record's bytes land in this commit and not an
        // earlier one: a write charged on the way in commits its neighbours
        // while its own value is still held, so a mutation that holds
        // everything would spend its boundaries on empty commits and then put
        // every record in the one op at the end.
        for (const [key, record] of pending) {
          // Only an OBJECT takes a container filled field by field. A buffered
          // key is re-taken whatever shape the new value is, so a rewrite can
          // leave a string, a number, or an array here, and `assignPlain`
          // walks a value's entries into fields: it would store `'hello'` as
          // one field per character and `5` as an empty container, losing what
          // the app assigned. `assignEntry` is the same write the map makes
          // for a key the divert declined, so the two shapes agree.
          if (isPlainObject(record)) {
            const existing = m.get(key);
            const sub =
              existing instanceof LoroMap
                ? existing
                : m.setContainer(key, new LoroMap());
            assignPlain(sub, record);
          } else {
            assignEntry(m, key, record);
          }
          batcher?.noteKeys([key]);
          batcher?.record(record);
        }
        pending.clear();
        sealPages();
        // Every write below is charged the same way the draft's own
        // assignments are, because the charge the draft took paid for BUFFERING
        // the value, not for writing it. These loops run after the last
        // boundary the mutation took, so a route that only names its keys puts
        // its whole write in the final commit however much it holds:
        // `contained` grows with the records a mutation rewrites after sealing
        // them, and at 50,000 that op reaches 12 MiB, past what the document
        // can store at all.
        //
        // The remainder is taken out of `held` first, so a commit these charges
        // trigger runs `sealPages` over an empty buffer rather than over the
        // map this loop is walking.
        const remainder = [...held];
        held.clear();
        // A remainder shorter than a page takes a container each, which is
        // what it would have had anyway.
        for (const [key, record] of remainder) {
          batcher?.record(record);
          writeRecordContainer(m, key, record);
          pager!.liveIndex?.noteContained(key);
          batcher?.noteKeys([key]);
        }
        for (const key of removed) {
          if (contained.has(key)) continue;
          batcher?.recordDelete(key);
          markDeleted(m, key);
          pager!.liveIndex?.noteRemoved(key);
          batcher?.noteKeys([key]);
        }
        removed.clear();
        for (const [key, record] of contained) {
          batcher?.record(record);
          writeRecordContainer(m, key, record);
          pager!.liveIndex?.noteContained(key);
          batcher?.noteKeys([key]);
        }
        contained.clear();
      },
    };
  }

  // Page this root once it has outgrown the one-container-per-record shape.
  //
  // The cost of reading a map back rises faster than its entry count (measured
  // at ~12us an entry at 12,500 entries and ~145us at 200,000), so a map an app
  // keeps filling eventually costs minutes to read on the reload after it is
  // written. Paging is what holds the entry count down, and an app should not
  // have to ask for it, so the threshold is checked here: on the write that
  // crosses it, the root is stamped paged and everything added from then on is
  // written into pages.
  //
  // Nothing already stored moves. A record in its own container reads as a
  // stray, which already outranks a page, so leaving them costs one entry each
  // and no correctness. Moving them would mean deleting containers a peer may
  // be editing at that moment, and a delete concurrent with an edit discards
  // the edit.
  private _pageIfOutgrown(m: LoroMap): void {
    if (!this._paging || this._isPaged()) return;
    if (m.size <= UNPAGED_MAX_RECORDS) return;
    this._paging.page();
  }

  /** @internal How many times this handle's page index has been rebuilt, for a
   *  test to pin that an ordinary edit does not force one. A rebuild decodes
   *  every page, so the count is the difference between an edit costing a
   *  record and one costing the store. */
  _pageIndexRebuilds(): number {
    return this._pager?.indexRebuilds ?? 0;
  }

  // A predicate over the key set the map held when this was taken, resolved
  // ONCE so a caller checking many keys doesn't re-scan per key. The
  // ordered-map primitive uses it to decide, per set, whether a key is new
  // (and so must be appended to the order list) without paying O(map) per
  // added key.
  //
  // "When this was taken" is the whole contract, and it is why the unpaged
  // branch copies the key set rather than asking the live map per call. A
  // mutation's own writes reach that map as they are made, so a live predicate
  // reports a key by what this batch has done to it so far: a key deleted and
  // re-added reads absent and is appended a second time, and a key added
  // through the paging divert (which holds additions back) reads absent even
  // after the batch has written it. The caller tracks the batch's own
  // additions and removals on top of a start-of-batch answer, which is what
  // the paged branch already gives it.
  _existsChecker(): (key: string) => boolean {
    const m = this._anchor.resolve();
    if (!m) return () => false;
    if (this._isPaged()) {
      // The index answers from one walk of the pages' key lists instead of a
      // page decode per key, which is what keeps a bulk insert through the
      // ordered map off an O(keys x page) path.
      const index = this._sessionPager(m).ensureIndex(m);
      return (key) => index.has(key);
    }
    // One walk of an unpaged map, whose size the paging threshold bounds, and
    // no wasm handle minted per key the way a per-key read would.
    const keys = new Set(m.keys());
    return (key) => keys.has(key);
  }

  // Fire a subscriber once with the whole map as `change.set`, so a
  // subscriber is ONE loop with no initial-vs-update branch and no
  // `if (value)` guard (the footgun that left a view stale after an undo /
  // remote delete emptied the container). Flagged `resync: true` and carries
  // no `origin`: this is a whole-container catch-up (registration, or a
  // checkout / return swapping the source), not an authored transition.
  //
  // `deleted` is empty for a registration fire (the subscriber holds no prior
  // state). On a resync it carries the keys that were present before the
  // source swap but are gone after it: a checkout to a version with fewer
  // records must tell a delta-reconcile subscriber to drop those keys, or they
  // linger as phantom records in the preview. `_resync` computes it.
  // `snapshot` is the map as a caller has ALREADY read it, so a tracker that
  // read the entry to decide whether to fire does not read it a second time to
  // fire it.
  private _fireWhole(
    cb: InternalMapSubscriber<T>,
    deleted: string[] = [],
    snapshot?: Record<string, T>,
  ): void {
    try {
      cb(
        {
          set: new Map<string, T>(Object.entries(snapshot ?? this.read())),
          deleted,
        },
        undefined,
        true,
      );
    } catch (err) {
      reportSubscriberThrow(err);
    }
  }

  // Attach the change subscription for `cb`, returning its detach.
  //
  // A ROOT handle binds straight to its container: that container is the
  // document's for its whole life, so nothing can move out from under the
  // subscription except a source swap, which `_resync` re-runs this for.
  //
  // A COMPOSED handle's entry is not that stable. Which container answers for
  // it changes as the entry is deleted and written again, and over a paged
  // record store it can be nothing at all while an edit sits beside the pages,
  // so its subscription tracks the entry instead of binding once (see
  // `trackEntryContainer`).
  private _attachChange(cb: InternalMapSubscriber<T>): () => void {
    if (this._parent === null) {
      const m = this._anchor.resolve();
      return m === null ? () => {} : this._subscribeContainer(m, cb);
    }
    // The keys the subscriber has been told this entry holds, folded from
    // every change it has been handed. A re-bind names the ones the container
    // now answering does not carry: a subscriber folds `set` over `deleted`,
    // so a key it is never told is gone stays in its model and renders as a
    // field of a record that no longer has it.
    const known = new Set<string>(Object.keys(this.read()));
    const fold: InternalMapSubscriber<T> = (change, origin, resync) => {
      for (const key of change.deleted) known.delete(key);
      for (const key of change.set.keys()) known.add(key);
      cb(change, origin, resync);
    };
    return trackEntryContainer<LoroMap, Record<string, T>>(this._chainRoot(), {
      resolve: () => this._anchor.resolve(),
      read: () => this.read(),
      print: (value) => JSON.stringify(value),
      catchUp: (value) => {
        const deleted = [...known].filter((key) => !(key in value));
        this._fireWhole(fold, deleted, value);
      },
      attach: (m) => this._subscribeContainer(m, fold),
    });
  }

  // Subscribe `cb` to one container's own changes, returning its detach. The
  // instance is captured here (Loro's subscribe is per-container), so
  // whatever re-binds calls this again against the container it re-binds to.
  private _subscribeContainer(
    m: LoroMap,
    cb: InternalMapSubscriber<T>,
  ): () => void {
    // Paged delta needs prior page state to spot deleted records, so index
    // the pages once now; the index advances on every fire or its next delete
    // diff is wrong. Unpaged maps read their delta off the Loro diff.
    let index = this._isPaged() ? buildPagedDeltaIndex(m) : null;
    const depth = containerDepth(m);
    const sub = m.subscribe((event) => {
      // Which reading the delta takes is decided per BATCH, not once at
      // attach: a store crosses the paging threshold while its subscriptions
      // are live, and one attached before the crossing would otherwise keep
      // reporting the map's raw keys, naming pages and overlay slots as if
      // they were records and never naming a record added after it.
      //
      // The index holds the pages this subscriber has already been told
      // about, so a subscription that has been reading an unpaged store
      // starts from none: while the store was unpaged there were no pages,
      // and the batch that pages it names every page it creates. What the
      // store answers for from outside its pages is read off the map here,
      // because a store that paged remotely can arrive already carrying edits
      // and deletes this subscription has never seen a key for.
      if (index === null && this._isPaged()) {
        index = {
          pages: new Map<string, Set<string>>(),
          shadowed: shadowedRecords(m),
        };
      }
      const change = (
        index
          ? pagedMapDelta(m, event, index, (key) => this.get(key))
          : unpagedMapDelta(m, depth, event)
      ) as Change<T>;
      const origin: ChangeOrigin = { source: this._owner.originOf(event) };
      try {
        cb(change, origin, false);
      } catch (err) {
        reportSubscriberThrow(err);
      }
    });
    return () => sub();
  }

  onSettled(cb: () => void): HandleUnsubscribe {
    this._owner.assertReadable();
    return this._registry.onSettled(cb);
  }

  subscribe(cb: MapSubscriber<T>): HandleUnsubscribe {
    this._owner.assertReadable();
    // App subscribers see `(change, origin?)`; the internal re-sync flag is
    // dropped here so it never leaks into the public surface.
    return this._subscribeInternal((change, origin) => cb(change, origin));
  }

  // Internal: like `subscribe`, but the callback also receives whether the
  // fire is a whole-container re-sync. Only the ordered-map wrapper uses it,
  // to re-check `instance_order` on a source swap without inspecting `origin`.
  _subscribeInternal(cb: InternalMapSubscriber<T>): HandleUnsubscribe {
    return this._registry.subscribe(
      cb,
      (c) => this._fireWhole(c),
      (c) => this._attachChange(c),
    );
  }

  // Re-point this ROOT handle to `next` (a container in the newly-active
  // source doc) WITHOUT firing yet. Called by the Document on a version
  // checkout / return-to-head. Snapshots the subtree's current keys first,
  // before the anchor moves, so the subsequent `_resync` can report which keys
  // the swap removed. Rebind and resync are two phases (see
  // `_rebindRootHandles`) because the ordered map reads its sibling order list
  // while firing its map: both anchors must already point at the new source
  // when either fires, or the map redraw reads a half-swapped order list.
  _rebindAnchor(next: LoroMap): void {
    this._snapshotPriorKeys();
    (this._anchor as RootMapAnchor).rebind(next);
  }

  // Capture the current key set of this handle and its composed child maps,
  // read against the source the handle currently describes, so `_resync` can
  // diff it against the post-rebind source to find removed keys. Child maps
  // resolve through this anchor, so they must be read now too.
  //
  // Reading keys depends on whether the store is paged, and a handle answers
  // that from the Document's ACTIVE source rather than from its own anchor, so
  // a correct snapshot needs both to still name the old source. The two move
  // separately across a checkout (the Document repoints the active source, then
  // rebinds the anchors), which is why `_snapshotRootHandleKeys` takes the
  // snapshot before EITHER moves and this is idempotent: the `_rebindAnchor`
  // call is the backstop for a rebind that arrives without that phase, and must
  // not overwrite a snapshot already taken against the right source.
  _snapshotPriorKeys(): void {
    if (this._priorKeys !== null) return;
    this._priorKeys = new Set(Object.keys(this.read()));
    for (const child of this._childMaps.values()) child._snapshotPriorKeys();
  }

  // Re-fire every active subscriber with the whole current container (plus the
  // keys the source swap removed, from the pre-rebind snapshot) and re-attach
  // its change subscription to it, then recurse into composed child handles
  // (their anchors resolve through this one, so they already point at the new
  // source; their subscriptions still need re-attaching). Idempotent and safe
  // when there are no subscribers.
  _resync(): void {
    // Re-derive this handle's container from the (already-rebound) parent
    // before reading or re-attaching: a child anchor caches its resolved
    // container, and after a source swap that cache points at the old source.
    // Prior keys were snapshotted pre-rebind, so this cannot lose them.
    this._anchor.invalidate();
    // The index describes the container set of ONE source, and a checkout /
    // return-to-head swaps it.
    this._pager = null;
    const prior = this._priorKeys;
    this._priorKeys = null;
    const currentKeys = new Set(Object.keys(this.read()));
    const removed = prior
      ? [...prior].filter((k) => !currentKeys.has(k))
      : [];
    this._registry.resync(
      (c) => this._fireWhole(c, removed),
      (c) => this._attachChange(c),
    );
    for (const child of this._childMaps.values()) child._resync();
    for (const child of this._childLists.values()) child._resync();
  }

  // Detach every active per-container subscription (this handle's and its
  // composed children's) and forget them. The Document calls this when it
  // suspends (parks) or closes: a parked doc keeps applying remote ops to its
  // live containers, so a Loro subscription an app registered before `close()`
  // would otherwise keep firing the app's callback on a doc it has closed.
  _teardownSubs(): void {
    this._registry.teardown();
    for (const child of this._childMaps.values()) child._teardownSubs();
    for (const child of this._childLists.values()) child._teardownSubs();
  }

  map<U>(entryKey: string): MapHandle<U> {
    let h = this._childMaps.get(entryKey);
    if (!h) {
      h = new MapHandleImpl<unknown>(
        this._entryAnchor(entryKey, LoroMap),
        this._owner,
        null,
        this as MapHandleImpl<unknown>,
      );
      this._childMaps.set(entryKey, h);
    }
    return h as unknown as MapHandle<U>;
  }

  list<U>(entryKey: string): ListHandle<U> {
    let h = this._childLists.get(entryKey);
    if (!h) {
      h = new ListHandleImpl<unknown>(
        this._entryAnchor(entryKey, LoroMovableList),
        this._owner,
        this as MapHandleImpl<unknown>,
      );
      this._childLists.set(entryKey, h);
    }
    return h as unknown as ListHandle<U>;
  }

  /**
   * The anchor a scoped handle onto one ENTRY of this map reads and writes
   * through.
   *
   * On a root that can be a record store the entry is a RECORD, and where a
   * record is stored is a property of the store's size: above the paging
   * threshold it is packed into a page rather than held under its own key. An
   * anchor that resolves `parent[entryKey]` therefore finds nothing on a large
   * store, and creating a container there mints an EMPTY record that outranks
   * the page's copy, so `records.map(id)` destroys the record it was asked
   * for. The paged anchor below resolves through the same presentation every
   * other reader uses, and writes by taking the record over into a container
   * of its own beside the pages.
   *
   * A composed child (a record's `params`) holds fields rather than records
   * and takes the plain anchor: `_paging` is null there, so nothing below a
   * root ever reaches the paged path.
   */
  private _entryAnchor<C extends LoroMap | LoroMovableList>(
    entryKey: string,
    ctor: new () => C,
  ): {
    resolve(): C | null;
    resolveOrCreate(): C;
    invalidate(): void;
    plain(): unknown;
  } {
    // Where a record written before the store paged still sits, and where a
    // record taken over by an edit goes. Both cache their resolved container,
    // so a per-container subscription keeps a stable instance across reads.
    const direct = childAnchor(this._anchor, entryKey, ctor);
    if (this._paging === null) return direct;
    assertUsableRecordKey(entryKey);
    const overlay = childAnchor(this._anchor, overlayKeyFor(entryKey), ctor);

    // Whether an edit written beside the pages is waiting to be folded over
    // this record. Asked only once a container has been found, since a record
    // with no container of its own is answered from the flattened value
    // either way. The patch index is a walk of the map's key list, so this
    // takes the pager WITHOUT the page index: learning which page holds each
    // record reads every page's key list, which no answer here needs.
    const patched = (m: LoroMap): boolean => {
      this._pager ??= new SessionPager(this._paging!);
      const keys = this._pager.patches(m).keysFor(entryKey);
      return keys !== undefined && keys.length > 0;
    };

    return {
      resolve: () => {
        if (!this._isPaged()) return direct.resolve();
        const m = this._anchor.resolve();
        if (!m) return null;
        // A delete outranks every copy of the record, so a container a page
        // still shadows reads as absent here as it does everywhere else.
        if (entryExists(m, tombstoneKeyFor(entryKey))) return null;
        // Same precedence as `recordBeforePatches`: the edit beside the pages,
        // then the record under its own key.
        const own = overlay.resolve() ?? direct.resolve();
        if (own === null) return null;
        // A patch is folded over the record's own copy on every read, so while
        // one exists the container alone is not the record. Answering from it
        // would report a record the parent map does not.
        return patched(m) ? null : own;
      },
      resolveOrCreate: () => {
        if (!this._isPaged()) return direct.resolveOrCreate();
        const m = this._anchor.resolveOrCreate();
        const pager = this._sessionPager(m);
        const patchIndex = pager.patches(m);
        const patchKeys = patchIndex.keysFor(entryKey);
        const hadPatches = patchKeys !== undefined && patchKeys.length > 0;
        // The record as every other reader resolves it, taken before this
        // handle takes it over.
        const record = recordFromPage(
          m,
          entryKey,
          this._pageMemo,
          pager.liveIndex,
          patchIndex,
        );
        // From here the container IS the record, so the same bookkeeping a
        // whole-record write settles is settled here: a patch left behind
        // applies over the container on the next read and would undo whatever
        // this handle writes, and a delete marker left behind would hide it.
        dropPatches(m, patchIndex, entryKey);
        clearTombstone(m, entryKey);
        const existing = overlay.resolve() ?? direct.resolve();
        // A container that already holds the whole record is edited in place.
        // Seeding it again would rewrite every field, which costs the snapshot
        // an edit per field and hands a peer's concurrent field edit a
        // conflict this write has no reason to raise.
        if (existing !== null && !hadPatches) {
          pager.liveIndex?.noteContained(entryKey);
          return existing;
        }
        const target = existing ?? overlay.resolveOrCreate();
        if (target instanceof LoroMap) {
          if (isPlainObject(record)) assignPlain(target, record);
        } else if (Array.isArray(record)) {
          assignList(target as LoroMovableList, record);
        }
        pager.liveIndex?.noteContained(entryKey);
        return target;
      },
      // The record as the parent map reports it, for the reads that run when
      // no container answers: packed in a page, or held as one plain value.
      plain: () => {
        if (!this._isPaged()) return direct.plain();
        const m = this._anchor.resolve();
        if (!m) return undefined;
        const pager = this._sessionPager(m);
        return recordFromPage(
          m,
          entryKey,
          this._pageMemo,
          pager.liveIndex,
          pager.patches(m),
        );
      },
      invalidate: () => {
        direct.invalidate();
        overlay.invalidate();
      },
    };
  }
}

/**
 * Loro's list diff as absolute splices.
 *
 * The diff is a retain / insert / delete stream over a moving cursor, which is
 * the same information in a shape a caller has to walk statefully. Splices
 * carry the position each edit lands at, so an app applies them in order and
 * is done; nothing about the cursor reaches it.
 */
function splicesFromListDiff(diff: readonly Delta<unknown[]>[]): Splice<unknown>[] {
  const out: Splice<unknown>[] = [];
  let at = 0;
  for (const part of diff) {
    if (part.retain !== undefined) {
      at += part.retain;
      continue;
    }
    if (part.delete !== undefined) {
      out.push({ at, removed: part.delete, inserted: [] });
      continue;
    }
    if (part.insert !== undefined) {
      const inserted = part.insert.map(plainDiffItem);
      out.push({ at, removed: 0, inserted });
      at += inserted.length;
    }
  }
  return out;
}

/**
 * One inserted element as plain data.
 *
 * An object or array element is stored as a child container, and the diff
 * names it as the raw engine handle. A subscriber applies its splices into
 * whatever it is rendering from, so handing it that handle both takes the app
 * onto the CRDT engine's own surface (a field read off it answers `undefined`,
 * while `JSON.stringify` still prints the record, so the failure is silent)
 * and hands it a pointer that outlives nothing: it is freed with the document.
 * The whole-container fire converts through `read()`; this is the same
 * conversion for the delta.
 */
function plainDiffItem(item: unknown): unknown {
  return isContainer(item) ? (item as { toJSON(): unknown }).toJSON() : item;
}

class ListHandleImpl<T> implements ListHandle<T> {
  // How many items each subscriber currently believes it holds, so a whole
  // fire can say what it replaces. Tracked per subscriber rather than read off
  // the container, because a resync swaps the source and the container's own
  // length says nothing about what this subscriber was handed before it.
  private readonly _held = new Map<InternalListSubscriber, number>();

  private readonly _anchor: ListAnchor;
  private readonly _owner: HandleOwner;
  // Active subscriptions, tracked so a version checkout can re-fire and
  // re-attach each one against the new container.
  private readonly _registry =
    new SubscriptionRegistry<InternalListSubscriber>();
  // See `MapHandleImpl._parent`.
  private readonly _parent: MapHandleImpl<unknown> | null;

  constructor(
    anchor: ListAnchor,
    owner: HandleOwner,
    parent: MapHandleImpl<unknown> | null = null,
  ) {
    this._anchor = anchor;
    this._owner = owner;
    this._parent = parent;
    hideOwnFields(this);
  }

  // The plain array this handle's key holds, when it holds a value rather
  // than a container. See `MapHandleImpl._plainBody`.
  private _plainBody(): unknown[] | undefined {
    const v = this._anchor.plain?.();
    return Array.isArray(v) ? v : undefined;
  }

  read(): T[] {
    this._owner.assertReadable();
    const l = this._anchor.resolve();
    if (!l) return (this._plainBody() ?? []) as T[];
    return l.toJSON() as T[];
  }

  length(): number {
    this._owner.assertReadable();
    const l = this._anchor.resolve();
    return l ? l.length : (this._plainBody()?.length ?? 0);
  }

  mutate(fn: (draft: ListDraft<T>) => void): void {
    this._owner.assertWritable();
    this._owner.ensureLocalUpdatesSubscribed();
    // Commits as it goes past a size budget; see `mutate-batching.ts`.
    this._runMutate(
      fn,
      new MutateBatcher(() => {
        this._owner.commitMutate();
      }),
    );
    this._owner.commitMutate();
  }

  // Run a list mutate without the commit pipeline; see
  // `MapHandleImpl._runMutate`. The ordered-map primitive drives this to
  // reconcile the order list in the same commit as the map edit, and passes
  // no batcher: that call already runs at one of the map's batch boundaries
  // and reconciles only the keys that boundary carries, so its own size is
  // bounded by the budget the map is spending.
  _runMutate(fn: (draft: ListDraft<T>) => void, batcher?: MutateBatcher): void {
    const l = this._anchor.resolveOrCreate();
    const proxy = wrapLoroListProxy(l, batcher) as ListDraft<T>;
    fn(proxy);
  }

  // Fire the whole list as ONE splice replacing everything the subscriber was
  // last told. Used for registration and for a checkout / return resync, which
  // describe no authored transition and so carry no origin.
  //
  // `removed` is what this subscriber currently believes it holds, which the
  // registry tracks per subscriber rather than reading off the container: a
  // resync swaps the source, so the container's own length says nothing about
  // what the subscriber was handed before it. That is what lets an app apply
  // every fire the same way instead of recognising a catch-up.
  private _fireWhole(cb: InternalListSubscriber): void {
    const inserted = this.read() as unknown[];
    const held = this._held.get(cb) ?? 0;
    this._held.set(cb, inserted.length);
    try {
      cb({ splices: [{ at: 0, removed: held, inserted }] });
    } catch (err) {
      reportSubscriberThrow(err);
    }
  }

  // Attach the change subscription for `cb`, returning its detach. A root
  // list binds straight to its container; a composed one tracks the entry as
  // it is deleted and written again (see `MapHandleImpl._attachChange`). A
  // list fire carries no delta, so the tracker needs no key bookkeeping: a
  // re-bind is a re-read signal like any other fire.
  private _attachChange(cb: InternalListSubscriber): () => void {
    if (this._parent === null) {
      const l = this._anchor.resolve();
      return l === null ? () => {} : this._subscribeContainer(l, cb);
    }
    return trackEntryContainer<LoroMovableList, T[]>(this._parent._chainRoot(), {
      resolve: () => this._anchor.resolve(),
      read: () => this.read(),
      print: (value) => JSON.stringify(value),
      catchUp: () => this._fireWhole(cb),
      attach: (l) => this._subscribeContainer(l, cb),
    });
  }

  // Subscribe `cb` to one container's own changes; see
  // `MapHandleImpl._subscribeContainer`.
  private _subscribeContainer(
    l: LoroMovableList,
    cb: InternalListSubscriber,
  ): () => void {
    const sub = l.subscribe((event) => {
      const diff =
        event.events[0]?.diff.type === 'list'
          ? (event.events[0].diff.diff as readonly Delta<unknown[]>[])
          : [];
      const splices = splicesFromListDiff(diff);
      let held = this._held.get(cb) ?? 0;
      for (const splice of splices) held += splice.inserted.length - splice.removed;
      this._held.set(cb, held);
      try {
        cb({ splices }, { source: this._owner.originOf(event) });
      } catch (err) {
        reportSubscriberThrow(err);
      }
    });
    return () => sub();
  }

  onSettled(cb: () => void): HandleUnsubscribe {
    this._owner.assertReadable();
    return this._registry.onSettled(cb);
  }

  subscribe(cb: ListSubscriber<T>): HandleUnsubscribe {
    this._owner.assertReadable();
    // App subscribers see the change; the internal origin is dropped here so
    // it never leaks into the public surface.
    return this._subscribeInternal((change) => cb(change as ListChange<T>));
  }

  // Internal: like `subscribe`, but the callback also receives what produced
  // the change. Only the ordered-map wrapper uses it, to stamp an `order`
  // frame the order list's own move produced.
  _subscribeInternal(cb: InternalListSubscriber): HandleUnsubscribe {
    return this._registry.subscribe(
      cb,
      (c) => this._fireWhole(c),
      (c) => this._attachChange(c),
    );
  }

  // Re-point this ROOT list handle to `next` without firing (see
  // MapHandleImpl._rebindAnchor). Lists carry no per-key delta, so there is
  // no prior-key snapshot to take; the resync fire is a re-read signal.
  _rebindAnchor(next: LoroMovableList): void {
    (this._anchor as RootListAnchor).rebind(next);
  }

  // Re-fire + re-attach every active subscriber against the current
  // container (see MapHandleImpl._resync). Lists have no composed children,
  // but a child list handle (`doc.map(k).list(j)`) has a cached anchor that a
  // source swap leaves pointing at the old source, so invalidate it first.
  _resync(): void {
    this._anchor.invalidate();
    this._registry.resync(
      (c) => this._fireWhole(c),
      (c) => this._attachChange(c),
    );
  }

  // Detach every active subscription and forget it (see
  // MapHandleImpl._teardownSubs). Lists have no composed children.
  _teardownSubs(): void {
    this._registry.teardown();
  }
}

// The ordered map composes a map handle and a list handle and keeps them in
// lockstep. It reuses the concrete impls (not the interfaces) to drive their
// no-commit `_runMutate` seams and the map's `_existsChecker`, so both halves
// of a structural edit commit once. Built over the SAME handles
/**
 * Records the map holds that the order list does not name, in the map's own
 * order, which both peers of a merged document read identically.
 *
 * The record map and the order list are separate containers and resolve a
 * conflict independently, so they can disagree in either direction. One peer
 * deleting a record while another edits it merges to the edit surviving in the
 * map and the entry gone from the list, which leaves the record present and
 * unnamed. A reader that walked the order alone would not report it, and the
 * walk that re-emits a file would drop it, so an ordered read ends with
 * whatever the order missed rather than losing it.
 */
function unorderedKeys(
  live: Iterable<string>,
  named: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const key of live) {
    if (!named.has(key)) out.push(key);
  }
  return out;
}

/**
 * The keys an ordered map presents, from the map's records and the order
 * list's raw contents.
 *
 * Filter to keys still in the map: the primitive keeps the two in step, but a
 * hand-written or stale order list must not surface a key the map no longer
 * has. The caller passes `records` and `raw` in rather than re-reading them,
 * because a subscriber needs the two reads it was derived from to tell one
 * commit's fires apart, and reading the map is the expensive half (on a paged
 * store it decodes every page).
 */
/**
 * The sequence an ordered map presents, from the order list and the map's LIVE
 * KEYS.
 *
 * Keys rather than records, because that is all the answer depends on: an
 * entry in the order list appears when the map still holds it, and a record
 * the list never names is appended. Deriving it from the records instead
 * charges a whole-store read for a question about membership, which on a
 * paged store decodes every page, and it runs on every add and every delete.
 */
function sequenceOf(
  live: ReadonlySet<string>,
  raw: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of raw) {
    if (!live.has(key)) continue;
    // Each key once, at its first position. The order list is a list CRDT and
    // keeps every insertion, so two peers concurrently adding the SAME key
    // resolve to one record and two entries naming it; a reader that surfaced
    // both would report a record this map holds once as present twice.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  for (const key of unorderedKeys(live, seen)) out.push(key);
  return out;
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

// `doc.map(mapKey)` / `doc.list(orderKey)` return, so subscriptions stay
// consistent.
class OrderedMapHandleImpl<T> implements OrderedMapHandle<T> {
  constructor(
    private readonly _map: MapHandleImpl<T>,
    private readonly _order: ListHandleImpl<string>,
    private readonly _owner: HandleOwner,
  ) {
    hideOwnFields(this);
  }

  read(): Record<string, T> {
    return this._map.read();
  }

  get(entryKey: string): T | undefined {
    return this._map.get(entryKey);
  }

  has(entryKey: string): boolean {
    return this._map.has(entryKey);
  }

  keys(): string[] {
    return sequenceOf(this._map.liveKeySet(), this._order.read());
  }

  ordered(): { key: string; value: T }[] {
    const records = this._map.read();
    const seen = new Set<string>();
    const out: { key: string; value: T }[] = [];
    for (const key of this._order.read()) {
      if (Object.prototype.hasOwnProperty.call(records, key)) {
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, value: records[key] as T });
      }
    }
    for (const key of unorderedKeys(Object.keys(records), seen)) {
      out.push({ key, value: records[key] as T });
    }
    return out;
  }

  insert(entryKey: string, value: T, at: OrderedMapPosition): void {
    this._owner.assertWritable();
    this._owner.ensureLocalUpdatesSubscribed();
    // Resolved before the map write, so the destination is read off the
    // collection the caller was looking at rather than one this call has
    // already added a key to.
    const raw = this._order.read();
    const target = this._insertIndex(raw, entryKey, at);
    this._map._runMutate((inner) => {
      (inner as Record<string, T>)[entryKey] = value;
    });
    this._placeKey(raw, entryKey, target);
    this._owner.commitMutate();
  }

  move(entryKey: string, to: OrderedMapPosition): void {
    this._owner.assertWritable();
    this._owner.ensureLocalUpdatesSubscribed();
    // A key the map does not hold gets no order entry: the list names what
    // the map holds, and a peer's delete of this key is the case that puts a
    // reader here, so writing the entry would resurrect a name for a record
    // that is gone.
    if (!this._map._existsChecker()(entryKey)) return;
    const raw = this._order.read();
    if (!this._placeKey(raw, entryKey, this._insertIndex(raw, entryKey, to)))
      return;
    this._owner.commitMutate();
  }

  /**
   * The order-list index a position resolves to.
   *
   * Resolved against the RAW list rather than the sequence a reader sees, so
   * the key lands beside the anchor's own entry. The two disagree only where
   * the list names a key the map no longer holds, and a dead neighbour still
   * names the right neighbourhood.
   */
  private _insertIndex(
    raw: readonly string[],
    entryKey: string,
    at: OrderedMapPosition,
  ): number {
    if ('index' in at) {
      const want = Math.trunc(Number(at.index));
      if (!Number.isFinite(want)) return raw.length;
      if (want <= 0) return 0;
      // An index counts the positions a reader is shown, and the raw list
      // holds entries no reader sees (a key the map lost, a duplicate the
      // sequence reports once), so the index names whichever key stands
      // there and the answer is that key's own entry.
      //
      // Counted with this key taken out, so an index means the position the
      // key ENDS at either way. Left in, a key moving down the collection
      // lands one short of the index named, because lifting it out shifts
      // everything above it.
      const seq = sequenceOf(this._map.liveKeySet(), raw).filter(
        (key) => key !== entryKey,
      );
      if (want >= seq.length) return raw.length;
      const found = raw.indexOf(seq[want]!);
      return found === -1 ? raw.length : found;
    }
    const anchor = 'before' in at ? at.before : at.after;
    const found = raw.indexOf(anchor);
    if (found === -1) return raw.length;
    return 'before' in at ? found : found + 1;
  }

  /**
   * Put `entryKey` at `target` in the order list, reporting whether that
   * wrote anything.
   *
   * A key the list already names is REPOSITIONED (`move`), never re-inserted:
   * the list stores as a `LoroMovableList`, so a move names the entry it
   * carries and two peers repositioning the same key converge on a list
   * naming it once, where a delete plus an insert commutes into a list naming
   * it twice.
   *
   * The plan is computed on the snapshot the caller already read, so the
   * draft takes the writes and no scan.
   */
  private _placeKey(
    raw: readonly string[],
    entryKey: string,
    target: number,
  ): boolean {
    const from = raw.indexOf(entryKey);
    if (from === -1) {
      this._order._runMutate((arr) => {
        arr.splice(target, 0, entryKey);
      });
      return true;
    }
    // Entries beyond the first naming this key. Two peers adding one key
    // leave the list naming it twice and a reader takes the first, so a
    // reposition that left the rest standing would put the key where the
    // reader is not looking. Dropping them names the key once and loses
    // nothing: the entry this call keeps carries it.
    const extras: number[] = [];
    for (let i = from + 1; i < raw.length; i += 1) {
      if (raw[i] === entryKey) extras.push(i);
    }
    // Positions after the drops: `from` is below every extra, and an
    // insertion index loses the extras below it. The move destination then
    // counts positions with the entry lifted out, which is one less than the
    // insertion index whenever the entry stands before it.
    let want = target;
    for (const extra of extras) if (extra < target) want -= 1;
    const dest = want > from ? want - 1 : want;
    if (dest === from && extras.length === 0) return false;
    this._order._runMutate((arr) => {
      for (let i = extras.length - 1; i >= 0; i -= 1) {
        arr.splice(extras[i]!, 1);
      }
      if (dest !== from) arr.move(from, dest);
    });
    return true;
  }

  mutate(fn: (draft: Record<string, T>) => void): void {
    this._owner.assertWritable();
    this._owner.ensureLocalUpdatesSubscribed();

    // Net structural effect: keys added (`added` iterates in insertion
    // order, and a delete-then-re-set re-appends, matching the order list's
    // append semantics) and removed. A field edit routes through the inner
    // record sub-proxy and never trips the top-level set / delete traps, so
    // it leaves the order list alone.
    const added = new Set<string>();
    const removed = new Set<string>();

    // Run at each batch boundary, so a commit carries the map writes AND
    // the order entries for those same records. Left to the end instead,
    // the final commit carries every key at once: measured at 229 KB for a
    // 20,000-record write, an oversized op of its own.
    //
    // `carried` names the records whose writes the commit about to be taken
    // covers, and the boundary reconciles those alone. A paged store assembles
    // its whole overlay before it writes any of it, so by the first boundary
    // every key of the mutation is already in `added`, and appending all of
    // them there would put the whole order list in that first op and name
    // records the store does not hold yet. The final call passes nothing and
    // lands whatever is left.
    const reconcileOrder = (carried?: readonly string[]): void => {
      const covers =
        carried === undefined ? null : new Set<string>(carried);
      const appends = [...added].filter((k) => covers === null || covers.has(k));
      const drops = [...removed].filter((k) => covers === null || covers.has(k));
      if (appends.length === 0 && drops.length === 0) return;
      const dropped = new Set(drops);
      this._order._runMutate((arr) => {
        if (dropped.size > 0) {
          // Remove exactly the entries that went, in place. Rebuilding the
          // list instead (truncate, then re-push what survived) makes the
          // whole list one write, and two peers each removing a different
          // record then merge to a list holding both re-insertions plus the
          // entries they each meant to drop. Walking down keeps the indices
          // below the cursor valid, and a run of adjacent removals goes in one
          // splice so a bulk delete costs runs rather than entries.
          const current = [...arr] as string[];
          let runEnd = -1;
          for (let i = current.length - 1; i >= -1; i -= 1) {
            const drop = i >= 0 && dropped.has(current[i]!);
            if (drop && runEnd === -1) runEnd = i;
            if (!drop && runEnd !== -1) {
              arr.splice(i + 1, runEnd - i);
              runEnd = -1;
            }
          }
        }
        for (const k of appends) arr.push(k);
      });
      for (const k of appends) added.delete(k);
      for (const k of drops) removed.delete(k);
    };

    const batcher = new MutateBatcher((carried) => {
      reconcileOrder(carried);
      this._owner.commitMutate();
    });

    this._map._runMutate((inner) => {
      // "is this key new" (and so must be appended to the order list) is O(1)
      // per set; a repeat set of the same new key is guarded by `added`.
      // `exists` answers over the key set the map held at the START of this
      // batch, so it is the whole test for "present before the batch" and this
      // batch's own writes cannot move it. `added` and `removed` carry what
      // the batch has done on top of it, which is what makes a delete followed
      // by any number of re-sets append to the order list zero times rather
      // than once per set.
      const exists = this._map._existsChecker();
      const tracking = new Proxy(
        {},
        {
          get: (_t, key) =>
            typeof key === 'symbol'
              ? (inner as Record<symbol, unknown>)[key]
              : (inner as Record<string, unknown>)[key],
          set: (_t, key, value) => {
            if (typeof key === 'symbol') return false;
            const k = key as string;
            if (!added.has(k) && !exists(k)) added.add(k);
            // A re-add after a delete in the same batch cancels the delete.
            removed.delete(k);
            (inner as Record<string, unknown>)[k] = value;
            return true;
          },
          deleteProperty: (_t, key) => {
            if (typeof key === 'symbol') return false;
            const k = key as string;
            if (added.has(k)) {
              // Added and removed in one batch: it never reached the order
              // list, so just forget the addition.
              added.delete(k);
            } else if (exists(k)) {
              // Only a key the order list already named can be dropped from
              // it, and `exists` is exactly that set, so `removed` stays a
              // subset of it. Deleting a key that was already absent records
              // nothing, which leaves a later re-`set` of it in the same batch
              // reading as the fresh add it is.
              removed.add(k);
            }
            delete (inner as Record<string, unknown>)[k];
            return true;
          },
          has: (_t, key) =>
            typeof key === 'symbol'
              ? false
              : key in (inner as Record<string, unknown>),
          ownKeys: () => Reflect.ownKeys(inner as object),
          getOwnPropertyDescriptor: (_t, key) =>
            Object.getOwnPropertyDescriptor(inner as object, key),
        },
      ) as Record<string, T>;
      fn(tracking);
    }, batcher);

    reconcileOrder();
    this._owner.commitMutate();
  }

  /** Settles with its map. The order list is delivered in the same breath, so
   *  one signal covers both halves and an app is never told the records are in
   *  while their sequence is still arriving. */
  onSettled(cb: () => void): HandleUnsubscribe {
    return this._map.onSettled(cb);
  }

  subscribe(cb: MapSubscriber<T>): HandleUnsubscribe {
    this._owner.assertReadable();
    // Content (`set` / `deleted`) rides the map subscription. `order` rides
    // whichever of the two containers moved it, and reaches the subscriber at
    // most once per commit: `lastOrder` is the sequence it was last handed, so
    // the second fire of a commit that changed both containers has nothing to
    // add.
    //
    // The map's fire tests the key set against `known`, which is O(changed)
    // and catches the ordinary add / delete without walking the order; a field
    // edit must not pay for a re-sequence. `known` starts empty so the initial
    // fire reads as an all-new move and carries the starting `order`.
    //
    // What that test cannot see reaches the ORDER LIST's own fire: a raw edit
    // of the order list moves the sequence while the map stands still, and a
    // merge can resequence keys whose membership never changed (two peers
    // adding the same key leave one record and two entries naming it). Both
    // are silent on the map, so without that subscription the app's rendered
    // sequence disagrees with `keys()` and no later content change corrects
    // it.
    //
    // A whole-container re-sync (registration, or a checkout / return /
    // hydrate swapping the source) can present the SAME key set in a different
    // order, which the membership test cannot see either. The fire says which
    // it is (`resync`), so those read the sequence directly.
    const known = new Set<string>();
    let lastOrder: string[] = [];
    // The order list's raw contents the last delivered sequence was derived
    // from. The order fire compares against it FIRST, so the fire that follows
    // the map's own for one commit costs a list read rather than a re-read of
    // the map, which on a paged store decodes every page.
    let lastRaw: readonly string[] = [];
    // The sequence as it stands, or null when the subscriber already has it.
    //
    // Derived from `known`, which the map fire has already brought up to date
    // and which IS this map's live key set: every fire adds what it delivered
    // and drops what it removed, a resync included. The alternative, asking
    // the map, answers the same question by materialising every record, which
    // on a paged store decodes every page on every add and every delete.
    const moved = (): string[] | null => {
      lastRaw = this._order.read();
      const order = sequenceOf(known, lastRaw);
      if (sameSequence(order, lastOrder)) return null;
      lastOrder = order;
      return order;
    };
    const detachMap = this._map._subscribeInternal((change, origin, resync) => {
      let structural = change.deleted.length > 0;
      for (const key of change.set.keys()) {
        if (!known.has(key)) structural = true;
      }
      for (const key of change.deleted) known.delete(key);
      for (const key of change.set.keys()) known.add(key);
      const order = structural || resync ? moved() : null;
      if (order === null) {
        cb(change, origin);
        return;
      }
      cb({ set: change.set, deleted: change.deleted, order }, origin);
    });
    const detachOrder = this._order._subscribeInternal((_change, origin) => {
      if (sameSequence(this._order.read(), lastRaw)) return;
      const order = moved();
      if (order === null) return;
      cb({ set: new Map<string, T>(), deleted: [], order }, origin);
    });
    return () => {
      detachMap();
      detachOrder();
    };
  }
}

// Factory functions called by the Document. App code reaches handles via
// `doc.map(...)` / `doc.list(...)`.

// `pageCount`, when supplied, lets the root map present a PAGED record store
// transparently as a flat record map. The Document supplies it for every root
// map; a non-paged map never consults it, so passing it to non-record roots
// is harmless. Omitted means the handle only serves the plain unpaged shape.
export function createRootMapHandle<T>(
  root: LoroMap,
  owner: HandleOwner,
  paging?: PagedRootHooks,
): MapHandle<T> {
  return new MapHandleImpl<T>(rootAnchor(root), owner, paging ?? null);
}

export function createRootListHandle<T>(
  root: LoroMovableList,
  owner: HandleOwner,
): ListHandle<T> {
  return new ListHandleImpl<T>(rootAnchor(root), owner);
}

// Re-point a ROOT handle to a container in a newly-active source doc and
// resync its subscribers, in two phases. The Document calls these on a version
// checkout / return-to-head so the handles an app already holds (its
// `doc.map(key)` / `doc.list(key)` / `doc.orderedMap(...)` references) follow
// the source swap and redraw, instead of being discarded and silently
// detached. The cast is safe because this module is the only producer of these
// interfaces.
//
// The two phases must be run across ALL root handles as two passes (rebind
// every anchor, THEN resync every handle), not handle-by-handle, because a
// composed handle can read a SIBLING root while firing: the ordered map reads
// its order list during its map redraw. If the order list's anchor were still
// on the old source when the map fired, the redraw would read a half-swapped
// pair and drop the keys the order list had not caught up on.
export function rebindRootMapAnchor(
  handle: MapHandle<unknown>,
  next: LoroMap,
): void {
  (handle as unknown as MapHandleImpl<unknown>)._rebindAnchor(next);
}

export function rebindRootListAnchor(
  handle: ListHandle<unknown>,
  next: LoroMovableList,
): void {
  (handle as unknown as ListHandleImpl<unknown>)._rebindAnchor(next);
}

// The first step of the swap: capture a map handle's key set while the handle still
// resolves the outgoing source in BOTH respects, its container and the paging
// state it reads that container under. The Document runs this over every root
// map handle before it moves its active-source pointer, because the paging
// state follows that pointer while the container follows the anchor: between
// the two moves a handle reads the outgoing container under the incoming
// source's paging state, which yields the store's `brass:` bookkeeping keys
// rather than its records, and the resync then reports those as the keys the
// swap removed while every record it actually removed goes unreported.
//
// Lists need no counterpart: they carry no per-key delta, so a list rebind has
// nothing to diff.
export function snapshotRootMapKeys(handle: MapHandle<unknown>): void {
  (handle as unknown as MapHandleImpl<unknown>)._snapshotPriorKeys();
}

// Re-fire + re-attach a root handle's subscribers against its current
// container. Both concrete impls expose `_resync`, so one generic reaches
// either kind; the cast is safe because this module is the only producer of
// these handles.
export function resyncRootHandle(
  handle: MapHandle<unknown> | ListHandle<unknown>,
): void {
  (handle as unknown as { _resync(): void })._resync();
}

// Detach a handle's live subscriptions (its own and its children's). The
// Document calls this when it suspends (parks) or closes, so a subscription
// registered before `close()` stops firing against the still-live containers
// a parked doc keeps applying remote ops to. As with `resyncRootHandle`, one
// generic reaches either kind.
export function teardownRootHandle(
  handle: MapHandle<unknown> | ListHandle<unknown>,
): void {
  (handle as unknown as { _teardownSubs(): void })._teardownSubs();
}

// Bind a map handle and a list handle into an ordered map. The cast to the
// concrete impls is safe because this module is the only producer of those
// interfaces, and it lets the ordered map drive their no-commit seams.
export function createOrderedMapHandle<T>(
  map: MapHandle<T>,
  order: ListHandle<string>,
  owner: HandleOwner,
): OrderedMapHandle<T> {
  return new OrderedMapHandleImpl<T>(
    map as MapHandleImpl<T>,
    order as ListHandleImpl<string>,
    owner,
  );
}
