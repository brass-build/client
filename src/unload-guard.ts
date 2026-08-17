// Native "leave site?" confirmation while a document holds ops the server
// has not acked. Reloading or navigating away drops those ops with the tab,
// so the browser's own prompt is the last point at which the writer can
// choose to stay.
//
// One registry rather than a listener per document: several documents can be
// open at once (and one the app has closed can still be parked in the SDK's
// cache with ops in flight), while the prompt is a property of the page. The
// registry keys on the owning Document so a count only ever leaves when that
// document acks its ops or closes, and the listener is attached only while
// the total is above zero. A permanently attached listener prompts on every
// navigation, which teaches readers to dismiss it.

export interface UnloadTarget {
  addEventListener(type: 'beforeunload', listener: (e: Event) => void): void;
  removeEventListener(type: 'beforeunload', listener: (e: Event) => void): void;
}

const outstandingByOwner = new Map<object, number>();
let handler: ((e: Event) => void) | null = null;
// The target the handler is attached to, so a detach cannot go to a
// different one than the attach did.
let attachedTo: UnloadTarget | null = null;
// `undefined` means "resolve from the environment"; a test overrides it with
// a fake target, or with `null` to stand in for a non-browser host.
let targetOverride: UnloadTarget | null | undefined;

function resolveTarget(): UnloadTarget | null {
  if (targetOverride !== undefined) return targetOverride;
  const candidate = (globalThis as { window?: unknown }).window;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const target = candidate as Partial<UnloadTarget>;
  if (typeof target.addEventListener !== 'function') return null;
  if (typeof target.removeEventListener !== 'function') return null;
  return target as UnloadTarget;
}

function sync(): void {
  let total = 0;
  for (const count of outstandingByOwner.values()) total += count;

  if (total === 0) {
    if (handler && attachedTo) {
      attachedTo.removeEventListener('beforeunload', handler);
    }
    handler = null;
    attachedTo = null;
    return;
  }
  if (handler) return;
  const target = resolveTarget();
  if (!target) return;
  handler = (e: Event): void => {
    // `preventDefault` is the whole signal. Browsers show their own wording
    // and ignore anything the handler returns or assigns.
    e.preventDefault();
  };
  attachedTo = target;
  target.addEventListener('beforeunload', handler);
}

// Report how many un-acked ops `owner` holds. Zero forgets it.
/** @internal */
export function trackUnsavedWork(owner: object, count: number): void {
  if (count > 0) outstandingByOwner.set(owner, count);
  else outstandingByOwner.delete(owner);
  sync();
}

// Forget `owner` entirely, whatever it last reported. Called from
// `Document.close()`, where the ops go away with the document.
/** @internal */
export function releaseUnsavedWork(owner: object): void {
  if (!outstandingByOwner.delete(owner)) return;
  sync();
}

// Point the guard at a fake target and drop every tracked owner, so one
// test's documents cannot hold the listener open across the next.
/** @internal */
export function _setUnloadTargetForTesting(
  target: UnloadTarget | null | undefined,
): void {
  if (handler && attachedTo) {
    attachedTo.removeEventListener('beforeunload', handler);
  }
  handler = null;
  attachedTo = null;
  outstandingByOwner.clear();
  targetOverride = target;
}
