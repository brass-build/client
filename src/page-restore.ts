// A page the browser restores from its back-forward cache resumes with the
// state it was frozen in, and nothing it held can be trusted to still be true.
// Two things go stale with no event to say so: a link this page was a guest
// on can have been claimed or revoked while it was frozen, and the person can
// have signed in or out in the page they navigated to. Either way the page
// shows someone the wrong document under the wrong identity, so it loads
// again, which asks both questions afresh.

export interface RestoredPageState {
  /** The link token this page is a guest on, or null. */
  guestLinkToken: string | null;
  /** Whether this page resolved a signed-in person. */
  signedIn: boolean;
  /** Whether this browser's stored hint says a session exists for the app. */
  sessionHinted: boolean;
}

// Whether a guest link still answers. `null` when the question could not be
// asked (no network), which keeps the page rather than reloading it offline.
export type LinkStillOpen = (token: string) => Promise<boolean | null>;

export async function restoredPageIsStale(
  state: RestoredPageState,
  linkStillOpen: LinkStillOpen,
): Promise<boolean> {
  if (state.guestLinkToken !== null) {
    return (await linkStillOpen(state.guestLinkToken)) === false;
  }
  return state.signedIn !== state.sessionHinted;
}

// Calls `onRestore` for every show that comes out of the back-forward cache.
export function onPageRestored(onRestore: () => void): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('pageshow', (event) => {
    if ((event as { persisted?: boolean }).persisted === true) onRestore();
  });
}
