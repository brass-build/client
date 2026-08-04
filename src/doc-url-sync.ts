// Sync of the active document selection (id, plus branch when not the
// default) to the page URL. `history.replaceState` pins the current
// selection in place (boot restore, direct open); `history.pushState`
// records a genuine navigation so Back / Forward step between the
// documents and branches a user opened. Restored from the URL on boot
// and on `popstate`.
//
// Query parameters, not path segments, because the host app owns its
// own routing: a query param coexists with whatever route it is on,
// whereas rewriting the path would collide with its router.
//
// All operations are best-effort and no-op outside a browser or when
// the History API is unavailable (safe from SSR / Node tests).

export const DEFAULT_DOC_URL_PARAM = 'doc';
export const DEFAULT_BRANCH_URL_PARAM = 'branch';

// One-shot params the hosted picker's redirect fallback returns the pick
// on. Distinct from the app-facing `doc` / `branch` sync params so the
// hand-off works even when the app has turned URL sync off (or renamed
// those params): the SDK consumes these on boot regardless of
// `syncDocToUrl`, opens the document, and strips them so they never
// linger in the app's URL. Named with a `brass_` prefix so they can't
// collide with an app's own query params.
export const PICK_DOC_PARAM = 'brass_pick';
export const PICK_BRANCH_PARAM = 'brass_pick_branch';

// The active selection as carried in the URL. `branchId` is null for
// the default branch, which is never written to the URL.
export interface UrlSelection {
  docId: string;
  branchId: string | null;
}

function getWindow(): (Window & typeof globalThis) | null {
  if (typeof window === 'undefined') return null;
  return window;
}

export function readDocIdFromUrl(param: string): string | null {
  const w = getWindow();
  if (!w) return null;
  try {
    const url = new URL(w.location.href);
    const value = url.searchParams.get(param);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeDocIdToUrl(docId: string, param: string): void {
  const w = getWindow();
  if (!w) return;
  try {
    const url = new URL(w.location.href);
    if (url.searchParams.get(param) === docId) return;
    url.searchParams.set(param, docId);
    w.history.replaceState(w.history.state, '', url.toString());
  } catch {
    // History API unavailable or URL exotic: leave the URL alone.
  }
}

export function clearDocIdFromUrl(param: string): void {
  const w = getWindow();
  if (!w) return;
  try {
    const url = new URL(w.location.href);
    if (!url.searchParams.has(param)) return;
    url.searchParams.delete(param);
    w.history.replaceState(w.history.state, '', url.toString());
  } catch {
    // See `writeDocIdToUrl`.
  }
}

// Read the active selection from the URL. Returns null when no document
// is named, so a branch param alone never resurrects a selection.
export function readUrlSelection(
  docParam: string,
  branchParam: string,
): UrlSelection | null {
  const w = getWindow();
  if (!w) return null;
  try {
    const url = new URL(w.location.href);
    const docId = url.searchParams.get(docParam);
    if (!docId || docId.length === 0) return null;
    const branch = url.searchParams.get(branchParam);
    return { docId, branchId: branch && branch.length > 0 ? branch : null };
  } catch {
    return null;
  }
}

// Write the active selection to the URL. `push` records a genuine
// navigation; otherwise the current entry is replaced in place. The
// branch param is set only for a non-default branch, so a default-branch
// selection reads back as a bare `?doc=`. A write whose resulting URL
// matches the current one is skipped, so a redundant push never plants
// a duplicate entry.
export function writeUrlSelection(
  selection: UrlSelection,
  docParam: string,
  branchParam: string,
  options: { push: boolean },
): void {
  const w = getWindow();
  if (!w) return;
  try {
    const url = new URL(w.location.href);
    url.searchParams.set(docParam, selection.docId);
    if (selection.branchId !== null) {
      url.searchParams.set(branchParam, selection.branchId);
    } else {
      url.searchParams.delete(branchParam);
    }
    const next = url.toString();
    if (next === w.location.href) return;
    if (options.push) {
      w.history.pushState(w.history.state, '', next);
    } else {
      w.history.replaceState(w.history.state, '', next);
    }
  } catch {
    // History API unavailable or URL exotic: leave the URL alone.
  }
}

// Clear the active selection from the URL via `replaceState` (a clear
// is never a navigation, so it pushes no history entry).
export function clearUrlSelection(docParam: string, branchParam: string): void {
  const w = getWindow();
  if (!w) return;
  try {
    const url = new URL(w.location.href);
    if (!url.searchParams.has(docParam) && !url.searchParams.has(branchParam)) {
      return;
    }
    url.searchParams.delete(docParam);
    url.searchParams.delete(branchParam);
    w.history.replaceState(w.history.state, '', url.toString());
  } catch {
    // See `writeUrlSelection`.
  }
}

// Read and CONSUME the hosted picker's one-shot pick from the URL: return
// the selection the redirect fallback returned, and strip both pick params
// in the same call (via `replaceState`, never a navigation) so a reload
// can't reopen the pick and the params don't leak into the app's URL.
// Returns null when no pick is present (the ordinary boot). Runs
// independently of `syncDocToUrl`, since the redirect needs to hand a pick
// back even to an app that manages its own selection.
export function takePickFromUrl(): UrlSelection | null {
  const w = getWindow();
  if (!w) return null;
  try {
    const url = new URL(w.location.href);
    const docId = url.searchParams.get(PICK_DOC_PARAM);
    if (!docId || docId.length === 0) return null;
    const branch = url.searchParams.get(PICK_BRANCH_PARAM);
    const branchId = branch && branch.length > 0 ? branch : null;
    url.searchParams.delete(PICK_DOC_PARAM);
    url.searchParams.delete(PICK_BRANCH_PARAM);
    w.history.replaceState(w.history.state, '', url.toString());
    return { docId, branchId };
  } catch {
    return null;
  }
}

// Subscribe to Back / Forward navigation. No-op outside a browser.
// Only user-driven Back / Forward fires `popstate`; the SDK's own
// push / replace writes do not, so a restore on `popstate` cannot feed
// back into another history write.
export function subscribePopState(listener: () => void): () => void {
  const w = getWindow();
  if (!w) return () => {};
  w.addEventListener('popstate', listener);
  return () => w.removeEventListener('popstate', listener);
}
