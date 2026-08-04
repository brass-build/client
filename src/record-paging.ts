// The record-store paging codec: how a large record-graph document packs its
// `instances` map into page containers, and how to undo that back to a flat
// `key -> { type, params }` lookup.
//
// It lives in the SDK (not in `formats/core`, where the record store lives)
// because the published `@brass-build/client` ships unbundled and can only
// import published packages and its own relative files; `formats/core` is
// neither. The substrate imports these helpers back from here, so the codec is
// defined ONCE and the SDK's paged read / edit cannot drift from how the store
// is written. Deliberately loro-free (fflate, a stable hash, JSON), so it
// stays a pure value codec on both sides.
//
// Wire recap (full rationale in `formats/core/src/record-store.ts`): the root
// `instances` LoroMap is EITHER unpaged (key -> `{ type, params }`, params a
// plain value) or, above `UNPAGED_MAX_RECORDS` records, PAGED: keyed
// `p0,p1,...` -> a `{ type: '__page__', params: <string> }` container whose
// params is a gzipped latin1 string of a JSON array of `[key, tag, body]`
// triples. `meta.page_count` carries the count; `instance_order` lists record
// keys in order in both shapes. A record's page is a hash of its key, so it is
// resolved with no stored index.

import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';

// Gzip backend: native `node:zlib` when the runtime provides it, fflate
// otherwise. The page codec must stay a pure isomorphic value codec (the
// published SDK runs in browsers, where fflate is the only option), but
// fflate's JS inflate is several times slower than zlib's native one on a
// server-grade page walk, and a server's constrained cores amplify that. The
// module is reached through `process.getBuiltinModule` (Node 22+) via a
// structural `globalThis` read, so no `node:` import ever appears in the
// browser bundle and the SDK compiles without Node types. Both backends
// speak standard gzip, so pages written by one decode under the other.
interface GzipBackend {
  gzipSync(bytes: Uint8Array): Uint8Array;
  gunzipSync(bytes: Uint8Array): Uint8Array;
}

let nativeZlib: GzipBackend | null | undefined;

function zlibBackend(): GzipBackend | null {
  if (nativeZlib === undefined) {
    try {
      const proc = (
        globalThis as {
          process?: { getBuiltinModule?: (id: string) => unknown };
        }
      ).process;
      nativeZlib =
        (proc?.getBuiltinModule?.('node:zlib') as GzipBackend | undefined) ??
        null;
    } catch {
      nativeZlib = null;
    }
  }
  return nativeZlib;
}

function gzip(bytes: Uint8Array): Uint8Array {
  const zlib = zlibBackend();
  return zlib ? zlib.gzipSync(bytes) : gzipSync(bytes);
}

function gunzip(bytes: Uint8Array): Uint8Array {
  const zlib = zlibBackend();
  return zlib ? zlib.gunzipSync(bytes) : gunzipSync(bytes);
}

/** Field names inside a stored record container: `type` is the tag, `params`
 *  the body. Verbatim so the substrate and SDK name the same fields. */
export const TAG_FIELD = 'type';
export const BODY_FIELD = 'params';

/** Root container keys the record store occupies on a document. */
export const META_KEY = 'meta';
export const RECORDS_KEY = 'instances';
export const ORDER_KEY = 'instance_order';

/** `meta` key holding a paged store's page count; absent (or 0) means
 *  unpaged. The read path detects pages by tag; only an in-place edit needs
 *  the count, to hash a key to its page. */
export const PAGE_COUNT_KEY = 'page_count';

/** `meta` key holding the paging codec's scheme number, stamped on a paged
 *  write. The scheme fixes the page-key hash (`pageKeyFor`), the `p<n>` key
 *  format, and the packed-record layout together: a reader that hashes a key
 *  with a different scheme than the store was written under targets the wrong
 *  page on an in-place edit, silently writing a record into a page it does not
 *  belong to. The stamp lets a pinned reader detect a store written under a
 *  scheme it does not implement and refuse the edit instead of corrupting it.
 *  Absent means the current scheme (paged stores written before the stamp
 *  existed used scheme 1's hash and layout). */
export const PAGING_SCHEME_KEY = 'paging_scheme';

/** The paging scheme this build writes and can edit. Bump ONLY alongside a
 *  change to `pageKeyFor`'s hash, the `p<n>` key format, or the packed-record
 *  layout, so an older pinned reader trips `isPagingSchemeEditable` and fails
 *  loud rather than editing a store it would mis-hash. */
export const CURRENT_PAGING_SCHEME = 1;

/** Whether a store stamped with `scheme` can be edited in place by this build.
 *  Absent / non-numeric / `0` is a scheme-1 store (the stamp postdates it), so
 *  editable; any scheme at or below the current one is editable; a higher
 *  scheme is not (this reader would hash into the wrong page). Reads stay
 *  best-effort and are not gated here; only an in-place edit can persist the
 *  mis-hash, so the edit path is where the guard belongs. */
export function isPagingSchemeEditable(scheme: unknown): boolean {
  if (typeof scheme !== 'number' || !Number.isFinite(scheme) || scheme <= 0) {
    return true;
  }
  return scheme <= CURRENT_PAGING_SCHEME;
}

/** Above this many records the store is written paged; at or below it it keeps
 *  the one-container-per-record shape. */
export const UNPAGED_MAX_RECORDS = 50_000;

// Target records per page and a page-count ceiling so even the 2M-record cap
// stays out of the slow zone. Mirrored from the substrate's write path so
// `pageCountFor` agrees with how the store was written.
const TARGET_PAGE_SIZE = 64;
const MAX_PAGES = 50_000;

/** The tag a page container carries in place of a record tag, so a reader
 *  tells a page (body = record triples) from a single record (body = one
 *  plain value). */
