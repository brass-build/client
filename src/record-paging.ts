// The record-store paging codec: how a large record-graph document packs its
// `instances` map into page containers, and how to undo that back to a flat
// `key -> { type, params }` lookup.
//
// It lives here because the published `@brass-build/client` ships unbundled
// and can only import published packages and its own relative files. The
// platform's own record-store writer imports these helpers back from here, so
// the codec is defined ONCE and the SDK's paged read / edit cannot drift from
// how the store is written. Deliberately loro-free (fflate, JSON), so it stays
// a pure value codec on both sides.
//
// Wire recap: the root
// `instances` LoroMap is EITHER unpaged (key -> `{ type, params }`, params a
// plain value) or, above `UNPAGED_MAX_RECORDS` records, PAGED: keyed
// `brass:p:<peer>:<n>` -> a
// `{ type: '__page__', params: <string>, keys: <string> }` container. `params`
// is a gzipped latin1 string of a JSON array of `[tag, body]` pairs and `keys`
// the same encoding of the record keys those pairs belong to, in the same
// order. A `meta` key per root (`paged:<root>`) marks that root paged;
// `instance_order` lists record keys in order in both shapes. A page is filled
// in creation order, so a reader locates a record through the index it builds
// from the pages' `keys` fields.
//
// Every entry the store writes for its own bookkeeping (a page, a record's own
// container, a delete marker, a patch) lives under `RESERVED_KEY_PREFIX`, and
// the map handle refuses an app key inside it. That is what keeps the two key
// spaces apart: a record and the bookkeeping for a record share one map, so a
// reader deciding which is which by anything but the key would be deciding it
// from data an app controls.

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

/** Prefix on the `meta` key marking ONE root map paged (`meta` holds
 *  `paged:instances` -> `true`). A root whose key is absent, or holds anything
 *  but `true`, is unpaged; a document with no paged root carries no such key.
 *
 *  Per root rather than one flag for the document, so paging is a property of
 *  a collection rather than of a reserved name. One flag would force the read
 *  side to hardcode WHICH root it described, since a document-wide answer
 *  handed to every root would make `meta` and `header` read as paged the
 *  moment the records did. Keyed by root, a root with no key is simply
 *  unpaged, which is the answer those roots want anyway.
 *
 *  A key per root rather than one entry naming them all. A map entry is
 *  written whole, so an entry holding every paged root is read-modify-write:
 *  two peers crossing the threshold on two different roots at once each write
 *  the whole entry, the two resolve last-writer-wins, and the root the losing
 *  write named is left unmarked. Nothing recovers it. Every reader then takes
 *  the unpaged path over a map holding nothing but pages, so the store's own
 *  bookkeeping keys read back as the records and the records reach nobody,
 *  while the raw entry count sits far below the threshold that would page the
 *  root again. A key per root means two roots are two keys, which merge.
 *
 *  A flag rather than a page count. Pages are keyed by writing session and
 *  index (`brass:p:<peer>:<n>`) and a reader locates a record through the index
 *  it builds from the pages' `keys` fields, so no reader needs to know how many
 *  pages there are; a stored count would be a number that drifts as the store
 *  grows and that nothing checks.
 *
 *  A plain value rather than a container: it is read on the hot path
 *  (`_isPaged` on every keyed read and edit), where one `get` of a scalar is
 *  the cheapest answer available. */
export const PAGED_ROOT_PREFIX = 'paged:';

/** The `meta` key marking `rootKey` paged. */
export function pagedRootKey(rootKey: string): string {
  return `${PAGED_ROOT_PREFIX}${rootKey}`;
}

/** Whether a value read from `meta` at `pagedRootKey(root)` marks that root
 *  paged. The one place the marker's stored form is interpreted, so the SDK's
 *  handle path and the store readers cannot disagree about what marks a root. */
export function isPagedMarker(marker: unknown): boolean {
  return marker === true;
}

