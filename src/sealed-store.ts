// The FROZEN form: a stream's content as plain bytes, with no CRDT engine on
// either side of it.
//
// Content is JSON in the shape the stream's schema describes: each top-level
// entry is a root, and a root is a map (an object whose entries are its
// records), a list (an array), or a text (a string). An ordered map is two
// roots, the map and the list of its keys. That is exactly what an importer
// returns and what `doc.map`, `doc.list`, `doc.orderedMap` and `doc.text` read
// back, so a stream nobody has edited is fully determined by it. A CRDT
// snapshot of the same content pays for per-container state, a version vector
// and an op history describing no edits, and every reader pays an engine to
// get the content back; this holds the content and nothing else.
//
// It lives beside `record-paging.ts` because the published `@brass-build/client`
// ships unbundled and can only import published packages and its own relative
// files, so the frame and the one decoder every reader uses are defined once,
// here. Deliberately loro-free.
//
// The stored frame (version 4, below) holds every map as typed Arrow tables
// and the stream as one ZSTD frame (`sealed-arrow.ts` reads the tables,
// `sealed-encode.ts` writes them). Version 5 is the same tables gzipped, the
// staging form a producer without ZSTD uploads. Content can also be held in
// memory with the same roots (`SealedContent.fromJSON`), so a reader never
// asks which it holds. A join serves the stored frame only to a caller whose
// `accept` names it (`SEALED_ACCEPT`).
//
// A list whose items are exactly a map's keys (an ordered map's order list) is
// not stored: the map is stored in the list's order and the list is read back
// as the map's keys in stored order.

import {
  HEADER_KEY,
  META_KEY,
  ORDER_KEY,
  RECORDS_KEY,
  SCHEMA_VERSION_KEY,
  recordValueOf,
  type PackedRecord,
} from './record-paging.js';
import { Gunzip } from 'fflate';
import type { ArrowData, ArrowReader, ReadContext, ReadyTable, TableMeta } from './sealed-arrow.js';

/**
 * The peer every conversion of frozen content into a CRDT authors as.
 *
 * Pinned, so one frozen stream produces one document: two sides that convert
 * the same content independently write the same ops, and their later edits
 * merge rather than doubling every record.
 *
 * A live editor never authors as this peer. It keeps the one its own document
 * was opened with, so every op it writes after a conversion is its own.
 */
export const CONVERSION_PEER_ID = '1' as const;

/** `BRST`. Four bytes so a reader handed the wrong object fails on its first
 *  word rather than on a length field it read out of a compressed run. */
const MAGIC = 0x42_52_53_54;
/** Named roots, every map as typed Arrow tables, the whole stream one ZSTD
 *  frame. What the platform stores; only its encoder writes it. */
export const VERSION_ARROW = 4;
/** Frame 4's body under gzip rather than ZSTD: what a producer without a ZSTD
 *  compressor (a browser) uploads. Staging only; the seal stores it as frame
 *  4, so no reader is ever handed it. */
export const VERSION_ARROW_STAGED = 5;
/** The newest frame this build reads. */
export const NEWEST_VERSION = VERSION_ARROW;

/** The join `accept` token naming the stored frames this build decodes. */
export const SEALED_ACCEPT = `sealed@${VERSION_ARROW}`;

// Magic (u32), version (u8), reserved (3 bytes, zero), then 8 reserved bytes
// before the compressed body.
const PROLOGUE_BYTES = 16;

/** One root of frozen content, as JSON: an object is a map, an array a list,
 *  a string a text. */
export type SealedRootValue =
  | Record<string, unknown>
  | readonly unknown[]
  | string;

/** A stream's content as JSON, one entry per root. */
export type SealedContentJson = Record<string, SealedRootValue>;

export type SealedRootKind = 'map' | 'list' | 'text';

/** The kind a JSON value would be stored as, or null for a value no root can
 *  hold. */
export function sealedRootKindOf(value: unknown): SealedRootKind | null {
  if (typeof value === 'string') return 'text';
  if (Array.isArray(value)) return 'list';
  if (value !== null && typeof value === 'object') return 'map';
  return null;
}

/** One header entry of a record store: the format's own preamble (an IFC
 *  `FILE_DESCRIPTION`, a DXF header variable), tagged the way a record is. */
export interface SealedHeaderEntry {
  tag: string;
  body: unknown;
}

/** What produced a stream's content: an importer's id and version. A reader
 *  answers from the content whoever produced it; this is for deciding which
 *  stored streams an importer fix should rebuild. */
export interface SealedStoreBuiltBy {
  id: string;
  version: string;
}

/** A record store as triples, which is what a caller holding parsed records
 *  hands the encoder without first building a map object from them. */
export interface SealedStoreSource {
  schemaVersion: string;
  header: readonly SealedHeaderEntry[];
  /** Absent for content nothing parsed (an app's own). */
  builtBy?: SealedStoreBuiltBy;
  /** `[key, tag, body]` triples in the order the store holds them. */
  records: PackedRecord<unknown>[];
}

/** A record-store entry split into its tag and body: the tag of a value in
 *  the record shape (`{ type, params }` and nothing else), or null for any
 *  other value, which is the body whole. `recordValueOf` rebuilds the value. */
export interface SealedRecord {
  tag: string | null;
  body: unknown;
}

/**
 * One map root of frozen content, stored or held in memory.
 *
 * Opening one decodes nothing. A keyed read builds the record it asks for;
 * `forEach` walks the records in stored order without keeping them. Values
 * are the stored JSON values, built afresh on every read.
 */
