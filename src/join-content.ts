// The one path from a join's `snapshot` field to the content it carries.
//
// The open, the reload, a line's resync, a guest's pull and a version checkout
// all read the same envelope, and each is handed back a content source in the
// encoding the server stated. The SDK never infers the encoding from bytes the
// wire already named, and a kind this build does not read is an upgrade error
// rather than a guess: treating unreadable content as empty would let a reader
// edit over content that is there.

import { BrassError } from './errors.js';
import { fetchSealedBytes, forgetSealedBytes } from './sealed-cache.js';
import {
  type SealedContent,
  SealedStoreError,
  decodeSealedContent,
  frameVersion,
  loadSealedCodec,
  needsSealedCodec,
  NEWEST_VERSION,
} from './sealed-store.js';

/** What a join's snapshot field holds, decoded as far as the wire says. */
export type JoinContent =
  /** No snapshot: the branch's state is its tail alone. */
  | { kind: 'none' }
  /** CRDT snapshot bytes, for the engine to import. */
  | { kind: 'crdt'; bytes: Uint8Array }
  /** Frozen content, read with no CRDT engine. */
  | { kind: 'frozen'; content: SealedContent };

/** Fetches a signed URL's body. The open passes one that reports progress. */
export type ContentFetch = (url: string) => Promise<Uint8Array>;

/** The error a snapshot this build cannot read is reported as. */
function contentTooNewError(): BrassError {
  return new BrassError(
    'Opening this needs a newer version of this app. Update to the latest @brass-build/client to open it.',
    { status: 426 },
  );
}

/** The encoding a join's snapshot field states, read off the wire without
 *  fetching anything. Throws the 426 upgrade error for a kind this build does
 *  not read. */
export function joinEncoding(snapshot: unknown): JoinContent['kind'] {
  if (snapshot === null || snapshot === undefined) return 'none';
  if (typeof snapshot !== 'object') throw contentTooNewError();
  switch ((snapshot as { kind?: unknown }).kind) {
    case 'inline':
    case 'presigned':
      return 'crdt';
    case 'sealed':
      return 'frozen';
    default:
      throw contentTooNewError();
  }
}

/**
 * Decode a join's snapshot field.
 *
 * `inline` and `presigned` are CRDT snapshots; `sealed` is sealed content in
 * any frame this build reads. A frame newer than that, or a kind this build
 * does not know, throws the 426 upgrade error.
 */
export async function decodeJoinContent(
  snapshot: unknown,
  fetchBody: ContentFetch,
): Promise<JoinContent> {
  if (joinEncoding(snapshot) === 'none') return { kind: 'none' };
  const snap = snapshot as { kind?: unknown; data_b64?: unknown; url?: unknown };
  switch (snap.kind) {
    case 'inline':
      if (typeof snap.data_b64 !== 'string') throw malformed();
      return { kind: 'crdt', bytes: base64ToBytes(snap.data_b64) };
    case 'presigned':
      if (typeof snap.url !== 'string') throw malformed();
      return { kind: 'crdt', bytes: await fetchBody(snap.url) };
    default: {
      if (typeof snap.url !== 'string') throw malformed();
      const url = snap.url;
      const raw = (snapshot as { content_id?: unknown }).content_id;
      const contentId = typeof raw === 'string' && raw !== '' ? raw : undefined;
      const bytes = await fetchSealedBytes(contentId, url, fetchBody);
      if (needsSealedCodec(bytes)) await loadSealedCodec();
      try {
        return { kind: 'frozen', content: await decodeFrozen(bytes) };
      } catch (err) {
        // A kept copy that will not decode is dropped and fetched again, so a
        // damaged entry costs one download rather than the document.
        if (contentId === undefined || isUpgradeError(err)) throw err;
        await forgetSealedBytes(contentId);
        const fresh = await fetchSealedBytes(contentId, url, fetchBody);
        if (needsSealedCodec(fresh)) await loadSealedCodec();
        return { kind: 'frozen', content: await decodeFrozen(fresh) };
      }
    }
  }
}

/** Frozen bytes as content, with a frame newer than this build reported as
 *  the upgrade error rather than as corrupt content. */
async function decodeFrozen(bytes: Uint8Array): Promise<SealedContent> {
  const version = frameVersion(bytes);
  if (version !== null && version > NEWEST_VERSION) throw contentTooNewError();
  try {
    return await decodeSealedContent(bytes);
  } catch (err) {
    if (err instanceof SealedStoreError) {
      throw new BrassError('This document could not be read: its stored content is damaged.', {
        status: 500,
      });
    }
    throw err;
  }
}

function isUpgradeError(err: unknown): boolean {
  return err instanceof BrassError && err.status === 426;
}

function malformed(): BrassError {
  return new BrassError('Malformed document snapshot', { status: 500 });
}

// Uses `atob` (present in modern browsers, Node 20+, and jsdom) rather than
// Node-only `Buffer`, which would force a browser-bundle polyfill.
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}
