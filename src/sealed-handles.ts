// The handle surface over a static record store.
//
// A document's encoding is not something an app is told about, so the roots of
// a static document are reached through the same `MapHandle` / `ListHandle` /
// `OrderedMapHandle` types a CRDT document's roots are: a projection built in
// a subscriber, a record resolved by key, a scoped handle onto one record's
// body. One read type over both encodings is what makes the encoding the
// platform's decision rather than the app's, so these implement the published
// interfaces rather than a read-only cousin of them.
//
// What they do not carry is a write. A record set holds no history for an edit
// to become, and building the CRDT that would hold one is the platform's
// (`runRecordSetConversion`), so a document served as a record set is one the
// reader asked to read. The write methods the interfaces declare therefore
// refuse through the document's own read-only gate, which names the reader's
// actual limit rather than the encoding.
//
// Reads stay as lazy as the store is. A keyed read decodes the one page that
// holds the record; `keys()` costs the pages' key lists; only a subscriber,
// which is asking for the whole collection by definition, walks every page.

import type {
  Change,
  HandleUnsubscribe,
  TextHandle,
  TextSubscriber,
  ListHandle,
  ListSubscriber,
  MapHandle,
  MapSubscriber,
  OrderedMapHandle,
  Splice,
} from './handle-types.js';
import { pushBoundedSplice } from './subscriber-delivery.js';
import { SealedStore, type SealedContent, type SealedMapReader } from './sealed-store.js';

/**
 * How a write through one of these handles is refused.
 *
 * The document's own gate, passed in rather than restated here, so the
 * refusal names what the reader is actually up against (a snapshot they asked
 * for, a view-only grant, a link) instead of describing how the platform
 * happens to store the content. It always throws for a document served as a
 * record set, because such a document is opened read-only; the throw that
 * follows a gate that did not is the invariant stated where it is relied on.
 */
type RefuseWrite = () => void;

function refuse(assertWritable: RefuseWrite): never {
  assertWritable();
  throw new Error('Document is read-only: it holds a stored record set.');
}

/** Whether a decoded body carries this entry itself. The prototype chain is
 *  not part of a record, so a key an app never wrote must not resolve through
 *  it. */
function ownEntry(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** The subscribers of one handle, re-delivered when the content it reads is
 *  swapped. */
class RootSubscribers<C> {
  private readonly _subs = new Set<C>();

  add(cb: C, deliver: (cb: C) => void): HandleUnsubscribe {
    this._subs.add(cb);
    deliver(cb);
    return () => {
      this._subs.delete(cb);
    };
  }

  each(visit: (cb: C) => void): void {
    for (const cb of this._subs) {
      try {
        visit(cb);
      } catch {
        // A throwing subscriber cannot strand the others.
      }
    }
  }
}

/** A stored map root as a map handle, and as the ordered map its stored
 *  order makes it. */
class SealedRecordMap<T> implements MapHandle<T>, OrderedMapHandle<T> {
  private readonly _subs = new RootSubscribers<MapSubscriber<T>>();
  private readonly _settled = new RootSubscribers<() => void>();
  // The keys each subscriber was last handed, so a swap reports the ones the
  // new content no longer holds as deleted.
  private readonly _delivered = new Map<MapSubscriber<T>, string[]>();

  /** `content` resolves the content this document shows now. A root that
   *  content does not hold reads as the empty collection a CRDT document
   *  reports for a container nothing has written.
   *
   *  `_ordered` is which of the two interfaces this instance was taken as. A
   *  plain map's change carries no `order`, because that field is how an
   *  ordered map tells a subscriber to re-sequence; carrying it on a plain
   *  map's fire would ask for work the app never asked to do. */
  constructor(
    private readonly _content: () => SealedContent,
    private readonly _name: string,
    private readonly _refuse: RefuseWrite,
    private readonly _ordered: boolean,
  ) {}

  private _map(): SealedMapReader | null {
    return this._content().mapRoot(this._name);
  }

  get(entryKey: string): T | undefined {
    return this._map()?.get(entryKey) as T | undefined;
  }

  has(entryKey: string): boolean {
    return this._map()?.has(entryKey) ?? false;
  }

  keys(): string[] {
    return this._map()?.keys() ?? [];
  }

  *entries(): IterableIterator<[string, T]> {
    const map = this._map();
    if (map !== null) yield* map.entries() as IterableIterator<[string, T]>;
  }

  /** @internal The whole collection at once. */
  read(): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [key, value] of this.entries()) out[key] = value;
    return out;
  }

  ordered(): { key: string; value: T }[] {
    const out: { key: string; value: T }[] = [];
    for (const [key, value] of this.entries()) out.push({ key, value });
    return out;
  }

  subscribe(cb: MapSubscriber<T>): HandleUnsubscribe {
    const off = this._subs.add(cb, (sub) => this._deliver(sub));
    return () => {
      off();
      this._delivered.delete(cb);
    };
  }

  private _deliver(cb: MapSubscriber<T>): void {
    const set = new Map<string, T>();
    const order: string[] = [];
    const map = this._map();
    if (map !== null) {
      for (const [key, value] of map.entries() as IterableIterator<[string, T]>) {
        set.set(key, value);
        order.push(key);
      }
    }
    const before = this._delivered.get(cb) ?? [];
    const deleted = before.filter((key) => !set.has(key));
    this._delivered.set(cb, order);
    const change: Change<T> = this._ordered ? { set, deleted, order } : { set, deleted };
    cb(change);
  }

  onSettled(cb: () => void): HandleUnsubscribe {
    return this._settled.add(cb, (sub) => sub());
  }

  /** @internal Re-deliver every subscriber against the content now shown. */
  _resync(): void {
    this._subs.each((cb) => this._deliver(cb));
    this._settled.each((cb) => cb());
  }

  map<U>(entryKey: string): MapHandle<U> {
    const value = this.get(entryKey);
    return new SealedValueMap<U>(() => value, this._refuse);
  }

  list<U>(entryKey: string): ListHandle<U> {
    const value = this.get(entryKey);
    return new SealedValueList<U>(() => value, this._refuse);
  }

  mutate(): void {
    refuse(this._refuse);
  }

  insert(): void {
    refuse(this._refuse);
  }

  move(): void {
    refuse(this._refuse);
  }
}