export interface SealedMapReader {
  /** Entries in the map. */
  size(): number;
  has(key: string): boolean;
  get(key: string): unknown;
  /** Every key, in stored order. */
  keys(): string[];
  /** Every entry, in stored order. */
  forEach(visit: (key: string, value: unknown) => void): void;
  /** Every entry, in stored order, decoded as the iteration reaches it: a
   *  caller that stops early pays for the records it read. */
  entries(): IterableIterator<[string, unknown]>;
  /** The JSON text of every value, in bytes. Reads every value. */
  valueBytes(): number;
  /** The whole map as the object it was stored from. */
  toJSON(): Record<string, unknown>;
  /** Drop what keyed reads decoded and kept. */
  releaseDecoded(): void;
}

// --- Encoding ---------------------------------------------------------------

/** Whether a value is a record (`{ type, params }` and nothing else). */
function isRecordShaped(value: unknown): value is { type: string; params: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const o = value as Record<string, unknown>;
  let count = 0;
  for (const key in o) {
    if (!Object.prototype.hasOwnProperty.call(o, key)) continue;
    count += 1;
    if (key !== 'type' && key !== 'params') return false;
  }
  return count === 2 && typeof o['type'] === 'string';
}

/** A value split the way a record store reports it. */
export function sealedRecordOf(value: unknown): SealedRecord {
  return isRecordShaped(value)
    ? { tag: value.type, body: value.params }
    : { tag: null, body: value };
}

/** A map root as the encoder walks it: its keys in stored order, and the
 *  value each one holds. `release` drops a value once it is encoded. */
/** @internal */
export interface MapEntries {
  readonly keys: readonly string[];
  value(index: number): unknown;
  release(index: number): void;
}

function entriesFromTriples(records: PackedRecord<unknown>[]): MapEntries {
  return {
    keys: records.map((r) => r[0]),
    value: (i) => recordValueOf(records[i]![1], records[i]![2]),
    release: (i) => {
      (records[i] as unknown[])[2] = undefined;
    },
  };
}

function entriesFromObject(
  object: Record<string, unknown>,
  keys: readonly string[],
): MapEntries {
  return {
    keys,
    value: (i) => object[keys[i]!],
    release: (i) => {
      object[keys[i]!] = undefined;
    },
  };
}

/** @internal */
export type RootPlan =
  | { kind: 'map'; name: string; entries: MapEntries }
  | { kind: 'list'; name: string; items: readonly unknown[] }
  | { kind: 'list'; name: string; keysOf: string }
  | { kind: 'text'; name: string; text: string };

/**
 * The roots `content` is stored as, in its order: an ordered map's key list
 * folded into the map it orders, and every map's entries in stored order.
 *
 * Throws for a root that is not a map, a list or a string.
 *
 * @internal
 */
export function planSealedContent(content: SealedContentJson): RootPlan[] {
  const maps = new Map<string, Record<string, unknown>>();
  const lists: { name: string; items: readonly unknown[] }[] = [];
  for (const name of Object.keys(content)) {
    const value = content[name];
    const kind = sealedRootKindOf(value);
    if (kind === null) {
      throw new TypeError(
        `Content root "${name}" is neither an object, an array, nor a string.`,
      );
    }
    if (kind === 'map') maps.set(name, value as Record<string, unknown>);
    else if (kind === 'list') lists.push({ name, items: value as unknown[] });
  }
  // An ordered map: a list that is exactly a map's keys orders that map and
  // is not stored. One list per map, first come.
  const orderOf = new Map<string, readonly string[]>();
  const listKeysOf = new Map<string, string>();
  for (const { name, items } of lists) {
    for (const [mapName, object] of maps) {
      if (orderOf.has(mapName)) continue;
      if (isKeyPermutation(items, object)) {
        orderOf.set(mapName, items as readonly string[]);
        listKeysOf.set(name, mapName);
        break;
      }
    }
  }
  const roots: RootPlan[] = [];
  for (const name of Object.keys(content)) {
    const value = content[name];
    const kind = sealedRootKindOf(value)!;
    if (kind === 'map') {
      const object = value as Record<string, unknown>;
      const keys = orderOf.get(name) ?? ownDefinedKeys(object);
      roots.push({ kind: 'map', name, entries: entriesFromObject(object, keys) });
    } else if (kind === 'list') {
      const mapName = listKeysOf.get(name);
      roots.push(
        mapName !== undefined
          ? { kind: 'list', name, keysOf: mapName }
          : { kind: 'list', name, items: value as unknown[] },
      );
    } else {
      roots.push({ kind: 'text', name, text: value as string });
    }
  }
  return roots;
}

/**
 * The roots a record store handed over as triples is stored as.
 *
 * @internal
 */
export function planSealedStore(source: SealedStoreSource): RootPlan[] {
  return [
    {
      kind: 'map',
      name: META_KEY,
      entries: entriesFromObject({ [SCHEMA_VERSION_KEY]: source.schemaVersion }, [
        SCHEMA_VERSION_KEY,
      ]),
    },
    {
      kind: 'list',
      name: HEADER_KEY,
      items: source.header.map((e) => recordValueOf(e.tag, e.body)),
    },
    { kind: 'map', name: RECORDS_KEY, entries: entriesFromTriples(source.records) },
    { kind: 'list', name: ORDER_KEY, keysOf: RECORDS_KEY },
  ];
}

/** The keys of an object whose value is not `undefined`, which JSON would
 *  drop and which `release` leaves behind. */
function ownDefinedKeys(object: Record<string, unknown>): string[] {
  return Object.keys(object).filter((k) => object[k] !== undefined);
}

function isKeyPermutation(
  items: readonly unknown[],
  object: Record<string, unknown>,
): boolean {
  const keys = ownDefinedKeys(object);
  if (keys.length !== items.length) return false;
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string' || seen.has(item)) return false;
    if (!Object.prototype.hasOwnProperty.call(object, item)) return false;
    if (object[item] === undefined) return false;
    seen.add(item);
  }
  return true;
}

