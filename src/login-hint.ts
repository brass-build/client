// Per-app "a Brass session probably exists for this app" hint.
//
// The platform session lives in an httpOnly cross-site cookie the app's
// origin can't read, so on a cold load the SDK would POST `/refresh`
// blindly; for a signed-out visitor that 401s, which the browser logs to
// the console even though the SDK handles it cleanly. The hint lets the SDK
// skip the probe when it has no reason to believe a session exists.
//
// Set after any successful refresh, cleared on sign-out or an empty
// refresh. localStorage (not sessionStorage) so a returning, already-
// approved user gets a silent restore in a brand-new tab. The value is a
// non-secret boolean flag (the real session is the server-side row gated by
// `approved_apps`, useless without the cookie), so readable storage leaks
// nothing. Keyed per app id.

const KEY_PREFIX = '__brass_login_hint_';

function getStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function key(appId: string): string {
  return `${KEY_PREFIX}${appId}`;
}

export function storeLoginHint(appId: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(key(appId), '1');
  } catch {
    // Quota / disabled storage. The hint is a best-effort optimisation;
    // without it the SDK probes /refresh unconditionally.
  }
}

export function readLoginHint(appId: string): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    return storage.getItem(key(appId)) === '1';
  } catch {
    return false;
  }
}

export function clearLoginHint(appId: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(key(appId));
  } catch {
    // See storeLoginHint.
  }
}
