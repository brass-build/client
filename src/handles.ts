// Typed container handles. A handle is a scoped reference to a container in
// the CRDT doc; its `read` / `mutate` / `subscribe` only see (and only pay
// for) that container.
//
// Engine-neutral: Loro events are translated to a minimal `Change` shape at
// the handle boundary, so handle-only app code does not pin the SDK to Loro.

import {
  LoroList,
  LoroMap,
  type LoroEventBatch,
  isContainer,
} from 'loro-crdt';

import {
  PAGE_TAG,
  type PackedRecord,
  decodePageBody,
  decodeRecordValue,
  encodePageBody,
  flattenPagedLookup,
  isPagingSchemeEditable,
  pageKeyFor,
  peekRecordTag,
} from './record-paging.js';
import { BrassError } from './errors.js';
import { MutateBatcher } from './mutate-batching.js';

// What changed on a map, the first argument to a map subscriber. Reconcile
// by it: upsert every entry in `set` (it carries the new value, so reconcile
// never calls `get`), drop every key in `deleted`. The first fire carries
// the whole map as `set`, so a subscriber is one loop with no
// initial-vs-update branch. Each later fire is O(changed), never O(map).
export interface Change<T = unknown> {
  // Entries added or updated since the previous fire, by key, with their new
  // value. Exact on an unpaged map; on a paged store it may include unchanged
  // keys sharing a page with a changed one, which a set-if-different
  // reconcile absorbs (still O(changed pages)).
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
// (`source === 'remote'`).
export type ChangeSource = 'local' | 'remote' | 'undo' | 'redo' | 'checkout';
export interface ChangeOrigin {
  readonly source: ChangeSource;
}

// A map subscriber. Fires once on registration (the whole map as
// `change.set`), then on every change. Delivery is microtask-deferred, so a
// subscription-fed projection lags your own `mutate` by a tick; for a
// synchronous read right after a write (id allocation, validation) read the
// handle (`read` / `get`), which reflects the edit at once.
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
type InternalMapSubscriber<T> = (
  change: Change<T>,
  origin: ChangeOrigin | undefined,
  resync: boolean,
) => void;

// A list subscriber. Lists are positional with no per-key delta, so a fire
// is a signal to re-read: `subscribe(() => render(list.read()))`. Fires once
// on registration, then on every change.
export type ListSubscriber = () => void;

export type HandleUnsubscribe = () => void;

// Hooks the owning Document provides so handles participate in the SDK's
// commit + origin machinery. Defined here (not in documents.ts) so handles.ts
// has no compile-time dependency on the Document class.
export interface HandleOwner {
  // Throws if the Document is closed, suspended, or read-only.
  assertWritable(): void;
  // Lazily, idempotently attaches the local-updates hook before first mutate.
  ensureLocalUpdatesSubscribed(): void;
  // Stamps the next commit with the mutate origin tag and commits, so the
  // change's `origin.source` reads `'local'`.
  commitMutate(): void;
  // Classify a Loro event by what produced it. Derived from the commit's
  // `by` + origin tag, so it survives microtask-deferred delivery.
  originOf(event: unknown): ChangeSource;
}

// Public handle interfaces. Concrete classes below.

export interface MapHandle<T = unknown> {
  // The whole map as a plain JS object. Walks only this map's slice, not the
  // rest of the document; the fast alternative to `doc.toJSON()`.
  read(): Record<string, T>;
  // Per-entry read. Returns undefined when missing.
  get(entryKey: string): T | undefined;
  // Keys currently in the map.
  keys(): string[];
  // Whether an entry exists at `entryKey`.
  has(entryKey: string): boolean;
  // Mutate through a typed JS-proxy, scoped to this container; same
  // ergonomics as `doc.mutate(d => { d.entities[id].field = ... })`.
  mutate(fn: (draft: Record<string, T>) => void): void;
  // ONE channel for every change whatever produced it (local / remote / undo
  // / redo / checkout): the projection reconciles by value. The callback gets
  // `change` and optional `origin` a render ignores. Fires once on
  // registration with the whole map as `change.set`, then on every change
  // (each later fire O(changed)).
  subscribe(cb: MapSubscriber<T>): HandleUnsubscribe;
  // Child handle for `entries[entryKey]` when that entry is itself a map /
  // list. Reads / subscribes no-op until the container exists; the first
  // mutate creates it.
  map<U>(entryKey: string): MapHandle<U>;
  list<U>(entryKey: string): ListHandle<U>;
}

export interface ListHandle<T = unknown> {
  read(): T[];
  length(): number;
  mutate(fn: (draft: T[]) => void): void;
  // Positional, no per-key delta, so a fire is a signal to re-read:
  // `subscribe(() => render(list.read()))`. Fires once on registration, then
  // on every change. A keyed collection belongs in a map (or `orderedMap`),
  // which reconciles O(changed); a list is for ordering keys and small
  // positional data.
  subscribe(cb: ListSubscriber): HandleUnsubscribe;
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
export interface OrderedMapHandle<T = unknown> {
  // The map as a plain JS object. Use `ordered()` for order-list order.
  read(): Record<string, T>;
  // Per-entry read. Returns undefined when missing.
  get(entryKey: string): T | undefined;
  // Whether an entry exists in the map.
  has(entryKey: string): boolean;
  // Keys in order-list order, filtered to keys still present in the map.
  keys(): string[];
  // `[key, value]` records walking the order list, so an app reading in
  // source order doesn't re-walk the order list by hand.
  ordered(): { key: string; value: T }[];
  // Mutate the map; the sibling order list reconciles in the same commit
  // (new keys appended in insertion order, deleted keys pruned). Drive it
  // like `MapHandle.mutate`: `m[key] = record`, `delete m[key]`,
  // `m[key].field = ...`.
  mutate(fn: (draft: Record<string, T>) => void): void;
  // Fires once on registration (the whole map as `change.set` in order),
  // then on every change. A field edit carries only `set` / `deleted`; a
  // change that moves the order also carries `change.order` (live keys in
  // order) so the app re-sequences the views it holds. Content stays
  // O(changed); re-sequencing happens only when the order moves.
  subscribe(cb: MapSubscriber<T>): HandleUnsubscribe;
}

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

function assignPlain(target: LoroMap, value: Record<string, unknown>): void {
  // Recursively materialize nested objects / arrays as nested LoroMap /
  // LoroList containers so the CRDT mirrors the JS shape. Clear keys not in
  // `value` so assignment is a replace, not a merge (property-level patching
  // uses `d.entities[id].x = ...`).
  for (const k of target.keys()) {
    if (!(k in value)) target.delete(k);
  }
  for (const [k, rawV] of Object.entries(value)) {
    const v = materializeContainers(rawV);
    // Plain-VALUE preservation (as in the proxy set trap): a key holding a
    // plain object/array value (a record body) stays a value, never promoted.
    const existingV = target.get(k);
    if (
      existingV !== undefined &&
      !isContainer(existingV) &&
      typeof existingV === 'object' &&
      existingV !== null &&
      typeof v === 'object' &&
      v !== null
    ) {
      target.set(k, toPlainDeep(v) as never);
      continue;
    }
    if (isPlainObject(v)) {
      // Reuse an existing LoroMap at this key: a fresh `setContainer` mints a
      // new container ID, which under Loro's UndoManager is a structural
      // destroy+create that does NOT merge within the merge window. In-place
      // field overwrites DO merge, which whole-entity-rewrites-at-drag-cadence
      // expects.
      const existing = target.get(k);
      const sub =
        existing instanceof LoroMap
          ? existing
          : target.setContainer(k, new LoroMap());
      assignPlain(sub, v);
    } else if (Array.isArray(v)) {
      const existingList = target.get(k);
      const sub =
        existingList instanceof LoroList
          ? existingList
          : target.setContainer(k, new LoroList());
      assignList(sub, v);
    } else {
      target.set(k, v as never);
    }
  }
}

function assignList(target: LoroList, value: readonly unknown[]): void {
  // Same rationale as the LoroMap reuse above: replace contents in place
  // rather than minting a new LoroList, so adjacent commits collapse into one
  // undo step.
  const oldLen = target.length;
  for (let i = 0; i < value.length; i++) {
    const item = materializeContainers(value[i]);
    if (isPlainObject(item)) {
      if (i < oldLen) target.delete(i, 1);
      const child = target.insertContainer(i, new LoroMap());
      assignPlain(child, item);
    } else if (Array.isArray(item)) {
      // A nested list: rebuild as a child LoroList rather than inserting the
      // array as an opaque value.
      if (i < oldLen) target.delete(i, 1);
      const child = target.insertContainer(i, new LoroList());
      assignList(child, item);
    } else {
      if (i < oldLen) {
        target.delete(i, 1);
        target.insert(i, item as never);
      } else {
        target.insert(i, item as never);
      }
    }
  }
  if (value.length < oldLen) {
    target.delete(value.length, oldLen - value.length);
  }
}

// Append one value at the tail (same plain-vs-container handling as the
// indexed-set trap). The proxy's `push` fast-path uses this so a tail append
// stays O(1) instead of the full-list replay.
function insertListTail(target: LoroList, rawItem: unknown): void {
  const idx = target.length;
  const item = materializeContainers(rawItem);
  if (isPlainObject(item)) {
    const child = target.insertContainer(idx, new LoroMap());
    assignPlain(child, item);
  } else if (Array.isArray(item)) {
    const child = target.insertContainer(idx, new LoroList());
    assignList(child, item);
  } else {
    target.insert(idx, item as never);
  }
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
): Record<string, unknown> {
  const handler: ProxyHandler<object> = {
    get(_t, key) {
      if (typeof key === 'symbol') return undefined;
      const v = loroMap.get(key);
      if (isContainer(v)) {
        // Present an engine-neutral view, never the raw container, so app
        // code can't take a hard dependency on the CRDT engine. A LoroMap
        // recurses into another proxy; a LoroList reads back via `toJSON`
        // (not `toArray`, which is shallow and hands back live element
        // handles that corrupt on reassignment; list editing goes through
        // `parent.list(key).mutate(...)`). Other container types are outside
        // the v1 portable surface, so project them via toJSON().
        if (v instanceof LoroMap) return wrapLoroMapProxy(v, batcher);
        if (v instanceof LoroList) return v.toJSON();
        return (v as { toJSON(): unknown }).toJSON();
      }
      return v;
    },
    set(_t, key, value) {
      if (typeof key === 'symbol') return false;
      // Before the write, so a commit it triggers seals the preceding
      // batch rather than splitting this record out of it.
      batcher?.record(value);
      const existing = loroMap.get(key);
      // Plain-VALUE preservation: when the key holds a plain (non-container)
      // object or array, the new structure is written as a plain value too,
      // never promoted. This keeps a record body (`rec.params`, one JSON
      // value whose whole-replace is the merge unit) a value across edits;
      // promoting it would change the merge granularity and bloat the
      // snapshot with per-element containers.
      if (
        existing !== undefined &&
        !isContainer(existing) &&
        typeof existing === 'object' &&
        existing !== null &&
        typeof value === 'object' &&
        value !== null
      ) {
        loroMap.set(key, toPlainDeep(value) as never);
        return true;
      }
      if (isPlainObject(value)) {
        // Reuse the existing LoroMap (see `assignPlain`): a fresh
        // `setContainer` is a destroy+create Loro won't merge across, so
        // `entities[id] = {...}` at drag cadence accumulates one undo entry
        // per frame instead of collapsing into the merge window.
        const sub =
          existing instanceof LoroMap
            ? existing
            : loroMap.setContainer(key, new LoroMap());
        assignPlain(sub, value);
      } else if (Array.isArray(value)) {
        const sub =
          existing instanceof LoroList
            ? existing
            : loroMap.setContainer(key, new LoroList());
        assignList(sub, value);
      } else {
        loroMap.set(key, value as never);
      }
      return true;
    },
    deleteProperty(_t, key) {
      if (typeof key === 'symbol') return false;
      batcher?.recordDelete();
      loroMap.delete(key);
      return true;
    },
    has(_t, key) {
      if (typeof key === 'symbol') return false;
      return loroMap.get(key) !== undefined;
    },
    ownKeys() {
      return loroMap.keys();
    },
    getOwnPropertyDescriptor(_t, key) {
      if (typeof key === 'symbol') return undefined;
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

// Array.prototype methods that mutate the array in place. Called on a list
// mutate-proxy, their result is replayed into the LoroList; every other
// method is a pure read that leaves the container untouched, so a `find` /
// `findIndex` inside a mutate reads fields without rewriting the whole list.
// `push` is fast-pathed natively above the generic fallback and never reaches
// this set.
const MUTATING_ARRAY_METHODS: ReadonlySet<string> = new Set([
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
]);

// An array-proxy for list mutators: index assignments, `.push` / `.splice`,
// and length-set route into the underlying LoroList so the user writes
// idiomatic JS. Reads delegate to a fresh snapshot per access so a sequence
// of reads inside the mutator sees each write.
function wrapLoroListProxy(loroList: LoroList): unknown[] {
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
          if (v instanceof LoroMap) return wrapLoroMapProxy(v);
          if (v instanceof LoroList) return v.toJSON();
          return (v as { toJSON(): unknown }).toJSON();
        }
        return v;
      }
      // `push` is the hot path (the ordered-map primitive appends every new
      // key through it; apps bulk-build lists with it), so append natively.
      // The toArray + replay below is O(list) PER call, turning N appends
      // into O(N^2) and faulting Loro at a few thousand keys; a tail insert
      // is O(1).
      if (key === 'push') {
        return (...items: unknown[]) => {
          for (const item of items) insertListTail(loroList, item);
          return loroList.length;
        };
      }
      // Remaining array methods: bind to a deep-plain `toJSON` snapshot so a
      // callback reading an element's fields (`findIndex((c) => c.id === x)`,
      // `find`, `filter`, `map`) sees plain objects, not the raw child
      // containers `toArray` hands back (whose fields read undefined). A
      // mutating method replays its result into the LoroList; a pure read
      // does not, or a `find` inside a mutate would rewrite the whole list.
      // Best-effort for v1; efficient mutation uses indexed assignment /
      // length-set / `push`.
      const arr = loroList.toJSON() as unknown[];
      const val = (arr as unknown as Record<string | symbol, unknown>)[key];
      if (typeof val === 'function') {
        return (...args: unknown[]) => {
          const fn = val as (...a: unknown[]) => unknown;
          const result = fn.apply(arr, args);
          if (MUTATING_ARRAY_METHODS.has(key)) assignList(loroList, arr);
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
        const oldLen = loroList.length;
        if (idx < oldLen) {
          loroList.delete(idx, 1);
        }
        if (isPlainObject(value)) {
          const child = loroList.insertContainer(idx, new LoroMap());
          assignPlain(child, value);
        } else if (Array.isArray(value)) {
          const child = loroList.insertContainer(idx, new LoroList());
          assignList(child, value);
        } else {
          loroList.insert(idx, value as never);
        }
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
// `p0,p1,...` -> a `{ type: '__page__', params: <gzipped triples> }`
// container, a record's page being a hash of its key (see `record-paging.ts`).
// These helpers let `MapHandleImpl` present that paged map as the SAME flat
// `key -> { type, params }` record map an unpaged store reads, so an app
// reading / editing `doc.map('instances')` works unchanged. A map with no
// page-tagged value never reaches here.

// A flattened record: the same `{ type, params }` shape an unpaged store
// stores per record.
type FlatRecord = Record<string, unknown>;

const TAG_FIELD = 'type';
const BODY_FIELD = 'params';

// A page entry on the live LoroMap is a CONTAINER, not a plain
// `{ type, params }`, so it must be materialised before the page codec
// (which expects plain values) reads its tag / body.
function pageValue(m: LoroMap, key: string): unknown {
  const v = m.get(key);
  if (v instanceof LoroMap) return v.toJSON();
  return v;
}

// Decode a live paged `instances` map to the flat `key -> { type, params }`
// lookup. `toJSON` materialises the page containers to the plain shape the
// shared `flattenPagedLookup` consumes, so page flattening lives in one place.
// Only ever called on the handle's paged path (guarded by `_isPaged()` /
// `_pageCount`), so the store is known paged. Pass `paged: true` rather than
// re-deriving it from a tag scan.
function flattenPagedMap(m: LoroMap): Record<string, FlatRecord> {
  return flattenPagedLookup(
    m.toJSON() as Record<string, unknown>,
    true,
  ) as Record<string, FlatRecord>;
}

// Resolve a single record without flattening the whole store: hash the key
// to its page, decode only that page, find the triple. Keeps a per-key `get`
// proportional to one page, not the whole file.
function recordFromPage(
  m: LoroMap,
  recordKey: string,
  pageCount: number,
): FlatRecord | undefined {
  const page = pageValue(m, pageKeyFor(recordKey, pageCount));
  if (peekRecordTag(page) !== PAGE_TAG) return undefined;
  for (const packed of decodePageBody(decodeRecordValue(page)?.body)) {
    if (Array.isArray(packed) && packed[0] === recordKey) {
      return { [TAG_FIELD]: packed[1], [BODY_FIELD]: packed[2] };
    }
  }
  return undefined;
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

// The root key of a root container (`cid:root-<key>:Map`), else null. A field
// edit is keyed by its first path segment under root, which only a root
// record map can resolve; nested handles fall back to direct keys only.
function rootKeyOf(m: LoroMap): string | null {
  const match = /^cid:root-(.+):Map$/.exec(m.id);
  return match?.[1] ?? null;
}

// The record keys currently packed into one page, or null for a missing /
// non-page entry. Seeds and advances the page index for delete detection.
function pageRecordKeys(m: LoroMap, pageKey: string): Set<string> | null {
  const records = pageRecords(m, pageKey);
  return records ? new Set(records.keys()) : null;
}

// Decode one page to its `key -> { type, params }` records in a single pass,
// so a paged delta gets the changed records' VALUES from the same decode it
// uses to find the changed keys (a second per-key decode would make a large
// initial build O(records x page-size)).
function pageRecords(m: LoroMap, pageKey: string): Map<string, FlatRecord> | null {
  const page = pageValue(m, pageKey);
  if (peekRecordTag(page) !== PAGE_TAG) return null;
  const records = new Map<string, FlatRecord>();
  for (const packed of decodePageBody(decodeRecordValue(page)?.body)) {
    if (Array.isArray(packed) && typeof packed[0] === 'string') {
      records.set(packed[0], { [TAG_FIELD]: packed[1], [BODY_FIELD]: packed[2] });
    }
  }
  return records;
}

// Materialise one unpaged map entry to a plain value (containers via
// `toJSON`, scalars passthrough), so a delta carries the changed value
// without a re-read.
function entryValue(m: LoroMap, key: string): unknown {
  const v = m.get(key);
  if (v instanceof LoroMap || v instanceof LoroList) return v.toJSON();
  return v;
}

function buildPageIndex(m: LoroMap): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const pageKey of m.keys()) {
    const keys = pageRecordKeys(m, pageKey);
    if (keys) index.set(pageKey, keys);
  }
  return index;
}

function unpagedMapDelta(
  m: LoroMap,
  rootKey: string | null,
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
    } else if (rootKey !== null) {
      // A descendant event (a field edit on a record's nested container).
      // Every batch event is within the root map's subtree, so the record's
      // key is the path segment directly under root.
      const key = ev.path[1];
      if (typeof key === 'string') setKeys.add(key);
    }
  }
  for (const key of deleted) setKeys.delete(key);
  const set = new Map<string, unknown>();
  for (const key of setKeys) set.set(key, entryValue(m, key));
  return { set, deleted: [...deleted] };
}

function pagedMapDelta(
  m: LoroMap,
  batch: LoroEventBatch,
  pageIndex: Map<string, Set<string>>,
): Change<unknown> {
  const set = new Map<string, unknown>();
  const deleted = new Set<string>();
  for (const ev of batch.events) {
    if (ev.target !== m.id || ev.diff.type !== 'map') continue;
    for (const pageKey of Object.keys(ev.diff.updated)) {
      const before = pageIndex.get(pageKey);
      const after = pageRecords(m, pageKey);
      if (after) {
        for (const [key, value] of after) set.set(key, value);
        pageIndex.set(pageKey, new Set(after.keys()));
      } else {
        pageIndex.delete(pageKey);
      }
      if (before) {
        for (const key of before) {
          if (!after || !after.has(key)) deleted.add(key);
        }
      }
    }
  }
  for (const key of deleted) set.delete(key);
  return { set, deleted: [...deleted] };
}

// Run a flat-draft `mutate` against a PAGED store. The draft proxies an
// OVERLAY of in-batch changes (key -> record, or a tombstone for a delete);
// reads consult the overlay first then the stored page, so an edit is
// visible to later reads in the same `fn` as on an unpaged live proxy.
// Afterwards only the touched pages are decoded, rewritten, and re-encoded,
// so a single field edit rewrites a single page. A `pruneRefs` sweep that
// iterates the whole draft is the only path that reads every page, the rare
// structural-delete case already treated as O(file).
function mutatePaged<T>(
  m: LoroMap,
  pageCount: number,
  fn: (draft: Record<string, T>) => void,
): void {
  // A paged store always carries a positive `meta.page_count`, so a
  // non-positive count means the store is corrupt: the page layout can't be
  // resolved and guessing would scramble which record lives where. Refuse
  // rather than corrupt.
  if (pageCount <= 0) {
    throw new Error('Cannot edit a paged record store with no page_count.');
  }

  const TOMBSTONE = Symbol('deleted');
  // In-batch changes: key -> new record, or TOMBSTONE when deleted. Absent
  // means "unchanged, read from the page".
  const overlay = new Map<string, FlatRecord | typeof TOMBSTONE>();

  // The record a draft read should see: the overlay value if touched this
  // batch, else the stored record (one page decode).
  const currentRecord = (key: string): FlatRecord | undefined => {
    if (overlay.has(key)) {
      const v = overlay.get(key)!;
      return v === TOMBSTONE ? undefined : v;
    }
    return recordFromPage(m, key, pageCount);
  };

  // Per-record sub-proxy: a field assignment writes through to the overlay
  // record so a later read sees it and the page rewrite picks it up. Field
  // reads return the deep-plain stored value, so spreading `{ ...rec.params }`
  // never leaks a live handle.
  const recordProxy = (key: string): Record<string, unknown> => {
    return new Proxy(
      {},
      {
        get(_t, field) {
          if (typeof field === 'symbol') return undefined;
          const rec = currentRecord(key);
          return rec ? rec[field] : undefined;
        },
        set(_t, field, value) {
          if (typeof field === 'symbol') return false;
          const base: FlatRecord = { ...currentRecord(key) };
          base[field] = toPlainDeep(value);
          overlay.set(key, base);
          return true;
        },
      },
    ) as Record<string, unknown>;
  };

  const draft = new Proxy(
    {},
    {
      get(_t, key) {
        if (typeof key === 'symbol') return undefined;
        if (currentRecord(key as string) === undefined) return undefined;
        return recordProxy(key as string);
      },
      set(_t, key, value) {
        if (typeof key === 'symbol') return false;
        overlay.set(
          key as string,
          toPlainDeep(value) as FlatRecord,
        );
        return true;
      },
      deleteProperty(_t, key) {
        if (typeof key === 'symbol') return false;
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

  applyOverlay(m, pageCount, overlay, TOMBSTONE);
}

// Rewrite the pages the overlay touched: each is decoded once, untouched
// records carried over, changed records re-stated (or dropped on a
// tombstone), then re-encoded (or deleted if it ends empty).
function applyOverlay(
  m: LoroMap,
  pageCount: number,
  overlay: Map<string, FlatRecord | symbol>,
  tombstone: symbol,
): void {
  const touchedPages = new Set<string>();
  for (const key of overlay.keys()) {
    touchedPages.add(pageKeyFor(key, pageCount));
  }

  for (const pageKey of touchedPages) {
    const existing = pageValue(m, pageKey);
    const triples: PackedRecord<unknown>[] = [];
    // Carry over the page's untouched records.
    if (peekRecordTag(existing) === PAGE_TAG) {
      for (const packed of decodePageBody(decodeRecordValue(existing)?.body)) {
        if (
          Array.isArray(packed) &&
          typeof packed[0] === 'string' &&
          !overlay.has(packed[0])
        ) {
          triples.push(packed);
        }
      }
    }
    // Add the overlay's survivors that hash to this page.
    for (const [key, rec] of overlay) {
      if (rec === tombstone) continue;
      if (pageKeyFor(key, pageCount) !== pageKey) continue;
      const r = rec as FlatRecord;
      triples.push([key, String(r[TAG_FIELD] ?? ''), r[BODY_FIELD]]);
    }
    if (triples.length === 0) {
      if (existing !== undefined) m.delete(pageKey);
      continue;
    }
    const page = m.setContainer(pageKey, new LoroMap());
    page.set(TAG_FIELD, PAGE_TAG);
    page.set(BODY_FIELD, encodePageBody(triples));
  }
}

// ---- Concrete handle implementations ----------------------------------
//
// Both handles wrap an "anchor": a root LoroMap/LoroList directly, or a
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
}

interface ListAnchor {
  resolve(): LoroList | null;
  resolveOrCreate(): LoroList;
  invalidate(): void;
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
  rebind(next: LoroList): void;
}

// A root anchor holds one container that a version checkout swaps in place
// (`rebind`). Between rebinds `resolve()` returns the same instance, so the
// per-container Loro subscription attaches to a stable identity. `LoroMap` and
// `LoroList` roots share this; the kind is the type parameter.
function rootAnchor<C extends LoroMap | LoroList>(
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
function childAnchor<C extends LoroMap | LoroList>(
  parent: MapAnchor,
  key: string,
  ctor: new () => C,
): { resolve(): C | null; resolveOrCreate(): C; invalidate(): void } {
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
      const created = p.setContainer(key, new ctor());
      cached = created;
      return created;
    },
    invalidate: () => {
      cached = null;
    },
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
class SubscriptionRegistry<Cb> {
  private readonly _subs = new Set<{ cb: Cb; detach: () => void }>();

  // Fire the whole-container catch-up once, attach the per-container change
  // subscription, track the record, and return an idempotent unsubscribe.
  subscribe(
    cb: Cb,
    fireWhole: (cb: Cb) => void,
    attach: (cb: Cb) => () => void,
  ): HandleUnsubscribe {
    fireWhole(cb);
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
    for (const rec of this._subs) {
      rec.detach();
      fireWhole(rec.cb);
      rec.detach = attach(rec.cb);
    }
  }

  // Detach every active subscription and forget it (suspend / close).
  teardown(): void {
    for (const rec of this._subs) rec.detach();
    this._subs.clear();
  }
}

class MapHandleImpl<T> implements MapHandle<T> {
  private readonly _anchor: MapAnchor;
  private readonly _owner: HandleOwner;
  // The store's page count (0 when unpaged). `null` for handles that can
  // never be a record store's `instances` root (composed child handles, and
  // doc-less roots), which skip the paged paths entirely.
  private readonly _pageCount: (() => number) | null;
  // The paging scheme of the record store this root maps, read the same way
  // and at the same time as `_pageCount` (both off the active source's `meta`).
  // `null` for any handle that is never a record store's `instances` root.
  private readonly _pagingScheme: (() => number) | null;
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

  constructor(
    anchor: MapAnchor,
    owner: HandleOwner,
    pageCount: (() => number) | null = null,
    pagingScheme: (() => number) | null = null,
  ) {
    this._anchor = anchor;
    this._owner = owner;
    this._pageCount = pageCount;
    this._pagingScheme = pagingScheme;
  }

  // Whether the map is a PAGED record store. Defined by `meta.page_count`
  // (set whenever the writer pages, never changed by a field edit), threaded
  // in as `_pageCount` and read in O(1). MUST stay O(1): it is on the hot
  // path of every `read` / `mutate` (twice per ordered-map edit), so scanning
  // the map to peek tags would make a single field edit O(file).
  private _isPaged(): boolean {
    return this._pageCount !== null && this._pageCount() > 0;
  }

  // Whether this build's page-key hash matches the scheme the store was
  // written under. A per-key `get` hashes the key to its page (`pageKeyFor`),
  // so a store written under a NEWER scheme (one that changed the hash) would
  // be looked up in the wrong page and read back as absent. When this is
  // false, the per-key read paths fall back to the hash-independent whole-store
  // flatten (O(file), only on this rare newer-scheme read) so `get` / `has`
  // agree with `read()` instead of silently reporting present records missing.
  // The edit path refuses such a store loudly (`_runMutate`); reads stay
  // best-effort. Absent / current-or-older scheme is a match.
  private _pageHashMatchesStore(): boolean {
    return !this._pagingScheme || isPagingSchemeEditable(this._pagingScheme());
  }

  read(): Record<string, T> {
    const m = this._anchor.resolve();
    if (!m) return {};
    // A paged map flattens back to the flat lookup, so a read is identical
    // paged or not.
    if (this._isPaged()) return flattenPagedMap(m) as Record<string, T>;
    return m.toJSON() as Record<string, T>;
  }

  get(entryKey: string): T | undefined {
    const m = this._anchor.resolve();
    if (!m) return undefined;
    if (this._isPaged()) {
      // A newer-scheme store hashes keys differently, so a per-page lookup
      // would miss present records; flatten instead (see `_pageHashMatchesStore`).
      if (!this._pageHashMatchesStore()) {
        return flattenPagedMap(m)[entryKey] as T | undefined;
      }
      // Decode only the key's page, so a per-key `get` stays proportional to
      // one page.
      return recordFromPage(m, entryKey, this._pageCount!()) as T | undefined;
    }
    const v = m.get(entryKey);
    if (v === undefined) return undefined;
    if (v instanceof LoroMap) return v.toJSON() as T;
    if (v instanceof LoroList) return v.toJSON() as T;
    return v as T;
  }

  keys(): string[] {
    const m = this._anchor.resolve();
    if (!m) return [];
    if (this._isPaged()) return Object.keys(flattenPagedMap(m));
    return m.keys();
  }

  has(entryKey: string): boolean {
    const m = this._anchor.resolve();
    if (!m) return false;
    if (this._isPaged()) return this.get(entryKey) !== undefined;
    return m.get(entryKey) !== undefined;
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
    if (this._isPaged()) {
      // A store written under a paging scheme this build does not implement
      // would be mis-hashed by `pageKeyFor`, so an in-place edit would write a
      // record into the wrong page. Refuse loudly rather than corrupt it; the
      // read path stays best-effort (only a persisted edit can corrupt).
      if (this._pagingScheme && !isPagingSchemeEditable(this._pagingScheme())) {
        throw new BrassError(
          'This document was saved in a newer storage format. Update this app to the latest @brass-build/client to edit it.',
          { status: 426 },
        );
      }
      mutatePaged(m, this._pageCount!(), fn);
      return;
    }
    const proxy = wrapLoroMapProxy(m, batcher) as Record<string, T>;
    fn(proxy);
  }

  // Paged writes defer to `applyOverlay` at the end of the mutation, so an
  // intermediate commit there would seal no records (and, on an ordered
  // map, order entries for records not yet written). Their ops are bounded
  // by page size anyway.
  _canBatchMutate(): boolean {
    return !this._isPaged();
  }

  // A predicate over the map's CURRENT stored key set, resolved ONCE so a
  // caller checking many keys doesn't re-scan per key. The ordered-map
  // primitive uses it to decide, per set, whether a key is new (and so must
  // be appended to the order list) without paying O(map) per added key.
  _existsChecker(): (key: string) => boolean {
    const m = this._anchor.resolve();
    if (!m) return () => false;
    if (this._isPaged()) {
      // Newer-scheme store: the per-page hash would miss records, so resolve
      // the whole flattened key set once (see `_pageHashMatchesStore`).
      if (!this._pageHashMatchesStore()) {
        const flat = flattenPagedMap(m);
        return (key) => Object.prototype.hasOwnProperty.call(flat, key);
      }
      const pageCount = this._pageCount!();
      return (key) => recordFromPage(m, key, pageCount) !== undefined;
    }
    return (key) => m.get(key) !== undefined;
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
  private _fireWhole(
    cb: InternalMapSubscriber<T>,
    deleted: string[] = [],
  ): void {
    try {
      cb(
        { set: new Map<string, T>(Object.entries(this.read())), deleted },
        undefined,
        true,
      );
    } catch {
      // A throwing subscriber must not break registration / resync.
    }
  }

  // Attach the per-container change subscription for `cb` to the CURRENT
  // resolved container, returning its detach. The container instance is
  // captured here (Loro's subscribe is per-container), so a source swap
  // re-runs this against the new container.
  private _attachChange(cb: InternalMapSubscriber<T>): () => void {
    const m = this._anchor.resolve();
    // If the container doesn't exist yet (a composed handle for a missing
    // entry), only the whole-fire happens; the change subscription attaches
    // once a later `doc.map(key)` / `mutate` materializes it. Root handles
    // are always materialized (`getMap` is get-or-create).
    if (!m) return () => {};
    // Paged delta needs prior page state to spot deleted records, so index
    // the pages once now; the index advances on every fire or its next delete
    // diff is wrong. Unpaged maps read their delta off the Loro diff.
    const pageIndex = this._isPaged() ? buildPageIndex(m) : null;
    const rootKey = rootKeyOf(m);
    const sub = m.subscribe((event) => {
      const change = (
        pageIndex
          ? pagedMapDelta(m, event, pageIndex)
          : unpagedMapDelta(m, rootKey, event)
      ) as Change<T>;
      const origin: ChangeOrigin = { source: this._owner.originOf(event) };
      try {
        cb(change, origin, false);
      } catch {
        // A throwing subscriber must not affect the others.
      }
    });
    return () => sub();
  }

  subscribe(cb: MapSubscriber<T>): HandleUnsubscribe {
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
  // read against the CURRENT (pre-rebind) source, so `_resync` can diff it
  // against the post-rebind source to find removed keys. Runs before the
  // anchor moves; child maps resolve through this anchor, so they must be read
  // now too.
  private _snapshotPriorKeys(): void {
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
      const anchor = childAnchor(this._anchor, entryKey, LoroMap);
      h = new MapHandleImpl<unknown>(anchor, this._owner);
      this._childMaps.set(entryKey, h);
    }
    return h as unknown as MapHandle<U>;
  }

  list<U>(entryKey: string): ListHandle<U> {
    let h = this._childLists.get(entryKey);
    if (!h) {
      const anchor = childAnchor(this._anchor, entryKey, LoroList);
      h = new ListHandleImpl<unknown>(anchor, this._owner);
      this._childLists.set(entryKey, h);
    }
    return h as unknown as ListHandle<U>;
  }
}

class ListHandleImpl<T> implements ListHandle<T> {
  private readonly _anchor: ListAnchor;
  private readonly _owner: HandleOwner;
  // Active subscriptions, tracked so a version checkout can re-fire and
  // re-attach each one against the new container.
  private readonly _registry = new SubscriptionRegistry<ListSubscriber>();

  constructor(anchor: ListAnchor, owner: HandleOwner) {
    this._anchor = anchor;
    this._owner = owner;
  }

  read(): T[] {
    const l = this._anchor.resolve();
    if (!l) return [];
    return l.toJSON() as T[];
  }

  length(): number {
    const l = this._anchor.resolve();
    return l ? l.length : 0;
  }

  mutate(fn: (draft: T[]) => void): void {
    this._owner.assertWritable();
    this._owner.ensureLocalUpdatesSubscribed();
    this._runMutate(fn);
    this._owner.commitMutate();
  }

  // Run a list mutate without the commit pipeline; see
  // `MapHandleImpl._runMutate`. The ordered-map primitive drives this to
  // reconcile the order list in the same commit as the map edit.
  _runMutate(fn: (draft: T[]) => void): void {
    const l = this._anchor.resolveOrCreate();
    const proxy = wrapLoroListProxy(l) as T[];
    fn(proxy);
  }

  // Fire once (positional lists have no per-key delta, so a fire is a signal
  // to re-read). Used for registration and for a checkout / return resync.
  private _fireWhole(cb: ListSubscriber): void {
    try {
      cb();
    } catch {
      // A throwing subscriber must not break registration / resync.
    }
  }

  // Attach the per-container change subscription for `cb` to the CURRENT
  // resolved container, returning its detach.
  private _attachChange(cb: ListSubscriber): () => void {
    // Same caveat as MapHandleImpl: the change subscription needs the
    // container to exist. Root lists are materialized by `doc.list(key)`;
    // nested lists need a prior mutate.
    const l = this._anchor.resolve();
    if (!l) return () => {};
    const sub = l.subscribe(() => this._fireWhole(cb));
    return () => sub();
  }

  subscribe(cb: ListSubscriber): HandleUnsubscribe {
    return this._registry.subscribe(
      cb,
      (c) => this._fireWhole(c),
      (c) => this._attachChange(c),
    );
  }

  // Re-point this ROOT list handle to `next` without firing (see
  // MapHandleImpl._rebindAnchor). Lists carry no per-key delta, so there is
  // no prior-key snapshot to take; the resync fire is a re-read signal.
  _rebindAnchor(next: LoroList): void {
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
// `doc.map(mapKey)` / `doc.list(orderKey)` return, so subscriptions stay
// consistent.
class OrderedMapHandleImpl<T> implements OrderedMapHandle<T> {
  constructor(
    private readonly _map: MapHandleImpl<T>,
    private readonly _order: ListHandleImpl<string>,
    private readonly _owner: HandleOwner,
  ) {}

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
    // Filter to keys still in the map: the primitive keeps the two in step,
    // but a hand-written or stale order list must not surface a key the map
    // no longer has. Read the map ONCE (its bulk snapshot) and test
    // membership against it, the same shape `ordered()` uses. A per-key
    // `_existsChecker` predicate would re-decode a paged store's page once
    // per record it holds (one gunzip per key, ~page-size times per page),
    // and `subscribe` calls this on every structural move, so a single edit
    // on a large paged doc would cost O(records) page decodes instead of
    // O(pages).
    const records = this._map.read();
    return this._order
      .read()
      .filter((k) => Object.prototype.hasOwnProperty.call(records, k));
  }

  ordered(): { key: string; value: T }[] {
    const records = this._map.read();
    const out: { key: string; value: T }[] = [];
    for (const key of this._order.read()) {
      if (Object.prototype.hasOwnProperty.call(records, key)) {
        out.push({ key, value: records[key] as T });
      }
    }
    return out;
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
    const reconcileOrder = (): void => {
      if (added.size === 0 && removed.size === 0) return;
      this._order._runMutate((arr) => {
        if (removed.size > 0) {
          const kept = arr.filter((k) => !removed.has(k));
          arr.length = 0;
          for (const k of kept) arr.push(k);
        }
        for (const k of added) arr.push(k);
      });
      added.clear();
      removed.clear();
    };

    const batcher = this._map._canBatchMutate()
      ? new MutateBatcher(() => {
          reconcileOrder();
          this._owner.commitMutate();
        })
      : null;

    this._map._runMutate((inner) => {
      // "is this key new" (and so must be appended to the order list) is O(1)
      // per set; a repeat set of the same new key is guarded by `added`.
      // `exists` reflects the key set at the start of the batch for a paged
      // store (its writes are deferred to `applyOverlay`), but an UNPAGED
      // proxy writes through to the live map immediately, so a key deleted
      // earlier in this same batch reads as absent from `exists`. `removed`
      // records exactly those keys, so "present before the batch" is
      // `exists(k) || removed.has(k)`; consulting both keeps a delete-then-
      // re-add of a pre-existing key from being mis-seen as a fresh add and
      // appended to the order list a second time.
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
            if (!added.has(k) && !exists(k) && !removed.has(k)) {
              added.add(k);
            }
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
              // Only track a removal that actually drops a key present in the
              // order list before this batch. `exists(k)` reads the key set at
              // batch start (paged defers writes; an unpaged key untouched so
              // far this batch reads its start state), so it is true only for a
              // genuinely-present key. Deleting a key that was already absent
              // must NOT enter `removed`: a later re-`set` of that key in the
              // same batch consults `removed.has(k)` to decide "re-add of a
              // pre-existing key" (skip the order append) vs "fresh add"
              // (append). A spurious `removed` entry makes the fresh add look
              // like a re-add, so the key lands in the record map but never in
              // `instance_order`, a silent divergence between the two.
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
    }, batcher ?? undefined);

    reconcileOrder();
    this._owner.commitMutate();
  }

  subscribe(cb: MapSubscriber<T>): HandleUnsubscribe {
    // Content (`set` / `deleted`) rides the map subscription. `order` is
    // attached ONLY when the order moved; a field edit must not pay for a
    // re-sequence. A move is detected in O(changed) by testing changed keys
    // against a cached membership set; the ordered keys (O(order)) are read
    // only on a move. `known` starts empty so the initial fire reads as an
    // all-new move and carries the starting `order`.
    //
    // A `mutate` / remote delta only moves the order by changing the key set,
    // which the cheap membership test catches. The exception is a
    // whole-container re-sync (registration, or a checkout / return / hydrate
    // swapping the source): it can present the SAME key set in a different
    // `instance_order`, which the membership test cannot see. The fire tells
    // us which it is (`resync`) directly, so on a re-sync we read the actual
    // order (O(order), and these fires are rare) and treat only a genuine
    // reorder as a move rather than every re-sync (else an empty registration
    // and an unchanged-order checkout would both deliver a redundant `order`).
    const known = new Set<string>();
    let lastOrder: string[] = [];
    const sameOrder = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((k, i) => k === b[i]);
    return this._map._subscribeInternal((change, origin, resync) => {
      let moved = change.deleted.length > 0;
      for (const key of change.set.keys()) if (!known.has(key)) moved = true;
      let orderKeys: string[] | null = null;
      if (!moved && resync) {
        orderKeys = this.keys();
        if (!sameOrder(orderKeys, lastOrder)) moved = true;
      }
      if (!moved) {
        cb(change, origin);
        return;
      }
      for (const key of change.deleted) known.delete(key);
      for (const key of change.set.keys()) known.add(key);
      const order = orderKeys ?? this.keys();
      lastOrder = order;
      cb({ set: change.set, deleted: change.deleted, order }, origin);
    });
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
  pageCount?: () => number,
  pagingScheme?: () => number,
): MapHandle<T> {
  return new MapHandleImpl<T>(
    rootAnchor(root),
    owner,
    pageCount ?? null,
    pagingScheme ?? null,
  );
}

export function createRootListHandle<T>(
  root: LoroList,
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
  next: LoroList,
): void {
  (handle as unknown as ListHandleImpl<unknown>)._rebindAnchor(next);
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
