// The handles a Document hands an app.
//
// A document's storage can change under an open copy, from frozen content to
// a CRDT when it is edited and back when a frozen copy reloads onto a reseal.
// Each handle here passes every call to the handle the current storage
// provides for the same container, and owns its subscriptions, so a swap
// moves them in one place and the handles behind it never learn of it.

import type {
  HandleUnsubscribe,
  ListHandle,
  ListSubscriber,
  MapHandle,
  MapSubscriber,
  OrderedMapHandle,
  TextHandle,
} from './handle-types.js';
import { hideOwnFields } from './handles.js';

type Call = (...args: unknown[]) => unknown;
type Backing = Record<string, Call>;
type Kind = 'map' | 'list' | 'text';

interface Scope {
  generation: number;
  // Every handle holding a subscription, which a swap has to move.
  readonly subscribed: Set<StableHandle>;
  readonly report: (err: unknown) => void;
}

interface Subscription {
  cb: Call;
  settled: boolean;
  off: HandleUnsubscribe;
}

/** A map subscriber whose first fire also reports the keys it was handed
 *  before and the new container no longer holds, which is what a swap owes
 *  a subscriber that moves with it. */
function reportingLeftKeys<T>(cb: MapSubscriber<T>, before: readonly string[]): MapSubscriber<T> {
  let first = true;
  return (change, origin) => {
    if (first) {
      first = false;
      const left = before.filter((key) => !change.set.has(key));
      if (left.length > 0) change = { ...change, deleted: [...change.deleted, ...left] };
    }
    cb(change, origin);
  };
}

/** The list counterpart: the first fire also removes the items handed before. */
function replacingHeldItems<T>(cb: ListSubscriber<T>, held: number): ListSubscriber<T> {
  let first = true;
  return (change) => {
    if (first) {
      first = false;
      if (held > 0) {
        const [head, ...rest] = change.splices;
        change =
          head !== undefined && head.at === 0
            ? { splices: [{ ...head, removed: head.removed + held }, ...rest] }
            : { splices: [{ at: 0, removed: held, inserted: [] }, ...change.splices] };
      }
    }
    cb(change);
  };
}

class StableHandle {
  private _backing: Backing;
  private _at: number;
  private readonly _subs = new Set<Subscription>();
  // Keyed by the scoped handle the backing hands out, so whether two calls
  // return the same one is the backing's decision.
  private readonly _children = new WeakMap<object, StableHandle>();

  constructor(
    private readonly _scope: Scope,
    private readonly _kind: Kind,
    private readonly _resolve: () => unknown,
    backing: unknown = _resolve(),
  ) {
    this._backing = backing as Backing;
    this._at = _scope.generation;
    hideOwnFields(this);
  }

  private get _h(): Backing {
    if (this._at !== this._scope.generation) {
      this._backing = this._resolve() as Backing;
      this._at = this._scope.generation;
    }
    return this._backing;
  }

  _call(method: string, args: unknown[]): unknown {
    return this._h[method]!(...args);
  }

  map(key: string): StableHandle {
    return this._child('map', key);
  }

  list(key: string): StableHandle {
    return this._child('list', key);
  }

  private _child(kind: Kind, key: string): StableHandle {
    const backing = this._call(kind, [key]) as object;
    let child = this._children.get(backing);
    if (child === undefined) {
      child = new StableHandle(this._scope, kind, () => this._call(kind, [key]), backing);
      this._children.set(backing, child);
    }
    return child;
  }

  subscribe(cb: Call): HandleUnsubscribe {
    return this._add(cb, false);
  }

  onSettled(cb: Call): HandleUnsubscribe {
    return this._add(cb, true);
  }

  private _add(cb: Call, settled: boolean): HandleUnsubscribe {
    const sub: Subscription = { cb, settled, off: () => {} };
    sub.off = this._call(settled ? 'onSettled' : 'subscribe', [cb]) as HandleUnsubscribe;
    this._subs.add(sub);
    this._scope.subscribed.add(this);
    return () => {
      sub.off();
      this._subs.delete(sub);
      if (this._subs.size === 0) this._scope.subscribed.delete(this);
    };
  }

  // Take every subscription off the current handle, noting what its
  // subscribers were handed; the returned call registers them with the handle
  // the storage provides by then, as a whole-container delivery.
  _detach(): () => void {
    const held = this._kind === 'text' ? null : this._call(this._kind === 'map' ? 'keys' : 'length', []);
    const moved = (cb: Call): Call =>
      this._kind === 'map'
        ? (reportingLeftKeys(cb as MapSubscriber<unknown>, held as string[]) as Call)
        : this._kind === 'list'
          ? (replacingHeldItems(cb as ListSubscriber<unknown>, held as number) as Call)
          : cb;
    for (const sub of this._subs) sub.off();
    return () => {
      // Subscribers first, so each `onSettled` fires after the delivery it
      // reports.
      for (const settled of [false, true]) {
        for (const sub of this._subs) {
          if (sub.settled !== settled) continue;
          const cb = settled ? sub.cb : moved(sub.cb);
          try {
            sub.off = this._call(settled ? 'onSettled' : 'subscribe', [cb]) as HandleUnsubscribe;
          } catch (err) {
            sub.off = () => {};
            this._scope.report(err);
          }
        }
      }
    };
  }
}

type Passed = Exclude<
  keyof MapHandle | keyof ListHandle | keyof OrderedMapHandle | keyof TextHandle,
  'subscribe' | 'onSettled' | 'map' | 'list'
>;

// Every other call passes straight through. A record, so a method the handle
// interfaces gain does not compile until it is listed here.
const PASSED: Record<Passed | 'read' | '_pageIndexRebuilds', true> = {
  get: true,
  has: true,
  keys: true,
  entries: true,
  values: true,
  length: true,
  read: true,
  ordered: true,
  mutate: true,
  insert: true,
  move: true,
  update: true,
  _pageIndexRebuilds: true,
};
for (const method of Object.keys(PASSED)) {
  Object.defineProperty(StableHandle.prototype, method, {
    value(this: StableHandle, ...args: unknown[]): unknown {
      return this._call(method, args);
    },
  });
}

/** The handles one Document has handed out, one per root. */
export class StableHandles {
  private _scope: Scope;
  private readonly _roots = new Map<string, StableHandle>();

  constructor(private readonly _report: (err: unknown) => void) {
    this._scope = { generation: 0, subscribed: new Set(), report: _report };
  }

  /** The handle under `cacheKey`, made over what `resolve` returns. `resolve`
   *  is asked again after every `swap`. */
  root<H>(cacheKey: string, kind: Kind, resolve: () => H): H {
    let handle = this._roots.get(cacheKey);
    if (handle === undefined) {
      handle = new StableHandle(this._scope, kind, resolve);
      this._roots.set(cacheKey, handle);
    }
    return handle as unknown as H;
  }

  /** Change the storage behind every handle: `change` runs while nothing is
   *  subscribed to the old storage, and every subscription then moves to the
   *  new one. */
  swap(change: () => void): void {
    const moves = Array.from(this._scope.subscribed, (handle) => handle._detach());
    change();
    this._scope.generation++;
    for (const move of moves) move();
  }

  /** Forget every handle. One an app still holds stays on the storage it had. */
  clear(): void {
    this._roots.clear();
    this._scope = { generation: 0, subscribed: new Set(), report: this._report };
  }
}