export const PAGE_TAG = '__page__';

/** A record packed inside a page body: `[key, tag, body]`. The tuple form
 *  keeps a paged snapshot compact. */
export type PackedRecord<B> = [key: string, tag: string, body: B];

/** Encode a page's triples as its stored body: JSON-serialised, gzipped, held
 *  as a latin1 string. A STRING body avoids loro's superlinear per-value
 *  conversion of a deeply nested triple array; gzipping keeps a heavy file in
 *  memory + export budget. (Full rationale in the substrate's `encodePageBody`.) */
export function encodePageBody<B>(triples: PackedRecord<B>[]): string {
  return encodePageBodyFromEncoded(triples.map((t) => JSON.stringify(t)));
}

/** Encode one record's `[key, tag, body]` triple as the JSON string it
 *  occupies inside a page body. Split from page assembly so a large write can
 *  stringify each record as it buckets and release the parsed body before the
 *  gzip loop, rather than holding the whole parsed model live through it (see
 *  `writeRecordStoreConsuming` for why that release keeps the encode fast). */
export function encodeRecordForPage<B>(
  key: string,
  tag: string,
  body: B,
): string {
  return JSON.stringify([key, tag, body] as PackedRecord<B>);
}

/** Assemble a page body from records already JSON-encoded by
 *  `encodeRecordForPage`: wrap in a JSON array, gzip, hold as a latin1 string.
 *  Byte-identical to `encodePageBody` over the same triples, so the wire shape
 *  is unchanged; the split exists only so the writer frees each parsed body
 *  first. */
export function encodePageBodyFromEncoded(encoded: string[]): string {
  return strFromU8(gzip(strToU8('[' + encoded.join(',') + ']')), true);
}

/** Decode a page body back to its record triples. Returns [] for anything that
 *  does not decompress to a JSON array, so a reader tolerates a corrupt or
 *  stray page rather than throwing. */
export function decodePageBody(body: unknown): PackedRecord<unknown>[] {
  if (typeof body !== 'string') return [];
  try {
    const json = strFromU8(gunzip(strToU8(body, true)));
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as PackedRecord<unknown>[]) : [];
  } catch {
    return [];
  }
}

/** The page count for a record population: 0 (unpaged) at or below
 *  `UNPAGED_MAX_RECORDS`, else ~`TARGET_PAGE_SIZE` records per page, capped at
 *  `MAX_PAGES`. */
export function pageCountFor(recordCount: number): number {
  if (recordCount <= UNPAGED_MAX_RECORDS) return 0;
  return Math.min(Math.ceil(recordCount / TARGET_PAGE_SIZE), MAX_PAGES);
}

/** FNV-1a (32-bit) assigning a record key to a page. Stable and
 *  engine-independent: the same key resolves to the same page on write, read,
 *  and edit across processes, which is what lets the page be found with no
 *  stored index. */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The page key a record key lives in, for a store of `pageCount` pages. */
export function pageKeyFor(key: string, pageCount: number): string {
  return `p${hashKey(key) % pageCount}`;
}

/** A stored container's tag (`type`), or null for any value not in the
 *  `{ type, params }` shape, so a reader skips a corrupt entry. A page carries
 *  `PAGE_TAG`. */
export function peekRecordTag(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tag = (value as Record<string, unknown>)[TAG_FIELD];
  return typeof tag === 'string' ? tag : null;
}

/** Decode a stored container (`{ type, params }`) to its tag + raw body,
 *  or null when it is not in the record shape. */
export function decodeRecordValue(
  value: unknown,
): { tag: string; body: unknown } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const tag = o[TAG_FIELD];
  if (typeof tag !== 'string' || !(BODY_FIELD in o)) return null;
  return { tag, body: o[BODY_FIELD] };
}

/** Whether a `meta.page_count` value denotes a PAGED store. The writer sets
 *  it to a positive count only when it pages, and never on an unpaged write,
 *  so a positive finite number is the authoritative "is paged" signal. */
export function isPagedByPageCount(pageCount: unknown): boolean {
  return typeof pageCount === 'number' && Number.isFinite(pageCount) && pageCount > 0;
}

/** Flatten a possibly-PAGED `instances` lookup to the flat
 *  `key -> { type, params }` lookup a reader consumes. An unpaged lookup is
 *  returned unchanged (no allocation). The single place paging is undone on the
 *  read side.
 *
 *  `paged` is the AUTHORITATIVE page state, read from `meta.page_count` by the
 *  caller (`isPagedByPageCount`). Page interpretation MUST be gated on it, not
 *  on whether some entry is `PAGE_TAG`-tagged: a genuine record whose codec tag
 *  happens to equal `PAGE_TAG` in an UNPAGED store is a real record, not a
 *  page. Treating it as a page decodes its plain body as `decodePageBody`
 *  (which returns `[]` for a non-page body), silently DROPPING the record, and
 *  a crafted page-shaped body could forge records into the lookup. */
export function flattenPagedLookup(
  lookup: Record<string, unknown>,
  paged: boolean,
): Record<string, unknown> {
  if (!paged) return lookup;

  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(lookup)) {
    if (peekRecordTag(value) !== PAGE_TAG) {
      flat[key] = value; // tolerate a stray non-page entry by its own key
      continue;
    }
    const body = decodePageBody(decodeRecordValue(value)?.body);
    for (const packed of body) {
      if (
        Array.isArray(packed) &&
        packed.length >= 3 &&
        typeof packed[0] === 'string' &&
        typeof packed[1] === 'string'
      ) {
        flat[packed[0]] = {
          [TAG_FIELD]: packed[1],
          [BODY_FIELD]: packed[2],
        };
      }
    }
  }
  return flat;
}
