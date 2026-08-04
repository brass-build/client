// Per-app sessionStorage layer for the incognito / third-party-cookie
// fallback session token: the opaque `sid` from a `brass_code` exchange, so
// a hard reload in a cookie-blocked browser (incognito, Safari ITP) keeps
// the user signed in. In a normal browser the cross-site cookie carries the
// session and nothing is written here.
//
// The value is no more sensitive than the cookie it mirrors: an opaque
// pointer, useless off an allowlisted Origin, gated by `approved_apps`
// server-side, same 30-day TTL. `sessionStorage` (per-tab, dropped on tab
// close) matches the cookie-channel UX. Keyed per-app id.

const KEY_PREFIX = '__brass_session_';

let warnedUnavailable = false;

function getStorage(): Storage | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

function warnOnceUnavailable(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(
    'Brass: sessionStorage is unavailable; the incognito session-token fallback will not survive reloads.',
  );
}

function key(appId: string): string {
  return `${KEY_PREFIX}${appId}`;
}

export function storeSessionToken(appId: string, token: string): void {
  const storage = getStorage();
  if (!storage) {
    warnOnceUnavailable();
    return;
  }
  try {
    storage.setItem(key(appId), token);
  } catch {
    // Quota / disabled storage; drop rather than fail a /refresh that
    // already succeeded (reload-survival is a niceness).
  }
}

export function readSessionToken(appId: string): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    return storage.getItem(key(appId));
  } catch {
    return null;
  }
}

export function clearSessionToken(appId: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(key(appId));
  } catch {
    // See `storeSessionToken`.
  }
}