/** A map handle over a plain value decoded out of the store: a map root that
 *  holds no records, a record, or a field inside one. A scoped handle onto an
 *  entry a CRDT document has not created yet reads as empty, and so does this
 *  one. `value` resolves at call time, so a root follows the content its
 *  document shows. */
class SealedValueMap<T> implements MapHandle<T> {
  private readonly _subs = new RootSubscribers<MapSubscriber<T>>();
  private readonly _settled = new RootSubscribers<() => void>();
  private readonly _delivered = new Map<MapSubscriber<T>, string[]>();

  constructor(
    private readonly _value: () => unknown,
    private readonly _refuse: RefuseWrite,
  ) {}

  private _object(): Record<string, unknown> {
    const value = this._value();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  get(entryKey: string): T | undefined {
    const object = this._object();
    return ownEntry(object, entryKey) ? (object[entryKey] as T) : undefined;
  }

  has(entryKey: string): boolean {
    return ownEntry(this._object(), entryKey);
  }

  keys(): string[] {
    return Object.keys(this._object());
  }

  *entries(): IterableIterator<[string, T]> {
    const object = this._object();
    for (const key of Object.keys(object)) yield [key, object[key] as T];
  }

  /** @internal The whole collection at once. */
  read(): Record<string, T> {
    return { ...this._object() } as Record<string, T>;
  }

  subscribe(cb: MapSubscriber<T>): HandleUnsubscribe {
    const off = this._subs.add(cb, (sub) => this._deliver(sub));
    return () => {
      off();
      this._delivered.delete(cb);
    };
  }

  private _deliver(cb: MapSubscriber<T>): void {
    const object = this._object();
    const keys = Object.keys(object);
    const before = this._delivered.get(cb) ?? [];
    this._delivered.set(cb, keys);
    cb({
      set: new Map(keys.map((key) => [key, object[key] as T])),
      deleted: before.filter((key) => !ownEntry(object, key)),
    });
  }

  onSettled(cb: () => void): HandleUnsubscribe {
    return this._settled.add(cb, (sub) => sub());
  }

  /** @internal */
  _resync(): void {
    this._subs.each((cb) => this._deliver(cb));
    this._settled.each((cb) => cb());
  }

  map<U>(entryKey: string): MapHandle<U> {
    const value = this._object()[entryKey];
    return new SealedValueMap<U>(() => value, this._refuse);
  }

  list<U>(entryKey: string): ListHandle<U> {
    const value = this._object()[entryKey];
    return new SealedValueList<U>(() => value, this._refuse);
  }

  mutate(): void {
    refuse(this._refuse);
  }
}

class SealedValueList<T> implements ListHandle<T> {
  private readonly _subs = new RootSubscribers<ListSubscriber<T>>();
  private readonly _settled = new RootSubscribers<() => void>();
  private readonly _delivered = new Map<ListSubscriber<T>, number>();

  constructor(
    private readonly _value: () => unknown,
    private readonly _refuse: RefuseWrite,
  ) {}

  private _array(): T[] {
    const value = this._value();
    return Array.isArray(value) ? (value as T[]) : [];
  }

  length(): number {
    return this._array().length;
  }

  get(index: number): T | undefined {
    if (!Number.isInteger(index) || index < 0) return undefined;
    return this._array()[index];
  }

  *values(): IterableIterator<T> {
    yield* this._array();
  }

  /** @internal The whole list at once. */
  read(): T[] {
    return [...this._array()];
  }

  subscribe(cb: ListSubscriber<T>): HandleUnsubscribe {
    const off = this._subs.add(cb, (sub) => this._deliver(sub));
    return () => {
      off();
      this._delivered.delete(cb);
    };
  }

