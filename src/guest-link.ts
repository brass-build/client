// The anonymous "anyone with the link" boot signal. When Brass routes a
// no-sign-in share link into an app, it appends `?brass_link=<token>` to
// the app's URL. `Brass.init` reads it here and opens the document
// read-only through the token (`GET /links/:token/view`), with no sign-in.
//
// Pure + search-string-in so it stays testable, mirroring
// `isExportMode(search)`.

const GUEST_LINK_PARAM = 'brass_link';

export function readGuestLinkToken(search: string): string | null {
  const value = new URLSearchParams(search).get(GUEST_LINK_PARAM);
  return value && value.trim() !== '' ? value : null;
}

// Pin the token into the page URL (`replaceState`, never a history entry):
// a document created while signed out is reached again only through its
// token, so a reload restores it from here, and `signIn()` carries this URL
// as its return address.
export function writeGuestLinkToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set(GUEST_LINK_PARAM, token);
    const next = url.toString();
    if (next === window.location.href) return;
    window.history.replaceState(window.history.state, '', next);
  } catch {
    // History API unavailable or URL exotic: leave the URL alone.
  }
}

export function clearGuestLinkToken(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(GUEST_LINK_PARAM)) return;
    url.searchParams.delete(GUEST_LINK_PARAM);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // See `writeGuestLinkToken`.
  }
}

// The last document a visitor created without an account, per app. The URL
// is that document's only handle, so a visitor who closes the tab and comes
// back to the app's root would have no way back to it; the app's signed-out
// gate offers it from here. localStorage, since the return is in a new tab.
// The expiry is stored beside the token so the gate can say when the work
// is lost without a request, and an entry past it reads as absent.
//
// The token is a credential to an editable document, which is why the
// session hands an app the expiry alone and opens the document itself.
const UNSAVED_KEY_PREFIX = 'brass:unsaved:';

export interface UnsavedWorkEntry {
  token: string;
  expiresAt: Date;
}

function unsavedStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function unsavedKey(appId: string): string {
  return `${UNSAVED_KEY_PREFIX}${appId}`;
}

export function storeUnsavedWork(
  appId: string,
  token: string,
  expiresAt: Date,
): void {
  const storage = unsavedStorage();
  if (!storage) return;
  try {
    storage.setItem(
      unsavedKey(appId),
      JSON.stringify({ token, expires_at: expiresAt.toISOString() }),
    );
  } catch {
    // Quota / disabled storage. The way back is a niceness; the open that
    // just succeeded must not fail on it.
  }
}

export function readUnsavedWork(
  appId: string,
  now: number = Date.now(),
): UnsavedWorkEntry | null {
  const storage = unsavedStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(unsavedKey(appId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = parsed as { token?: unknown; expires_at?: unknown } | null;
  const expiresAt =
    typeof entry?.expires_at === 'string' ? new Date(entry.expires_at) : null;
  if (
    typeof entry?.token !== 'string' ||
    entry.token === '' ||
    expiresAt === null ||
    Number.isNaN(expiresAt.getTime())
  ) {
    return null;
  }
  // The platform removes the document at the expiry, so an entry past it
  // names nothing and is dropped here rather than offered.
  if (expiresAt.getTime() <= now) {
    clearUnsavedWork(appId);
    return null;
  }
  return { token: entry.token, expiresAt };
}

export function clearUnsavedWork(appId: string): void {
  const storage = unsavedStorage();
  if (!storage) return;
  try {
    storage.removeItem(unsavedKey(appId));
  } catch {
    // See `storeUnsavedWork`.
  }
}

// Whether this browser has edited a document it made without an account. New
// and Upload ask before replacing one, so the marker outlives a reload; it
// carries the document's expiry so an entry past it is dropped on read.
const EDITED_KEY_PREFIX = 'brass:trial-edited:';

export function markTrialEdited(token: string, expiresAt: Date): void {
  const storage = unsavedStorage();
  if (!storage) return;
  try {
    storage.setItem(`${EDITED_KEY_PREFIX}${token}`, expiresAt.toISOString());
  } catch {
    // See `storeUnsavedWork`.
  }
}

export function trialWasEdited(token: string, now: number = Date.now()): boolean {
  const storage = unsavedStorage();
  if (!storage) return false;
  let raw: string | null;
  try {
    raw = storage.getItem(`${EDITED_KEY_PREFIX}${token}`);
  } catch {
    return false;
  }
  if (raw === null) return false;
  const expiresAt = Date.parse(raw);
  if (Number.isNaN(expiresAt) || expiresAt <= now) {
    try {
      storage.removeItem(`${EDITED_KEY_PREFIX}${token}`);
    } catch {
      // See `storeUnsavedWork`.
    }
    return false;
  }
  return true;
}

// The claim secret the mint handed this browser, one per document, keyed by
// the app and the document's link token. Only the browser that made the
// document has one, so a sign-in here keeps the document and a sign-in
// wherever its link was shared does not. Written at the mint alone, so opening
// a shared link leaves it alone. Every mint prunes the secrets whose document
// has expired, since nothing else removes the secret of a document nobody
// came back to.
const CLAIM_KEY_PREFIX = 'brass:claim:';

function claimKey(appId: string, token: string): string {
  return `${CLAIM_KEY_PREFIX}${appId}:${token}`;
}

// Collected before any removal, since removing a key renumbers the rest.
function claimKeys(storage: Storage, prefix: string): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    // See `storeUnsavedWork`.
  }
  return keys;
}