// --- Decoding ---------------------------------------------------------------

/** Whether a byte run opens as frozen content THIS reader can read. Cheap
 *  enough to ask of any object, since it reads the first five bytes. */
export function isSealedStore(bytes: Uint8Array): boolean {
  const version = frameVersion(bytes);
  return version === VERSION_ARROW || version === VERSION_ARROW_STAGED;
}

/** The frame version stamped on frozen content, or null for bytes that are
 *  not frozen content. */
export function frameVersion(bytes: Uint8Array): number | null {
  if (bytes.byteLength < PROLOGUE_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0) === MAGIC ? view.getUint8(4) : null;
}

/** Frozen content that could not be read. The message names the content
 *  rather than the field that failed, because every way this throws means the
 *  bytes are not content this reader can open. */
export class SealedStoreError extends Error {
  constructor(
    message?: string,
    /** The error the decoder raised, where this wraps one. */
    readonly underlying?: unknown,
  ) {
    super(message);
  }
}

/** `out[key] = value`, as an own property even where the key is `__proto__`. */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    out[key] = value;
  }
}

/** A map root held in memory: its keys in stored order and each value's JSON
 *  text, parsed afresh on every read. */
class SealedJsonMap implements SealedMapReader {
  private _index: Map<string, number> | null = null;

  constructor(
    private readonly _keys: readonly string[],
    private readonly _lines: readonly string[],
  ) {}

  size(): number {
    return this._keys.length;
  }
  has(key: string): boolean {
    return this._at(key) >= 0;
  }
  get(key: string): unknown {
    const at = this._at(key);
    return at < 0 ? undefined : JSON.parse(this._lines[at]!);
  }
  keys(): string[] {
    return [...this._keys];
  }
  forEach(visit: (key: string, value: unknown) => void): void {
    for (let i = 0; i < this._keys.length; i += 1) visit(this._keys[i]!, JSON.parse(this._lines[i]!));
  }
  *entries(): IterableIterator<[string, unknown]> {
    for (let i = 0; i < this._keys.length; i += 1) {
      yield [this._keys[i]!, JSON.parse(this._lines[i]!)];
    }
  }
  valueBytes(): number {
    let bytes = 0;
    for (const line of this._lines) bytes += line.length;
    return bytes;
  }
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.forEach((key, value) => setOwn(out, key, value));
    return out;
  }
  releaseDecoded(): void {}

  private _at(key: string): number {
    if (this._index === null) {
      this._index = new Map();
      for (let i = 0; i < this._keys.length; i += 1) this._index.set(this._keys[i]!, i);
    }
    return this._index.get(key) ?? -1;
  }
}

/** A map's entries as `SealedJsonMap` holds them. A key repeated keeps its
 *  first entry. CONSUMES the values. */
function jsonMapOf(entries: MapEntries): SealedJsonMap {
  const keys: string[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < entries.keys.length; i += 1) {
    const key = entries.keys[i]!;
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
      lines.push(JSON.stringify(entries.value(i)) ?? 'null');
    }
    entries.release(i);
  }
  return new SealedJsonMap(keys, lines);
}

/** Content held in memory, from the roots it is stored as. */
function contentOfPlan(plan: readonly RootPlan[], builtBy: SealedStoreBuiltBy | null): SealedContent {
  const roots = new Map<string, DecodedRoot>();
  for (const root of plan) {
    if (root.kind === 'map') roots.set(root.name, { kind: 'map', map: jsonMapOf(root.entries) });
    else if (root.kind === 'list') {
      roots.set(
        root.name,
        'keysOf' in root
          ? { kind: 'list', keysOf: root.keysOf }
          : { kind: 'list', items: JSON.parse(listJson(root.items)) as unknown[] },
      );
    } else roots.set(root.name, { kind: 'text', value: root.text });
  }
  return SealedContent._of(new Uint8Array(0), roots, builtBy);
}

/** A list's items as one JSON array, an `undefined` item read as null. */
function listJson(items: readonly unknown[]): string {
  return '[' + items.map((item) => JSON.stringify(item === undefined ? null : item) ?? 'null').join(',') + ']';
}

type DecodedRoot =
  | { kind: 'map'; map: SealedMapReader }
  | { kind: 'list'; keysOf: string }
  | { kind: 'list'; items: unknown[] }
  | { kind: 'text'; value: string };

/**
 * Decoded frozen content: the frame read and every root located, or content
 * held in memory (`fromJSON`, `fromRecords`) with the same roots, so a reader
 * never asks which one it holds.
 */
export class SealedContent {
  private constructor(
    private readonly _bytes: Uint8Array,
    private readonly _roots: Map<string, DecodedRoot>,
    private readonly _builtBy: SealedStoreBuiltBy | null,
  ) {}

  /** Read the frame. Throws `SealedStoreError` for bytes that are not frozen
   *  content, or whose frame does not fit inside them. */
  static decode(bytes: Uint8Array): SealedContent {
    const version = frameVersion(bytes);
    if (version === null) throw new SealedStoreError('Not frozen content');
    if (version === VERSION_ARROW || version === VERSION_ARROW_STAGED) {
      return decodeArrowFrame(bytes, version);
    }
    throw new SealedStoreError(
      `Frozen content version ${version}, which this build reads up to ` +
        `${NEWEST_VERSION}`,
    );
  }

  /**
   * Content held in memory, as `decode` reads the same content stored.
   * CONSUMES the map values, as `sealedTablesOfImport` does. Throws for a
   * root that is not a map, a list or a string.
   */
  static fromJSON(content: SealedContentJson, builtBy?: SealedStoreBuiltBy): SealedContent {
    return contentOfPlan(planSealedContent(content), builtBy ?? null);
  }