  private _deliver(cb: ListSubscriber<T>): void {
    const items = this._array();
    const removed = this._delivered.get(cb) ?? 0;
    this._delivered.set(cb, items.length);
    const splices: Splice<T>[] = [];
    pushBoundedSplice(splices, { at: 0, removed, inserted: items });
    cb({ splices });
  }

  onSettled(cb: () => void): HandleUnsubscribe {
    return this._settled.add(cb, (sub) => sub());
  }

  /** @internal */
  _resync(): void {
    this._subs.each((cb) => this._deliver(cb));
    this._settled.each((cb) => cb());
  }

  mutate(): void {
    refuse(this._refuse);
  }
}

/** A text root. */
class SealedText implements TextHandle {
  private readonly _subs = new RootSubscribers<TextSubscriber>();

  constructor(
    private readonly _value: () => string,
    private readonly _refuse: RefuseWrite,
  ) {}

  read(): string {
    return this._value();
  }

  update(): void {
    refuse(this._refuse);
  }

  subscribe(cb: TextSubscriber): HandleUnsubscribe {
    return this._subs.add(cb, (sub) => sub(this._value()));
  }

  /** @internal */
  _resync(): void {
    this._subs.each((cb) => cb(this._value()));
  }
}

/** The roots of a document over frozen content. */
export type SealedRoots = ReturnType<typeof sealedRoots>;

/**
 * The roots of a document over frozen content, whatever the content declares.
 *
 * `stored` may resolve the content the document shows now, so a version
 * checkout swaps what every root reads and `resync` re-delivers the handles an
 * app already holds. Each root handle is made once per key, which is what lets
 * that reach them.
 *
 * A root the content does not hold reads as an empty map, list or text rather
 * than throwing, which is what a CRDT document does for a container nothing
 * has written: an app that reaches for a root of its own on an imported
 * document gets the same empty answer either way.
 */
export function sealedRoots(
  stored: SealedContent | SealedStore | (() => SealedContent),
  refuseWrite: RefuseWrite,
) {
  const content: () => SealedContent =
    typeof stored === 'function'
      ? stored
      : ((fixed) => () => fixed)(stored instanceof SealedStore ? stored.content : stored);
  // Decoded lists, per content, so a checkout never reads a stale memo.
  const lists = new WeakMap<SealedContent, Map<string, unknown[]>>();
  const listOf = (key: string): unknown[] | undefined => {
    const current = content();
    if (current.kindOf(key) !== 'list') return undefined;
    let memo = lists.get(current);
    if (memo === undefined) {
      memo = new Map();
      lists.set(current, memo);
    }
    let items = memo.get(key);
    if (items === undefined) {
      items = current.list(key) ?? [];
      memo.set(key, items);
    }
    return items;
  };
  const roots = new Map<string, { _resync(): void }>();
  const once = <H extends { _resync(): void }>(cacheKey: string, make: () => H): H => {
    let handle = roots.get(cacheKey) as H | undefined;
    if (handle === undefined) {
      handle = make();
      roots.set(cacheKey, handle);
    }
    return handle;
  };
  return {
    map<T>(key: string): MapHandle<T> {
      return once(
        `map:${key}`,
        () => new SealedRecordMap<unknown>(content, key, refuseWrite, false),
      ) as MapHandle<T>;
    },
    list<T>(key: string): ListHandle<T> {
      return once(
        `list:${key}`,
        () => new SealedValueList<unknown>(() => listOf(key), refuseWrite),
      ) as ListHandle<T>;
    },
    text(key: string): TextHandle {
      return once(`text:${key}`, () => new SealedText(() => content().text(key) ?? '', refuseWrite));
    },
    orderedMap<T>(mapKey: string, _orderKey: string): OrderedMapHandle<T> {
      // A stored map keeps its entries in the order its order list gave
      // them, so the map's own walk is the ordered map's order.
      return once(
        `ordered:${mapKey}`,
        () => new SealedRecordMap<unknown>(content, mapKey, refuseWrite, true),
      ) as OrderedMapHandle<T>;
    },
    /** Re-deliver every root handle's subscribers against the content now
     *  shown. */
    resync(): void {
      for (const handle of roots.values()) handle._resync();
    },
    /** The kind of every root that holds something, in key order, the way a
     *  CRDT document's `roots()` reports them. */
    roots(): Record<string, 'map' | 'list' | 'text'> {
      const current = content();
      const found: [string, 'map' | 'list' | 'text'][] = [];
      for (const name of current.rootNames()) {
        const kind = current.kindOf(name);
        if (kind === undefined) continue;
        const empty =
          kind === 'map'
            ? (current.mapRoot(name)?.size() ?? 0) === 0
            : kind === 'list'
              ? (listOf(name)?.length ?? 0) === 0
              : (current.text(name) ?? '') === '';
        if (!empty) found.push([name, kind]);
      }
      found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return Object.fromEntries(found);
    },
    /** The whole document as plain JSON, empty roots included; the
     *  Document leaves those out. */
    toJSON(): Record<string, unknown> {
      return content().toJSON();
    },
  };
}