/** Above this many records the store is written paged; at or below it it keeps
 *  the one-container-per-record shape.
 *
 *  Set where paging starts paying for itself on every axis but one. Measured
 *  on the two shapes at equal record counts (`scripts/bench/paging-threshold.mts`),
 *  the paged store writes ~3x faster, opens ~5x faster, and stores ~1.7x
 *  smaller here, against ~1.4x on a single edit, and that last penalty
 *  inverts by 25,000 records. Below a few hundred records the paged store is
 *  actually LARGER, since per-page gzip overhead outweighs what it saves. */
export const UNPAGED_MAX_RECORDS = 5_000;

// A page is capped by BOTH a record count and a byte budget, and takes
// whichever is smaller. The count alone made a page's size whatever that
// format's records happen to weigh, and since every keyed read gunzips and
// parses a whole page to answer for one record, a wide-record store paid for
// that width on each read. The byte budget can only ever reduce records per
// page: raising it for narrow records would pack thousands of vertices into
// one page and make their reads worse. What it costs is page count, and so
// container count and compression ratio.
//
// Write-side constants: a reader locates a record through the index it builds
// from the pages' key lists, so moving these changes how the next write packs
// and nothing about how an already-stored document reads.
const TARGET_PAGE_SIZE = 64;
const TARGET_PAGE_BYTES = 64 * 1024;

/** The tag a page container carries in place of a record tag, which labels it
 *  in a raw dump of the stored document. A READER never decides from it: what
 *  makes an entry a page is its key (`SESSION_PAGE_PREFIX`), so a record whose
 *  own tag happens to be this string is still a record. */
export const PAGE_TAG = '__page__';

/** Prefix on every key the record store writes for its own bookkeeping: the
 *  pages, a record's own container, a delete marker, a patch.
 *
 *  A record and the bookkeeping about it share one map, so the two key spaces
 *  have to be told apart by something an app cannot produce. The map handle
 *  refuses a write under this prefix (`assertUsableRecordKey`), which makes the
 *  space exclusive: every key outside it is a record key, and every key inside
 *  it is the store's own. Nothing here inspects an app's VALUE to make that
 *  call, so no record can be mistaken for a page or a tombstone whatever it
 *  holds. */
export const RESERVED_KEY_PREFIX = 'brass:';

/** Whether `key` names one of the store's own entries rather than a record. */
export function isReservedKey(key: string): boolean {
  return key.startsWith(RESERVED_KEY_PREFIX);
}

/** The one key a reader cannot carry as an ordinary object property.
 *
 *  Every reader of a record store collects records into a JS object keyed by
 *  record key, and assigning `__proto__` on one sets its PROTOTYPE instead of
 *  adding an entry: the record disappears from `read()` and `keys()`, and the
 *  object handed to the app inherits from a value whoever wrote the store
 *  chose. Reading it back safely would mean an own-property assign on every
 *  key of every read, on the hot path, and would still leave the two shapes
 *  disagreeing, since an unpaged read comes straight out of loro's own
 *  `toJSON`. Refusing the key once, at the write, is what makes every reader
 *  correct without spending anything. */
const UNCARRIABLE_RECORD_KEY = '__proto__';

/** Refuse a record key the store cannot carry, at the moment an app writes it:
 *  one inside the reserved space, and `__proto__`.
 *
 *  Rejecting the reserved space is what lets every reader decide what an entry
 *  is from the key alone. The alternative, escaping, would put the escape on
 *  the read of every key of every map, paged or not, and a store that pages
 *  later cannot escape what it already holds. */
export function assertUsableRecordKey(key: string): void {
  if (key === UNCARRIABLE_RECORD_KEY) {
    throw new Error(
      `Key "${key}" is reserved: a record key cannot be ` +
        `"${UNCARRIABLE_RECORD_KEY}", which names an object's prototype ` +
        `rather than one of its entries.`,
    );
  }
  if (!isReservedKey(key)) return;
  throw new Error(
    `Key "${key}" is reserved: a record key cannot start with ` +
      `"${RESERVED_KEY_PREFIX}", which names the record store's own pages ` +
      `and edit bookkeeping.`,
  );
}

/** The prefix on a record written as its OWN container in a paged store,
 *  which shadows the page's copy on read. A page body is one value, so an
 *  edit that rewrote its page would make the page the merge unit; a record in
 *  its own container merges on its own. */