function readClaimEntry(
  storage: Storage,
  key: string,
  now: number,
): string | null {
  let entry: { secret?: unknown; expires_at?: unknown } | null;
  try {
    entry = JSON.parse(storage.getItem(key) ?? 'null') as typeof entry;
  } catch {
    entry = null;
  }
  const expiresAt =
    typeof entry?.expires_at === 'string' ? Date.parse(entry.expires_at) : NaN;
  if (typeof entry?.secret !== 'string' || Number.isNaN(expiresAt) || expiresAt <= now) {
    try {
      storage.removeItem(key);
    } catch {
      // See `storeUnsavedWork`.
    }
    return null;
  }
  return entry.secret;
}

function pruneClaimSecrets(storage: Storage, now: number): void {
  for (const key of claimKeys(storage, CLAIM_KEY_PREFIX)) readClaimEntry(storage, key, now);
}

export function storeClaimSecret(
  appId: string,
  token: string,
  secret: string,
  expiresAt: Date,
  now: number = Date.now(),
): void {
  const storage = unsavedStorage();
  if (!storage) return;
  pruneClaimSecrets(storage, now);
  try {
    storage.setItem(
      claimKey(appId, token),
      JSON.stringify({ secret, expires_at: expiresAt.toISOString() }),
    );
  } catch {
    // See `storeUnsavedWork`.
  }
}

export function readClaimSecret(
  appId: string,
  token: string,
  now: number = Date.now(),
): string | null {
  const storage = unsavedStorage();
  if (!storage) return null;
  return readClaimEntry(storage, claimKey(appId, token), now);
}

// One document's secret, or with no token every secret this browser holds
// for the app.
export function clearClaimSecret(appId: string, token?: string): void {
  const storage = unsavedStorage();
  if (!storage) return;
  const keys =
    token === undefined
      ? claimKeys(storage, `${CLAIM_KEY_PREFIX}${appId}:`)
      : [claimKey(appId, token)];
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // See `storeUnsavedWork`.
    }
  }
}

// That this tab started a sign-in from a guest page, and on which token. Per
// tab (sessionStorage), written by `signIn()` and taken once on the return,
// so a URL carrying `brass_code` that this tab did not ask for claims nothing.
const SIGN_IN_INTENT_PREFIX = 'brass:claim-intent:';

function tabStorage(): Storage | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

export function markClaimIntent(appId: string, token: string): void {
  try {
    tabStorage()?.setItem(`${SIGN_IN_INTENT_PREFIX}${appId}`, token);
  } catch {
    // See `storeUnsavedWork`.
  }
}

export function takeClaimIntent(appId: string): string | null {
  const storage = tabStorage();
  if (!storage) return null;
  try {
    const token = storage.getItem(`${SIGN_IN_INTENT_PREFIX}${appId}`);
    storage.removeItem(`${SIGN_IN_INTENT_PREFIX}${appId}`);
    return token;
  } catch {
    return null;
  }
}

// The documents this browser claimed, per app, by the mint link each claim
// revoked. Reading that link again answers 410 for everyone, and a page that
// holds no session cannot ask the platform where it leads, so this is how a
// signed-out page on it knows to offer sign-in to the document instead. It
// confers no access (the open after sign-in is checked like any other), so a
// sign-out keeps it. Entries lapse after `CLAIMED_LINK_TTL_MS`.
const CLAIMED_KEY_PREFIX = 'brass:claimed:';
const CLAIMED_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function claimedKey(appId: string, token: string): string {
  return `${CLAIMED_KEY_PREFIX}${appId}:${token}`;
}

function readClaimedEntry(storage: Storage, key: string, now: number): string | null {
  let entry: { doc_id?: unknown; claimed_at?: unknown } | null;
  try {
    entry = JSON.parse(storage.getItem(key) ?? 'null') as typeof entry;
  } catch {
    entry = null;
  }
  const claimedAt = typeof entry?.claimed_at === 'number' ? entry.claimed_at : NaN;
  if (
    typeof entry?.doc_id !== 'string' ||
    Number.isNaN(claimedAt) ||
    claimedAt + CLAIMED_LINK_TTL_MS <= now
  ) {
    try {
      storage.removeItem(key);
    } catch {
      // See `storeUnsavedWork`.
    }
    return null;
  }
  return entry.doc_id;
}

export function storeClaimedLink(
  appId: string,
  token: string,
  docId: string,
  now: number = Date.now(),
): void {
  const storage = unsavedStorage();
  if (!storage) return;
  for (const key of claimKeys(storage, CLAIMED_KEY_PREFIX)) readClaimedEntry(storage, key, now);
  try {
    storage.setItem(claimedKey(appId, token), JSON.stringify({ doc_id: docId, claimed_at: now }));
  } catch {
    // See `storeUnsavedWork`.
  }
}

export function readClaimedLink(
  appId: string,
  token: string,
  now: number = Date.now(),
): string | null {
  const storage = unsavedStorage();
  if (!storage) return null;
  return readClaimedEntry(storage, claimedKey(appId, token), now);
}