  /** A record store handed over as triples, held in memory. CONSUMES
   *  `source.records`. */
  static fromRecords(source: SealedStoreSource): SealedContent {
    return contentOfPlan(planSealedStore(source), source.builtBy ?? null);
  }

  /** @internal */
  static fromPlan(plan: readonly RootPlan[], builtBy: SealedStoreBuiltBy | null): SealedContent {
    return contentOfPlan(plan, builtBy);
  }

  /** @internal */
  static _of(
    bytes: Uint8Array,
    roots: Map<string, DecodedRoot>,
    builtBy: SealedStoreBuiltBy | null,
  ): SealedContent {
    return new SealedContent(bytes, roots, builtBy);
  }

  /** The content's own size, which is what it costs to hold and transfer. */
  get byteLength(): number {
    return this._bytes.byteLength;
  }

  /** The importer that produced the content, or null for content that names
   *  none. */
  builtBy(): SealedStoreBuiltBy | null {
    return this._builtBy;
  }

  rootNames(): string[] {
    return [...this._roots.keys()];
  }

  kindOf(name: string): SealedRootKind | undefined {
    return this._roots.get(name)?.kind;
  }

  /** A map root as a lazy reader, or null when the content holds no such
   *  map. */
  mapRoot(name: string): SealedMapReader | null {
    const root = this._roots.get(name);
    return root?.kind === 'map' ? root.map : null;
  }

  /** The map a list root is the key walk of (an ordered map's order list), or
   *  null for a list stored with items of its own. */
  keyWalkOf(name: string): string | null {
    const root = this._roots.get(name);
    return root?.kind === 'list' && 'keysOf' in root ? root.keysOf : null;
  }

  /** Every entry of a map root, in stored order, without building the
   *  object. */
  forEachMapEntry(name: string, visit: (key: string, value: unknown) => void): void {
    this.mapRoot(name)?.forEach(visit);
  }

  /** A map root as an object, or null when the content holds no such map. */
  map(name: string): Record<string, unknown> | null {
    return this.mapRoot(name)?.toJSON() ?? null;
  }

  /** A list root's items, or null when the content holds no such list. */
  list(name: string): unknown[] | null {
    const root = this._roots.get(name);
    if (root?.kind !== 'list') return null;
    if ('items' in root) return [...root.items];
    return [...(this.mapRoot(root.keysOf)?.keys() ?? [])];
  }

  /** A text root, or null when the content holds no such text. */
  text(name: string): string | null {
    const root = this._roots.get(name);
    return root?.kind === 'text' ? root.value : null;
  }

  /** The whole content as the JSON it was encoded from. */
  toJSON(): SealedContentJson {
    const out: SealedContentJson = {};
    for (const name of this._roots.keys()) {
      const kind = this.kindOf(name);
      if (kind === 'map') setOwn(out, name, this.map(name)!);
      else if (kind === 'list') setOwn(out, name, this.list(name)!);
      else if (kind === 'text') setOwn(out, name, this.text(name)!);
    }
    return out;
  }
}

// --- Frame 4 ---------------------------------------------------------------
//
// The prologue, then one ZSTD frame. Inside it, named parts
// (`sealed-arrow.ts` `unpackParts`): first the manifest, `[builtBy, roots]`,
// where a root is `['map', name]`, `['list', name, items]`,
// `['list', name, null, keysOf]` or `['text', name, text]`; then one Arrow
// IPC file per table, each naming its map in its metadata. Decoding needs the
// Arrow reader and a ZSTD decoder, which load on the first frame-4 open
// (`loadSealedCodec`) so a page that never opens one never fetches them.

/** What a frame-4 decode calls. Each decompressor refuses output past `max`. */
export interface SealedCodec {
  arrow: ArrowReader;
  unzstd(bytes: Uint8Array, max: number): Uint8Array;
  gunzip(bytes: Uint8Array, max: number): Uint8Array;
  reader: typeof import('./sealed-arrow.js');
}

/**
 * The most a frame-4 or staging-frame body expands to. The encoder refuses to
 * write tables past it and the decoder refuses a body that would expand past
 * it, so every stored line is one every reader decodes, and a body an
 * uploader shaped to expand further is refused before it is decompressed.
 * The densest import measured (2.85M IFC geometry records) expands to 68 MB,
 * and a 128 MiB CSV of single-digit cells to about 285 MB.
 */
export const SEALED_INNER_MAX_BYTES = 256 * 1024 * 1024;

/** Content whose tables would expand past `SEALED_INNER_MAX_BYTES`. */
export class SealedContentTooLargeError extends SealedStoreError {
  constructor() {
    super(`Sealed content expands past ${SEALED_INNER_MAX_BYTES} bytes`);
    this.name = 'SealedContentTooLargeError';
  }
}

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_BLOCK_MAX = 128 * 1024;

/**
 * The most a ZSTD stream can write or allocate, read from its frame and block
 * headers without decompressing it: per frame its window, and its declared
 * content size, which a decoder holds the frame's output to. A frame that
 * declares none is bounded by its blocks: each raw or RLE block's stated size
 * plus the format's 128 KiB ceiling per compressed block, which overstates a
 * level-19 frame (its blocks average a few KB). Both encoders here declare the
 * size. Throws on a stream that is not ZSTD frames end to end.
 */