export const OVERLAY_PREFIX = `${RESERVED_KEY_PREFIX}r:`;

/** The prefix on the marker standing for a record DELETED out of a paged
 *  store. A page cannot be rewritten to drop the record, so the delete is
 *  stated as an entry of its own and every read drops the key.
 *
 *  A key of its own rather than a tag on the record's container: a tag is a
 *  field of the value, and the value is the app's record, so a record that
 *  happened to carry that tag would read as its own deletion. The marker
 *  carries no information beyond existing, so it is a plain `true` rather than
 *  a container. */
const TOMBSTONE_PREFIX = `${RESERVED_KEY_PREFIX}x:`;

/** Pack one stored value into a page triple. A `null` tag is what says the
 *  body IS the record: an app's map holds whatever the app assigned, which has
 *  no tag to split off. A typed record arrives already split, and its tag is a
 *  string, so the two forms cannot be confused whatever the tag says. */
export function packWholeValue<B>(key: string, value: B): PackedRecord<B> {
  return [key, null, value];
}

/** Re-pack `value` in the same triple shape `packed` already uses, so a page
 *  rewritten in place keeps the form its readers expect: a typed record stays
 *  a tag beside a body, and an app's stays one whole value. A streaming
 *  read visits a page's triples without unpacking them, so a rewrite that
 *  changed the shape would hand it the wrong half of the record. */
export function repackRecord(
  packed: PackedRecord<unknown>,
  value: unknown,
): PackedRecord<unknown> {
  if (packed[1] === null) return packWholeValue(packed[0], value);
  const record = (value ?? {}) as Record<string, unknown>;
  const tag = record[TAG_FIELD];
  return [
    packed[0],
    typeof tag === 'string' ? tag : packed[1],
    record[BODY_FIELD],
  ];
}

/** The stored value a page triple carries: the value itself for a whole-value
 *  record, else the `{ type, params }` pair a typed one was split into. */
export function unpackRecord(packed: PackedRecord<unknown>): unknown {
  if (packed[1] === null) return packed[2];
  return { [TAG_FIELD]: packed[1], [BODY_FIELD]: packed[2] };
}

/** The tag + body a page triple names, for a reader that walks the two
 *  separately, or null when the triple packs a whole value that is not a
 *  record.
 *
 *  A page holds both forms: a typed record is packed as the tag and body it
 *  was already split into, and a map an app writes packs whatever the app
 *  assigned as one whole value. Both forms occur in ONE store, because an
 *  app's bulk add to a store of typed records seals its own pages, so a reader
 *  that took `packed[1]` for the tag would report every record those pages
 *  hold as having no type at all. */
export function unpackRecordPair(
  packed: PackedRecord<unknown>,
): { tag: string; body: unknown } | null {
  if (packed[1] !== null) return { tag: packed[1], body: packed[2] };
  return decodeRecordValue(packed[2]);
}

/** The container key a record is written under, beside the pages. */
export function overlayKeyFor(recordKey: string): string {
  return `${OVERLAY_PREFIX}${recordKey}`;
}

/** The marker key standing for a record deleted out of a paged store. */
export function tombstoneKeyFor(recordKey: string): string {
  return `${TOMBSTONE_PREFIX}${recordKey}`;
}

/** The prefix on a page written by ONE editing session, which fills its pages
 *  in creation order.
 *
 *  An app fills a map by appending, so a rule that scattered one mutation's
 *  records across every page would add a record or two to each of thousands of
 *  pages and rewrite every one of them again on the next mutation, which costs
 *  more than the per-record containers it replaces. Filling in creation order
 *  packs each mutation's records into its own dense pages, written complete
 *  and never rewritten.
 *
 *  The token makes the key space exclusive to one writer. A page body is a
 *  single value, so two writers appending to the same page container resolve
 *  last-writer-wins and one writer's records are lost; with a per-session
 *  token no two writers ever address the same page. It is also what makes
 *  filling in creation order safe on reopen: a session never inherits, and so
 *  never rewrites, a page an earlier session sealed. */
