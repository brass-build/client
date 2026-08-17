// Internal listener-fanout primitive. One home for the pattern the SDK's
// subscribe surfaces share: a `Set` of callbacks, an add/delete unsubscribe,
// an emit loop, and the small per-site knobs (deliver-on-attach, retain the
// last value, drop duplicate emits, and how a listener's throw is handled).
// Not exported from `index.ts`: every caller is SDK-internal (the document
// lifecycle signals, the Document subscriber set, the client's error
// listeners).

export interface EmitterOptions<T> {
  // Deliver the retained value to a newly-attached listener, in a microtask,
  // so a listener wired after the value arrived still sees it once. The
  // microtask keeps the callsite ordering identical whether the value is
  // already present or arrives later (the unsubscribe is returned before the
  // deferred fire runs). Needs a `retain` policy to have a value to deliver.
  fireOnAttach?: boolean;
  // Whether the last emitted value is cached:
  //   'latest'  - cache it; a `fireOnAttach` attach delivers it, and it
  //               survives `clear()`.
  //   'oneShot' - cache it and stop after the first emit: later emits are
  //               dropped, the listener set is cleared once it fires, and a
  //               later attach delivers the cached value once without
  //               retaining the listener.
  retain?: 'latest' | 'oneShot';
  // Drop an emit whose value equals the retained one (consulted only once a
  // value is retained), so a source that re-emits on unrelated changes does
  // not wake listeners when nothing they read moved.
  equals?: (value: T, retained: T) => boolean;
  // Called with a listener's thrown error instead of letting it propagate.
  // Omit to let a throw propagate and abort the emit loop. The three policies
  // the SDK uses: swallow (`onError: () => {}`), log and continue
  // (`onError: (e) => console.error(...)`), and propagate (omit).
  onError?: (err: unknown) => void;
}

export interface Emitter<T> {
  // Register a listener; the returned function detaches it. Idempotent detach.
  on(cb: (value: T) => void): () => void;
  // Fanout `value` to every listener, applying the retain / dedup / one-shot
  // policy and the error handling.
  emit(value: T): void;
  // Drop all listeners. The retained value (if any) is kept, so a later attach
  // still delivers it: this matches the signals' `clearListeners`, where a
  // suspend / close drops app callbacks but a resumed open still reads the
  // last status.
  clear(): void;
  // The last emitted value, or `undefined` if none has been emitted (or the
  // emitter does not retain). None of the SDK's retained types carry
  // `undefined` as a meaningful value, so a caller coalesces with `?? null`.
  readonly retained: T | undefined;
  readonly size: number;
}

export function createEmitter<T>(opts: EmitterOptions<T> = {}): Emitter<T> {
  const { fireOnAttach = false, retain, equals, onError } = opts;
  const listeners = new Set<(value: T) => void>();
  const oneShot = retain === 'oneShot';
  const retains = retain !== undefined;
  let hasValue = false;
  let retained: T | undefined;

  const dispatch = (cb: (value: T) => void, value: T): void => {
    if (onError) {
      try {
        cb(value);
      } catch (err) {
        onError(err);
      }
    } else {
      cb(value);
    }
  };

  return {
    on(cb) {
      if (fireOnAttach && hasValue) {
        if (oneShot) {
          // A one-shot has already fired for everyone: a late attach gets the
          // cached value once (in a microtask, so the unsubscribe returns
          // first) and is not retained. Terminal, so the returned unsubscribe
          // is a no-op (there is no ongoing subscription to cancel).
          const value = retained as T;
          queueMicrotask(() => {
            dispatch(cb, value);
          });
          return () => {};
        }
        // Deliver the retained value on attach, in a microtask so the
        // unsubscribe returns first. Two guards keep the deferred fire honest:
        // skip it if the listener detached in the meantime (a synchronous
        // unsubscribe, e.g. a framework effect's immediate cleanup, must not
        // still receive a value), and deliver the CURRENT retained value
        // rather than a snapshot taken at attach time, so a value emitted
        // between attach and flush is not clobbered by a stale one.
        listeners.add(cb);
        queueMicrotask(() => {
          if (!listeners.has(cb)) return;
          dispatch(cb, retained as T);
        });
        return () => {
          listeners.delete(cb);
        };
      }
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    emit(value) {
      // A one-shot's first emit is terminal, so drop any later one.
      if (oneShot && hasValue) return;
      if (equals && hasValue && equals(value, retained as T)) return;
      if (retains) {
        retained = value;
        hasValue = true;
      }
      // Over a snapshot, because a listener may detach or clear the rest
      // while the fanout is running: the session's own `onGone` handler
      // closes the document, which clears its listener set, and a `Set`
      // never visits an entry removed before its turn. Iterating live there
      // silently drops every listener registered after the session's, which
      // is all of the app's.
      const receiving = Array.from(listeners);
      for (const cb of receiving) dispatch(cb, value);
      if (oneShot) listeners.clear();
    },
    clear() {
      listeners.clear();
    },
    get retained() {
      return retained;
    },
    get size() {
      return listeners.size;
    },
  };
}