export function zstdOutputBound(bytes: Uint8Array): number {
  let at = 0;
  let output = 0;
  let largest = 0;
  const need = (n: number): void => {
    if (at + n > bytes.length) throw new RangeError('zstd stream is truncated');
  };
  const le = (n: number): number => {
    need(n);
    let v = 0;
    for (let i = n - 1; i >= 0; i -= 1) v = v * 256 + bytes[at + i]!;
    at += n;
    return v;
  };
  while (at < bytes.length) {
    const magic = le(4);
    if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {
      const size = le(4);
      need(size);
      at += size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw new RangeError('not a zstd frame');
    const fhd = le(1);
    if (fhd & 8) throw new RangeError('zstd frame header sets a reserved bit');
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    let window = 0;
    if (single === 0) {
      const wd = le(1);
      const base = 2 ** (10 + (wd >> 3));
      window = base + (base / 8) * (wd & 7);
    }
    le([0, 1, 2, 4][fhd & 3]!);
    const fcsBytes = fcsFlag === 0 ? single : 2 ** fcsFlag;
    const fcs = fcsBytes === 0 ? 0 : le(fcsBytes) + (fcsBytes === 2 ? 256 : 0);
    largest = Math.max(largest, window, fcs);
    let blocks = 0;
    for (;;) {
      const header = le(3);
      const type = (header >> 1) & 3;
      const size = header >>> 3;
      if (type === 0) {
        need(size);
        at += size;
        blocks += size;
      } else if (type === 1) {
        need(1);
        at += 1;
        blocks += size;
      } else if (type === 2) {
        need(size);
        at += size;
        blocks += ZSTD_BLOCK_MAX;
      } else {
        throw new RangeError('zstd block type is reserved');
      }
      if (header & 1) break;
    }
    output += fcsBytes === 0 ? blocks : fcs;
    if (checksum) le(4);
  }
  return Math.max(output, largest);
}

/** A ZSTD body decompressed, refused before it is decompressed where its
 *  headers allow more than `max`. */
function unzstdCapped(unzstd: (bytes: Uint8Array, max: number) => Uint8Array, body: Uint8Array, max: number): Uint8Array {
  let bound: number;
  try {
    bound = zstdOutputBound(body);
  } catch (cause) {
    throw new SealedStoreError('Frozen content is unreadable', cause);
  }
  if (bound > max) throw new SealedContentTooLargeError();
  return unzstd(body, max);
}

/** A gzip body inflated a slice at a time, refused once it passes `max`.
 *  A slice inflates to at most 1032 times its own size. */
function gunzipStreamed(body: Uint8Array, max: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflate = new Gunzip((chunk) => {
    total += chunk.byteLength;
    if (total > max) throw new SealedContentTooLargeError();
    chunks.push(chunk);
  });
  const step = 16 * 1024;
  for (let at = 0; at < body.length; at += step) {
    inflate.push(body.subarray(at, at + step), at + step >= body.length);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

let sealedCodec: SealedCodec | null = null;
let sealedCodecLoading: Promise<void> | null = null;

/** Whether decoding these bytes needs `loadSealedCodec` first. */
export function needsSealedCodec(bytes: Uint8Array): boolean {
  const version = frameVersion(bytes);
  return (version === VERSION_ARROW || version === VERSION_ARROW_STAGED) && sealedCodec === null;
}

interface NativeZstd {
  zstdDecompressSync?(bytes: Uint8Array, options: { maxOutputLength: number }): Uint8Array;
  gunzipSync?(bytes: Uint8Array, options: { maxOutputLength: number }): Uint8Array;
}

/** Node's error for output past `maxOutputLength`. */
function overMax(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE';
}

/** Load what a frame-4 decode needs. Under a Node that carries zstd, the
 *  built-in decompresses; anywhere else, `fzstd`. */
export function loadSealedCodec(): Promise<void> {
  if (sealedCodec !== null) return Promise.resolve();
  sealedCodecLoading ??= (async () => {
    let native: NativeZstd | undefined;
    try {
      const proc = (
        globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
      ).process;
      native = proc?.getBuiltinModule?.('node:zlib') as NativeZstd | undefined;
    } catch {
      native = undefined;
    }
    const nativeUnzstd = native?.zstdDecompressSync?.bind(native);
    const nativeGunzip = native?.gunzipSync?.bind(native);
    const [arrow, unzstd, reader] = await Promise.all([
      import('apache-arrow'),
      nativeUnzstd !== undefined
        ? Promise.resolve((bytes: Uint8Array, max: number) => {
            try {
              return new Uint8Array(nativeUnzstd(bytes, { maxOutputLength: max }));
            } catch (err) {
              if (overMax(err)) throw new SealedContentTooLargeError();
              throw err;
            }
          })
        : // The frame headers bound what `fzstd` allocates and writes
          // (`unzstdCapped` checks them first), so it runs uncapped.
          import('fzstd').then((m) => (bytes: Uint8Array) => m.decompress(bytes)),
      import('./sealed-arrow.js'),
    ]);
    const gunzip =
      nativeGunzip !== undefined
        ? (bytes: Uint8Array, max: number) => {
            try {
              return new Uint8Array(nativeGunzip(bytes, { maxOutputLength: max }));
            } catch (err) {
              if (overMax(err)) throw new SealedContentTooLargeError();
              throw err;
            }
          }
        : gunzipStreamed;
    sealedCodec = { arrow: arrow as unknown as ArrowReader, unzstd, gunzip, reader };
  })().catch((err: unknown) => {
    sealedCodecLoading = null;
    throw err;
  });
  return sealedCodecLoading;
}

/** Decode frozen bytes, loading the frame-4 codec first when they need it.
 *  A frame-4 decode awaits `pause` before each table it parses, so a large
 *  decode leaves the page responsive. */
export async function decodeSealedContent(
  bytes: Uint8Array,
  pause: () => Promise<void> = slicedYield(),
): Promise<SealedContent> {
  if (needsSealedCodec(bytes)) await loadSealedCodec();
  const version = frameVersion(bytes);
  if (version !== VERSION_ARROW && version !== VERSION_ARROW_STAGED) return SealedContent.decode(bytes);
  const steps = arrowFrameSteps(bytes, version);
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done === true) return step.value;
    await pause();
  }
}

/** Work between yields. A yield costs a few milliseconds on a phone, and a
 *  frame holds hundreds of tables, so yielding before every one adds up. */
const YIELD_SLICE_MS = 25;

/** A pause that hands the event loop back once `sliceMs` of work has run
 *  since the last time it did. */
export function slicedYield(sliceMs = YIELD_SLICE_MS): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < sliceMs) return;
    await yieldToEventLoop();
    since = performance.now();
  };
}