export const SESSION_PAGE_PREFIX = `${RESERVED_KEY_PREFIX}p:`;

/** The container key for page `index` of the session identified by `token`. */
export function sessionPageKey(token: string, index: number): string {
  return `${SESSION_PAGE_PREFIX}${token}:${index}`;
}

/** The `{ token, index }` a session page key names, or null for any other key.
 *  Used to seed a session's next page index above what the store already
 *  holds, so a reopened session cannot overwrite its own sealed pages. */
export function parseSessionPageKey(
  key: string,
): { token: string; index: number } | null {
  if (!key.startsWith(SESSION_PAGE_PREFIX)) return null;
  const rest = key.slice(SESSION_PAGE_PREFIX.length);
  const split = rest.lastIndexOf(':');
  if (split <= 0) return null;
  const index = Number(rest.slice(split + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { token: rest.slice(0, split), index };
}

/** A record packed inside a page: `[key, tag, body]`, where a `null` tag means
 *  the body is the record's WHOLE stored value (`packWholeValue`). The tuple
 *  form keeps a paged snapshot compact. It is how a reader HOLDS a page's
 *  records; a stored page splits the key off into its own field
 *  (`PAGE_KEYS_FIELD`). */
export type PackedRecord<B> = [key: string, tag: string | null, body: B];

/** Field on a page container holding the keys of the records its body packs,
 *  in the same order, so the two are zipped by index.
 *
 *  The keys live apart from the bodies because finding a record in a page
 *  filled in creation order (`SESSION_PAGE_PREFIX`) means learning which page
 *  holds which key, and that question is answered by the keys alone. Packed
 *  beside the bodies, answering it costs decompressing and parsing every
 *  record in the store: measured at 250,000 records, 1.85 s against 0.24 s for
 *  the keys on their own. Splitting them costs no bytes, since the keys are
 *  stored once either way and compress better grouped than interleaved with
 *  the bodies. */
export const PAGE_KEYS_FIELD = 'keys';

/** A page's two stored strings: the record bodies and the keys they belong
 *  to. */
export interface EncodedPage {
  body: string;
  keys: string;
  /** The body's size BEFORE gzip, so a writer can charge a page in the same
   *  unit an ordinary map assignment is charged in. Taken here because the
   *  uncompressed string is built here and nothing else holds it. */
  chars: number;
}

/** Encode a page's records as the two strings it stores. Each is JSON,
 *  gzipped, held as a latin1 string. A STRING avoids loro's superlinear
 *  per-value conversion of a nested array; gzipping keeps a heavy file in
 *  memory + export budget. (Full rationale in the substrate's page notes.) */
export function encodePage<B>(records: PackedRecord<B>[]): EncodedPage {
  return encodePageFromEncoded(
    records.map((r) => encodeRecordForPage(r[1], r[2])),
    records.map((r) => r[0]),
  );
}

/** Encode one record's `[tag, body]` pair as the JSON string it occupies
 *  inside a page body. Split from page assembly so a large write can
 *  stringify each record as it buckets and release the parsed body before the
 *  gzip loop: holding a whole parsed model live through that loop makes GC
 *  marking scale with the live set and turns the encode into a wall. */
export function encodeRecordForPage<B>(tag: string | null, body: B): string {
  return JSON.stringify([tag, body]);
}

/** Assemble a page from bodies already JSON-encoded by `encodeRecordForPage`
 *  and the keys they belong to. Byte-identical to `encodePage` over the same
 *  records; the split exists only so the writer frees each parsed body
 *  first. */
export function encodePageFromEncoded(
  encoded: string[],
  keys: string[],
): EncodedPage {
  const body = '[' + encoded.join(',') + ']';
  return {
    body: gzipJson(body),
    keys: gzipJson(JSON.stringify(keys)),
    chars: body.length,
  };
}

function gzipJson(json: string): string {
  return strFromU8(gzip(strToU8(json)), true);
}

/** Parse one of a page's stored strings. Returns null for anything that does
 *  not decompress to a JSON array, so a reader tolerates a corrupt or stray
 *  page rather than throwing. */
function decodePageField(value: unknown): unknown[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(strFromU8(gunzip(strToU8(value, true))));
    return Array.isArray(parsed) ? (parsed as unknown[]) : null;
  } catch {
    return null;
  }
}

/** The record keys a page holds, from the page's own `keys` string. Reading
 *  this field alone is what makes learning a store's key locations cost the
 *  keys rather than every record body. */
export function decodePageKeys(keysField: unknown): string[] {
  const parsed = decodePageField(keysField);
  if (parsed === null) return [];
  return parsed.filter((k): k is string => typeof k === 'string');
}

/** A page's records, zipped back into `[key, tag, body]` triples from the two
 *  strings the page stores. A key with no body (or a body with no key) is
 *  dropped: the two arrays are written together and index each other, so a
 *  length mismatch means a page nothing can read as records. */
export function decodePageRecords(page: unknown): PackedRecord<unknown>[] {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return [];
  const fields = page as Record<string, unknown>;
  const keys = decodePageKeys(fields[PAGE_KEYS_FIELD]);
  if (keys.length === 0) return [];
  const pairs = decodePageField(fields[BODY_FIELD]);
  if (pairs === null) return [];
  const out: PackedRecord<unknown>[] = [];
  for (let i = 0; i < keys.length && i < pairs.length; i += 1) {
    const pair = pairs[i];
    if (!Array.isArray(pair)) continue;
    if (typeof pair[0] !== 'string' && pair[0] !== null) continue;
    out.push([keys[i]!, pair[0], pair[1]]);
  }
  return out;
}

// How many bodies to weigh when estimating a population's record width. A
// stride across the whole population rather than a prefix: a population is
// routinely ordered so that its wide records cluster (an import arrives
// grouped by entity type, an app's map fills in creation order), and a prefix
// sample then sizes every page from whatever happens to sit at the front.
const WIDTH_SAMPLE = 256;

/** Mean JSON bytes of a record body, over a stride sample of at most
 *  `WIDTH_SAMPLE` records, which is what `recordsPerPage` sizes a page
 *  against. `bodyOf` returns the value the caller will pack as the triple's
 *  body: a typed record carries a tag beside a body, and an app's map packs
 *  its whole stored value (`packWholeValue`), so each caller weighs the bytes
 *  its own pages will hold.
 *
 *  Returns 0, which keeps `recordsPerPage`'s plain record-count rule, for an
 *  empty population and for a body `JSON.stringify` refuses. Such a body fails
 *  the write regardless (a paged write stringifies each record, and loro
 *  rejects a non-JSON value), so the catch is not there to rescue it; it is
 *  there so that a page-size ESTIMATE is never what decides a write fails, and
 *  the failure stays with the code that owns the body. */
export function sampleBodyBytes<T>(
  records: readonly T[],
  bodyOf: (record: T) => unknown,
): number {
  if (records.length === 0) return 0;
  const stride = Math.max(1, Math.floor(records.length / WIDTH_SAMPLE));
  let total = 0;
  let seen = 0;
  try {
    for (let i = 0; i < records.length && seen < WIDTH_SAMPLE; i += stride) {
      total += JSON.stringify(bodyOf(records[i]!) ?? null).length;
      seen += 1;
    }
  } catch {
    return 0;
  }
  return seen === 0 ? 0 : total / seen;
}

/** Records one page holds: `TARGET_PAGE_SIZE`, or fewer when that many bodies
 *  would exceed `TARGET_PAGE_BYTES`. `avgBodyBytes` of 0 or absent (a caller
 *  with no estimate) keeps the count rule. */
export function recordsPerPage(avgBodyBytes?: number): number {
  if (!avgBodyBytes || !Number.isFinite(avgBodyBytes) || avgBodyBytes <= 0) {
    return TARGET_PAGE_SIZE;
  }
  const byBytes = Math.floor(TARGET_PAGE_BYTES / avgBodyBytes);
  return Math.max(1, Math.min(TARGET_PAGE_SIZE, byBytes));
}

/** How many pages a record population occupies: 0 (unpaged) at or below
 *  `UNPAGED_MAX_RECORDS`, else one page per `recordsPerPage(avgBodyBytes)`
 *  records.
 *
 *  A projection, not a decision the write path takes. Pages are filled in
 *  creation order and allocated as a write needs them, so this is what
 *  `scripts/bench` uses to price container counts and what the hash-page
 *  fixtures use as their bucket modulus. */
export function pageCountFor(
  recordCount: number,
  avgBodyBytes?: number,
): number {
  if (recordCount <= UNPAGED_MAX_RECORDS) return 0;
  return Math.ceil(recordCount / recordsPerPage(avgBodyBytes));
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

/** Prefix of a RECORD PATCH: the fields one edit changed, applied over the
 *  record's page copy on read.
 *
 *  Giving an edited record a container of its own instead restores the
 *  per-container cost paging exists to remove, so a store whose records are
 *  all eventually edited ends up slower and larger than one that never paged.
 *  A patch keeps the record packed and costs one entry per edit rather than a
 *  container per edited record.
 *
 *  The key carries the writing peer and a counter. The peer is what lets the
 *  patches be FOLDED back into their pages later without a lock: a CRDT delete
 *  only defeats a CONCURRENT write to the same key, and no two writers can
 *  name the same key while the peer is in it, so a peer editing during
 *  another's fold writes a key that fold never saw. A writer that re-mints a
 *  key it folded away itself is ordered after its own delete, so that write is
 *  not the race either.
 *
 *  The counter orders the patches on ONE record, and is minted one above every
 *  counter that record already carries. That is what makes the fold causal: a
 *  patch written by someone who had already merged an earlier patch sorts
 *  above it, whoever wrote which. A counter that instead counted the WRITER's
 *  edits would put a busy session's first-ever edit of a record above a later
 *  session's, and the later edit would vanish as it was made.
 *
 *  The record key goes last because it may contain a colon; the peer and
 *  counter may not.
 *
 *  Each reserved space differs from its siblings at the character after
 *  `RESERVED_KEY_PREFIX`, so `classifyStoreKey` decides between them with one
 *  test each and no ordering to get right. */
export const PATCH_PREFIX = `${RESERVED_KEY_PREFIX}q:`;

/** Width the counter is padded to, so lexical key order is counter order. */
const PATCH_COUNTER_DIGITS = 12;

export function patchKeyFor(
  recordKey: string,
  peer: string,
  counter: number,
): string {
  const n = String(counter).padStart(PATCH_COUNTER_DIGITS, '0');
  return `${PATCH_PREFIX}${peer}:${n}:${recordKey}`;
}

export interface ParsedPatchKey {
  recordKey: string;
  peer: string;
  counter: string;
}

/** What one entry of a paged map is, decided from its key alone.
 *
 *  `record` is the ordinary case: every key outside the reserved space names a
 *  record, whatever its value holds. `unknown` is a reserved key this build
 *  does not recognise, which a reader skips rather than reporting as a record,
 *  so a store written by a later build degrades to missing entries instead of
 *  entries named after the store's own bookkeeping. */
export type StoreEntryKind =
  | { kind: 'record'; recordKey: string }
  | { kind: 'page' }
  | { kind: 'overlay'; recordKey: string }
  | { kind: 'tombstone'; recordKey: string }
  | { kind: 'patch'; parsed: ParsedPatchKey }
  | { kind: 'unknown' };

/** Classify one key of a paged map. The single place the key spaces are told
 *  apart, so a keyed read, a whole-store read, a streaming read, and the page
 *  index cannot disagree about which entry is which. */
export function classifyStoreKey(key: string): StoreEntryKind {
  if (!isReservedKey(key)) return { kind: 'record', recordKey: key };
  if (key.startsWith(OVERLAY_PREFIX)) {
    return { kind: 'overlay', recordKey: key.slice(OVERLAY_PREFIX.length) };
  }
  if (key.startsWith(TOMBSTONE_PREFIX)) {
    return { kind: 'tombstone', recordKey: key.slice(TOMBSTONE_PREFIX.length) };
  }
  if (key.startsWith(SESSION_PAGE_PREFIX)) return { kind: 'page' };
  const parsed = parsePatchKey(key);
  return parsed === null ? { kind: 'unknown' } : { kind: 'patch', parsed };
}

/** The parts of a patch key, or null when `key` is not one.
 *
 *  The record key runs to the end of the string and may be empty, which is a
 *  record key like any other: the two colons after the prefix delimit the peer
 *  and the counter, so the tail needs no length of its own to be
 *  unambiguous. Reading an empty tail as "not a patch" instead leaves the
 *  entry classified `unknown`, which every reader skips, so the edit stays in
 *  the document and reaches nobody. */
export function parsePatchKey(key: string): ParsedPatchKey | null {
  if (!key.startsWith(PATCH_PREFIX)) return null;
  const peerEnd = key.indexOf(':', PATCH_PREFIX.length);
  if (peerEnd === -1) return null;
  const counterEnd = key.indexOf(':', peerEnd + 1);
  if (counterEnd === -1) return null;
  const recordKey = key.slice(counterEnd + 1);
  return {
    recordKey,
    peer: key.slice(PATCH_PREFIX.length, peerEnd),
    counter: key.slice(peerEnd + 1, counterEnd),
  };
}

/** One patch: the fields an edit changed, plus the pair that orders it. */
export interface RecordPatch {
  peer: string;
  counter: string;
  fields: unknown;
}

/** Apply `patches` over `base`, in the order every reader must agree on: by
 *  counter, then by peer id. The counter is per record and minted one above
 *  what that record already carries, so a patch whose writer had merged an
 *  earlier one applies over it. Peer id breaks the tie between two writers who
 *  had not seen each other, so both reach the same answer. */
export function applyRecordPatches(
  base: unknown,
  patches: RecordPatch[],
): unknown {
  if (patches.length === 0) return base;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return base;
  const ordered =
    patches.length === 1
      ? patches
      : [...patches].sort((a, b) =>
          a.counter === b.counter
            ? a.peer.localeCompare(b.peer)
            : a.counter.localeCompare(b.counter),
        );
  let out = base as Record<string, unknown>;
  for (const { fields: patch } of ordered) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
    out = { ...out, ...(patch as Record<string, unknown>) };
  }
  return out;
}

/**
 * Apply patches to a record a streaming read carries both as its whole stored
 * value and as the `(tag, body)` pair split out of it, and return all three
 * after the fold.
 *
 * A patch names the record's own fields, which for a typed record are
 * `type` and `params` together, so a reader that walks tag and body
 * separately has to re-split the result. Both readers of a paged store
 * (the flattening one and the streaming one) resolve patches through this
 * module, so an edit cannot read one way in the editor and another in a
 * re-emitted file. The fold runs over the whole value for the same reason the
 * streaming read carries one: a field beyond the pair is a field of the record
 * and an edit may name it.
 */
export function applyPatchesToRecord(
  record: unknown,
  tag: string,
  body: unknown,
  patches: RecordPatch[],
): { tag: string; body: unknown; record: unknown } {
  if (patches.length === 0) return { tag, body, record };
  const patched = applyRecordPatches(record, patches);
  if (!patched || typeof patched !== 'object' || Array.isArray(patched)) {
    return { tag, body, record: patched };
  }
  const fields = patched as Record<string, unknown>;
  const nextTag = fields[TAG_FIELD];
  return {
    tag: typeof nextTag === 'string' ? nextTag : tag,
    body: fields[BODY_FIELD],
    record: patched,
  };
}

/** Where a paged store keeps each record, reported as a flatten resolves it.
 *  A reader that has to locate records by key (a keyed read over pages filled
 *  in creation order) takes its index from the walk that decodes the pages
 *  anyway, rather than decoding them a second time of its own. */
export interface RecordLocationSink {
  /** `recordKey` is packed in the body of page `pageKey`. */
  page(recordKey: string, pageKey: string): void;
  /** A container of its own answers for `recordKey`, outranking any page. */
  contained(recordKey: string): void;
  /** A tombstone removes `recordKey`, whatever a page still holds. */
  removed(recordKey: string): void;
}

/** Flatten a possibly-PAGED `instances` lookup to the flat
 *  `key -> { type, params }` lookup a reader consumes. An unpaged lookup is
 *  returned unchanged (no allocation). The single place paging is undone on the
 *  read side.
 *
 *  `paged` is the AUTHORITATIVE page state, read from the root's own `meta`
 *  key by the caller (`pagedRootKey` / `isPagedMarker`). Page interpretation
 *  MUST be gated on it: in an UNPAGED store every key is a record key,
 *  including one that looks reserved, because nothing refused it before the
 *  store was written. */
export function flattenPagedLookup(
  lookup: Record<string, unknown>,
  paged: boolean,
  into?: RecordLocationSink,
): Record<string, unknown> {
  if (!paged) return lookup;

  const flat: Record<string, unknown> = {};
  // Anything written OUTSIDE a page is applied in a later pass, so a record
  // held in its own container always wins over a page's copy of it, whatever
  // order the map hands its keys back in. Resolving either in the page pass
  // would make the winner depend on that order, which is the store's business
  // and not a decision a reader should inherit.
  //
  // Two kinds, in increasing authority. A STRAY is a record under its own key
  // in a paged map: every record written before the map was paged, plus what a
  // client that did not know it was paged leaves behind. Either way it is the
  // newer copy, so it beats the page. An OVERLAY entry is an edit written
  // beside the pages, so it beats both.
  const stray: [string, unknown][] = [];
  const overlay: [string, unknown][] = [];
  // A delete a page still holds is stated as its own entry, so the removals
  // are applied after the whole-record passes.
  const removed: string[] = [];
  // A PATCH carries only the fields one edit changed, so it patches whatever
  // the whole-record passes resolved to rather than replacing it. That is what
  // keeps two peers changing different fields of one record from overwriting
  // each other, which a whole-record write cannot do.
  const patches = new Map<string, RecordPatch[]>();
  for (const [key, value] of Object.entries(lookup)) {
    const entry = classifyStoreKey(key);
    switch (entry.kind) {
      case 'record':
        stray.push([key, value]);
        break;
      case 'overlay':
        overlay.push([entry.recordKey, value]);
        break;
      case 'tombstone':
        removed.push(entry.recordKey);
        break;
      case 'patch': {
        const list = patches.get(entry.parsed.recordKey);
        const patch = {
          peer: entry.parsed.peer,
          counter: entry.parsed.counter,
          fields: value,
        };
        if (list) list.push(patch);
        else patches.set(entry.parsed.recordKey, [patch]);
        break;
      }
      case 'page':
        for (const packed of decodePageRecords(value)) {
          flat[packed[0]] = unpackRecord(packed);
          into?.page(packed[0], key);
        }
        break;
      case 'unknown':
        break;
    }
  }
  for (const [key, value] of stray) {
    flat[key] = value;
    into?.contained(key);
  }
  for (const [recordKey, value] of overlay) {
    flat[recordKey] = value;
    into?.contained(recordKey);
  }
  // A delete outranks every copy of the record, so a peer's concurrent edit of
  // a record another peer removed reads as removed for both of them.
  for (const recordKey of removed) {
    delete flat[recordKey];
    into?.removed(recordKey);
  }
  // Last, so a patch lands on the record whichever pass produced it. A patch
  // for a record no pass produced is dropped rather than resurrecting a
  // partial one: the record was deleted, and half of it is not a record.
  //
  // "No pass produced it" is an OWN-property question. A record key is any
  // string, so one naming a member of `Object.prototype` (`toString`,
  // `valueOf`) reads back as that member from an object nothing has assigned
  // it on, and a plain `=== undefined` test then takes the inherited function
  // for the record: a record two peers concurrently deleted and patched comes
  // back from the dead as a function, in a store no app wrote anything odd
  // into.
  for (const [recordKey, list] of patches) {
    if (!Object.prototype.hasOwnProperty.call(flat, recordKey)) continue;
    flat[recordKey] = applyRecordPatches(flat[recordKey], list);
  }
  return flat;
}
