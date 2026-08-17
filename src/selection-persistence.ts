// Per-app sessionStorage layer that stashes the last value returned by
// `Brass.selectDocument()`; the session's boot restore reads it back as
// the bare-URL fallback.
//
// Keys are namespaced per-app id so integrations on one origin don't
// collide. Cleared on sign-out (`clearAll`); session storage also drops on
// tab close.

import type { SelectDocumentResult } from './hosted-ui.js';

const KEY_PREFIX = '__brass_';
const DOC_KEY = `${KEY_PREFIX}last_doc_`;

// Single per-page-load warn: `storeLastDocument` runs on every successful pick,
// so without the latch a server-rendered host would flood its logs.
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
    'Brass: sessionStorage is unavailable; selection persistence is disabled.',
  );
}

function docKey(appId: string): string {
  return `${DOC_KEY}${appId}`;
}

function isSelectDocumentResult(value: unknown): value is SelectDocumentResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['doc_id'] === 'string' &&
    // `project_id: string | null` (loose docs have no project).
    (typeof v['project_id'] === 'string' || v['project_id'] === null) &&
    typeof v['organization_id'] === 'string' &&
    typeof v['role'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['created_at'] === 'string' &&
    typeof v['updated_at'] === 'string'
  );
}

export function storeLastDocument(
  appId: string,
  value: SelectDocumentResult,
): void {
  const storage = getStorage();
  if (!storage) {
    warnOnceUnavailable();
    return;
  }
  try {
    storage.setItem(docKey(appId), JSON.stringify(value));
  } catch {
    // Quota / disabled storage; drop silently so a recall-on-reload
    // niceness never breaks the launcher path that just succeeded.
  }
}

export function readLastDocument(
  appId: string,
): SelectDocumentResult | null {
  const storage = getStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(docKey(appId));
  } catch {
    // A storage that holds a handle but refuses reads (a partitioned or
    // locked-down context). Recalling the last document is a niceness, so it
    // degrades to none rather than throwing out of the caller, which would
    // replace the real reason a document could not be reopened.
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // A value written by an older SDK version may not match the current
  // shape; ignore it rather than hand the caller a half-typed object.
  if (!isSelectDocumentResult(parsed)) return null;
  return parsed;
}

export function clearAll(appId: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(docKey(appId));
  } catch {
    // See `storeLastDocument`.
  }
}