type Scheduler = { yield?: () => Promise<void> };

/** Hands the event loop back for one turn: `scheduler.yield` where the
 *  platform has it, else a message, which no timer clamp delays. */
export function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: Scheduler }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A frame-4 object around its ZSTD-compressed parts, or with
 *  `VERSION_ARROW_STAGED`, the staging frame around its gzipped parts. */
export function arrowFrameBytes(compressed: Uint8Array, version = VERSION_ARROW): Uint8Array {
  const out = new Uint8Array(PROLOGUE_BYTES + compressed.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC);
  view.setUint8(4, version);
  out.set(compressed, PROLOGUE_BYTES);
  return out;
}

/** A frame-4 or staging-frame object's compressed parts. */
export function arrowFrameBody(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(PROLOGUE_BYTES);
}

/**
 * A frame-4 or staging-frame object's parts, decompressed. Throws
 * `SealedContentTooLargeError` for a body that expands past
 * `SEALED_INNER_MAX_BYTES`, and needs `loadSealedCodec` first.
 */
export function arrowFrameInner(bytes: Uint8Array): Uint8Array {
  const version = frameVersion(bytes);
  if (sealedCodec === null) {
    throw new SealedStoreError(`Frozen content version ${version} needs its codec loaded first`);
  }
  const body = bytes.subarray(PROLOGUE_BYTES);
  try {
    return version === VERSION_ARROW_STAGED
      ? sealedCodec.gunzip(body, SEALED_INNER_MAX_BYTES)
      : unzstdCapped(sealedCodec.unzstd, body, SEALED_INNER_MAX_BYTES);
  } catch (err) {
    if (err instanceof SealedStoreError) throw err;
    throw new SealedStoreError('Frozen content is unreadable', err);
  }
}

/** The manifest part's name; table parts are named by their position. */
export const ARROW_MANIFEST_PART = 'manifest';

export type ArrowManifestRoot =
  | ['map', string]
  | ['list', string, unknown[]]
  | ['list', string, null, string]
  | ['text', string, string];

export type ArrowManifest = [[string, string] | null, ArrowManifestRoot[]];

function decodeArrowFrame(bytes: Uint8Array, version: number): SealedContent {
  const steps = arrowFrameSteps(bytes, version);
  for (let step = steps.next(); ; step = steps.next()) if (step.done === true) return step.value;
}

/** A frame-4 decode, stepping before each table it parses. */
function* arrowFrameSteps(bytes: Uint8Array, version: number): Generator<void, SealedContent> {
  if (sealedCodec === null) {
    throw new SealedStoreError(`Frozen content version ${version} needs its codec loaded first`);
  }
  const codec = sealedCodec;
  const inner = arrowFrameInner(bytes);
  let parts: [string, Uint8Array][];
  try {
    parts = codec.reader.unpackParts(inner);
  } catch (cause) {
    throw new SealedStoreError('Frozen content is unreadable', cause);
  }
  const [manifestName, manifestBytes] = parts[0] ?? [];
  if (manifestName !== ARROW_MANIFEST_PART || manifestBytes === undefined) {
    throw new SealedStoreError('Frozen content descriptor is unreadable');
  }
  let manifest: ArrowManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ArrowManifest;
  } catch (cause) {
    throw new SealedStoreError('Frozen content descriptor is unreadable', cause);
  }
  if (!Array.isArray(manifest) || !Array.isArray(manifest[1])) {
    throw new SealedStoreError('Frozen content descriptor is unreadable');
  }
  const tablesOf = new Map<string, StoredArrowTable[]>();
  for (const [, ipc] of parts.slice(1)) {
    yield;
    let table: ReturnType<ArrowReader['tableFromIPC']>;
    let meta: TableMeta;
    try {
      codec.reader.checkIpcFile(ipc);
      table = codec.arrow.tableFromIPC(ipc);
      meta = JSON.parse(table.schema.metadata.get(codec.reader.TABLE_META_KEY) ?? '') as TableMeta;
      for (const batch of table.batches) codec.reader.checkTableData(batch.data);
    } catch (cause) {
      throw new SealedStoreError('Frozen table is unreadable', cause);
    }
    let list = tablesOf.get(meta.root);
    if (list === undefined) tablesOf.set(meta.root, (list = []));
    for (const batch of table.batches) list.push({ meta, data: batch.data });
  }
  const by = manifest[0];
  const builtBy =
    Array.isArray(by) && typeof by[0] === 'string' && typeof by[1] === 'string'
      ? { id: by[0], version: by[1] }
      : null;
  const roots = new Map<string, DecodedRoot>();
  for (const d of manifest[1]) {
    if (!Array.isArray(d) || typeof d[1] !== 'string') {
      throw new SealedStoreError('Frozen content descriptor is unreadable');
    }
    const name = d[1];
    if (d[0] === 'map') {
      roots.set(name, { kind: 'map', map: new SealedArrowMap(codec.reader, tablesOf.get(name) ?? []) });
    } else if (d[0] === 'list') {
      if (typeof d[3] === 'string') roots.set(name, { kind: 'list', keysOf: d[3] });
      else if (Array.isArray(d[2])) roots.set(name, { kind: 'list', items: d[2] });
      else throw new SealedStoreError('Frozen content descriptor is unreadable');
    } else if (d[0] === 'text' && typeof d[2] === 'string') {
      roots.set(name, { kind: 'text', value: d[2] });
    } else {
      throw new SealedStoreError(`Frozen content root "${name}" has an unknown kind`);
    }
  }
  return SealedContent._of(bytes, roots, builtBy);
}

interface StoredArrowTable {
  meta: TableMeta;
  data: ArrowData;
}

/** A row's value, with any failure to build it read as unreadable content. */
function readValue(t: ReadyTable, row: number): unknown {
  try {
    return t.value(row);
  } catch (cause) {
    throw new SealedStoreError('Frozen table is unreadable', cause);
  }
}

/** A row's key, with any failure to read it as a string read as unreadable
 *  content. */
function readKey(t: ReadyTable, row: number): string {
  let key: unknown;
  try {
    key = t.key(row);
  } catch (cause) {
    throw new SealedStoreError('Frozen table is unreadable', cause);
  }
  if (typeof key !== 'string') throw new SealedStoreError('Frozen table is unreadable');
  return key;
}

/**
 * Records a hash per key as a walk meets them, in position order, and throws
 * from `finish` if two keys were the same: the hashes are sorted, and only
 * where two agree are the keys themselves rebuilt and compared. Kept to a
 * typed array, so the check costs one sort of four bytes a key.
 */
class KeyCheck {
  private readonly _hashes: Uint32Array;

  constructor(
    count: number,
    private readonly _keyAt: (at: number) => string,
  ) {
    this._hashes = new Uint32Array(count);
  }

  add(key: string, at: number): void {
    this._hashes[at] = keyHash(key);
  }

  finish(): void {
    const sorted = this._hashes.slice().sort();
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] !== sorted[i - 1]) continue;
      const h = sorted[i]!;
      const seen = new Set<string>();
      for (let at = 0; at < this._hashes.length; at += 1) {
        if (this._hashes[at] !== h) continue;
        const key = this._keyAt(at);
        if (seen.has(key)) throw new SealedStoreError('Frozen table is unreadable');
        seen.add(key);
      }
      while (i + 1 < sorted.length && sorted[i + 1] === h) i += 1;
    }
  }
}

function keyHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Keyed reads a frame-4 map answers by scanning its key columns before it
 *  builds an index of every key. A scan touches only typed arrays and costs
 *  milliseconds at a million records; the index costs a string and a map
 *  entry per record, which a few keyed reads never repay. */
const SCANNED_LOOKUPS = 64;

/** A version 4 map root. Its tables are prepared on first use; a value is
 *  built when it is read, so a keyed read builds the rows it asks for. Until a
 *  walk prepares every table, a keyed read prepares only the table it hits,
 *  decoding its dictionaries' entries as they are read. */
class SealedArrowMap implements SealedMapReader {
  private readonly _count: number;
  private readonly _cx: ReadContext;
  private readonly _ready: (ReadyTable | undefined)[];
  private _lazyCx: ReadContext | null = null;
  private _lazyReady: (ReadyTable | undefined)[] | null = null;
  private _tables: ReadyTable[] | null = null;
  private _tableAt: Int32Array | null = null;
  private _rowAt: Int32Array | null = null;
  private _keys: string[] | null = null;
  private _index: Map<string, number> | null = null;
  private _lookups = 0;
  /** Whether a whole walk has found every key distinct. */
  private _unique = false;

  constructor(
    private readonly _reader: SealedCodec['reader'],
    private readonly _stored: readonly StoredArrowTable[],
  ) {
    let count = 0;
    for (const t of _stored) count += t.data.length;
    this._count = count;
    this._cx = new _reader.ReadContext();
    this._ready = Array.from({ length: _stored.length });
  }

  size(): number {
    return this._count;
  }

  has(key: string): boolean {
    return this._find(key) !== null;
  }

  get(key: string): unknown {
    const found = this._find(key);
    return found === null ? undefined : readValue(this._keyedTable(found[0]), found[1]);
  }

  keys(): string[] {
    if (this._keys === null) {
      this._order();
      const check = this._unique ? null : new KeyCheck(this._count, (at) => this._keyAt(at));
      const keys: string[] = Array.from({ length: this._count });
      for (let at = 0; at < this._count; at += 1) {
        const key = this._keyAt(at);
        check?.add(key, at);
        keys[at] = key;
      }
      check?.finish();
      this._unique = true;
      this._keys = keys;
    }
    return this._keys;
  }

  forEach(visit: (key: string, value: unknown) => void): void {
    for (const [key, value] of this.entries()) visit(key, value);
  }

  *entries(): IterableIterator<[string, unknown]> {
    this._order();
    const tables = this._tables!;
    const tableAt = this._tableAt!;
    const rowAt = this._rowAt!;
    // A repeated key is reported once the walk has met both.
    const check = this._unique ? null : new KeyCheck(this._count, (at) => this._keyAt(at));
    for (let at = 0; at < this._count; at += 1) {
      const t = tables[tableAt[at]!]!;
      const row = rowAt[at]!;
      const key = readKey(t, row);
      check?.add(key, at);
      yield [key, readValue(t, row)];
    }
    check?.finish();
    this._unique = true;
  }

  valueBytes(): number {
    let bytes = 0;
    for (const [, value] of this.entries()) bytes += (JSON.stringify(value) ?? 'null').length;
    return bytes;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of this.entries()) setOwn(out, key, value);
    return out;
  }

  releaseDecoded(): void {
    this._keys = null;
    this._index = null;
    this._lookups = 0;
  }

  /** The table and row holding `key`. */
  private _find(key: string): [number, number] | null {
    if (this._index === null && this._lookups >= SCANNED_LOOKUPS) {
      const keys = this.keys();
      const index = new Map<string, number>();
      for (let at = 0; at < keys.length; at += 1) index.set(keys[at]!, at);
      this._index = index;
    }
    if (this._index !== null) {
      const at = this._index.get(key);
      return at === undefined ? null : [this._tableAt![at]!, this._rowAt![at]!];
    }
    this._lookups += 1;
    const cx = this._tables === null ? this._lazy() : this._cx;
    const matches: [number, number][] = [];
    for (let ti = 0; ti < this._stored.length; ti += 1) {
      const t = this._stored[ti]!;
      let rows: number[];
      try {
        rows = this._reader.rowsWithKey(t.meta, t.data.children[0]!, key, cx);
      } catch (cause) {
        throw new SealedStoreError('Frozen table is unreadable', cause);
      }
      for (const row of rows) matches.push([ti, row]);
    }
    // The encoder writes each key once, so tables repeating one are not its.
    if (matches.length > 1) throw new SealedStoreError('Frozen table is unreadable');
    return matches[0] ?? null;
  }

  private _keyAt(at: number): string {
    return readKey(this._tables![this._tableAt![at]!]!, this._rowAt![at]!);
  }

  private _lazy(): ReadContext {
    return (this._lazyCx ??= new this._reader.ReadContext(true));
  }

  /** A table for a keyed read: the walk's where it is prepared, else one
   *  prepared lazily on its own. */
  private _keyedTable(ti: number): ReadyTable {
    const ready = this._ready[ti];
    if (ready !== undefined) return ready;
    const lazy = (this._lazyReady ??= Array.from({ length: this._stored.length }));
    let t = lazy[ti];
    if (t === undefined) {
      const stored = this._stored[ti]!;
      try {
        t = this._reader.readyTable(stored.meta, stored.data, this._lazy());
      } catch (cause) {
        throw new SealedStoreError('Frozen table is unreadable', cause);
      }
      lazy[ti] = t;
    }
    return t;
  }

  private _table(ti: number): ReadyTable {
    let t = this._ready[ti];
    if (t === undefined) {
      const stored = this._stored[ti]!;
      try {
        t = this._reader.readyTable(stored.meta, stored.data, this._cx);
      } catch (cause) {
        throw new SealedStoreError('Frozen table is unreadable', cause);
      }
      this._ready[ti] = t;
    }
    return t;
  }

  /** Each position's table and row. Every position in the map is held by
   *  exactly one row, or the tables do not describe the map. */
  private _order(): void {
    if (this._tables !== null) return;
    const tables = this._stored.map((_, ti) => this._table(ti));
    const tableAt = new Int32Array(this._count).fill(-1);
    const rowAt = new Int32Array(this._count);
    tables.forEach((t, ti) => {
      const positions = t.positions;
      for (let row = 0; row < positions.length; row += 1) {
        const at = positions[row]!;
        if (!(at >= 0 && at < this._count) || tableAt[at] !== -1) {
          throw new SealedStoreError('Frozen table is unreadable');
        }
        tableAt[at] = ti;
        rowAt[at] = row;
      }
    });
    this._tableAt = tableAt;
    this._rowAt = rowAt;
    this._tables = tables;
    this._lazyCx = null;
    this._lazyReady = null;
  }
}

/**
 * Frozen content read as a record store: the `instances` map, its order, the
 * schema version and the header. Every server-side reader that walks records
 * (an exporter, a view) reads through this, and it answers for any frozen
 * content: a root the content does not hold reads as empty.
 */
export class SealedStore {
  private readonly _records: SealedMapReader | null;

  private constructor(private readonly _content: SealedContent) {
    this._records = _content.mapRoot(RECORDS_KEY);
  }

  static decode(bytes: Uint8Array): SealedStore {
    return new SealedStore(SealedContent.decode(bytes));
  }

  static of(content: SealedContent): SealedStore {
    return new SealedStore(content);
  }

  /** The general form this view reads. */
  get content(): SealedContent {
    return this._content;
  }

  get byteLength(): number {
    return this._content.byteLength;
  }

  /** The schema version, the `meta` root's one key. */
  schemaVersion(): string {
    const v = this._content.mapRoot(META_KEY)?.get(SCHEMA_VERSION_KEY);
    return typeof v === 'string' ? v : '';
  }

  /** The header entries in the record shape, in order. */
  header(): SealedHeaderEntry[] {
    const out: SealedHeaderEntry[] = [];
    for (const item of this._content.list(HEADER_KEY) ?? []) {
      if (isRecordShaped(item)) out.push({ tag: item.type, body: item.params });
    }
    return out;
  }

  builtBy(): SealedStoreBuiltBy | null {
    return this._content.builtBy();
  }

  keys(): string[] {
    return this._records?.keys() ?? [];
  }

  recordCount(): number {
    return this._records?.size() ?? 0;
  }

  has(key: string): boolean {
    return this._records?.has(key) ?? false;
  }

  get(key: string): SealedRecord | undefined {
    if (this._records === null || !this._records.has(key)) return undefined;
    return sealedRecordOf(this._records.get(key));
  }

  forEachRecord(visit: (key: string, tag: string | null, body: unknown) => void): void {
    this._records?.forEach((key, value) => {
      const record = sealedRecordOf(value);
      visit(key, record.tag, record.body);
    });
  }

  releaseDecoded(): void {
    this._records?.releaseDecoded();
  }
}
