// Frame 4's reader: a stream's maps as typed Arrow tables, inferred from the
// values alone by the platform's encoder, compressed with the rest of the
// stream as one ZSTD frame.
//
// A value sits in a slot, and a slot holds one or more variants. A variant is
// a JSON kind, and for an object its ordered key list plus a slot per field,
// so values that differ in kind or key set sit side by side rather than in one
// widened column. A slot of several variants carries a `t` column naming each
// row's variant.
//
//   null        no column
//   bool        uint8, or a constant in the schema
//   num         int32 where every value is one, else float64; or a constant
//   str         dictionary utf8, or a constant, or (`derive`) a code into
//               rules that rebuild the text from a sibling number field
//   tuple       a struct of position slots (one array length)
//   list        a list of one item slot
//   obj         a struct of field slots
//   json        JSON text, where no other variant can carry the value
//
// A map is one or more tables. Each holds its rows' keys, their positions in
// the map as gaps from the row before, and the root slot, so the reader puts
// every entry back at its position and the map's order is its own.
//
// What a read returns is what `JSON.parse` of the value's JSON text returns:
// the same keys in the same order. Objects are built by cloning a per-variant
// template; no generated code runs, which a page whose CSP withholds
// `unsafe-eval` requires.
//
// Nothing here is exported from the package. Arrow is loaded only when a
// frame-4 stream is opened (`loadSealedCodec` in `sealed-store.ts`).

import { DictionaryBatch } from 'apache-arrow/fb/dictionary-batch';
import type { Field } from 'apache-arrow/fb/field';
import { Footer } from 'apache-arrow/fb/footer';
import { Message } from 'apache-arrow/fb/message';
import { MessageHeader } from 'apache-arrow/fb/message-header';
import { RecordBatch } from 'apache-arrow/fb/record-batch';
import type { Schema } from 'apache-arrow/fb/schema';
import { ByteBuffer } from 'flatbuffers';

/** The slice of Arrow JS this reader uses. */
export interface ArrowData {
  type: { typeId: number };
  length: number;
  offset: number;
  values: ArrayLike<number> & { subarray?: (a: number, b: number) => Uint8Array };
  valueOffsets: Int32Array;
  children: ArrowData[];
  dictionary?: { length: number; data: ArrowData[] };
}

export interface ArrowReader {
  tableFromIPC(bytes: Uint8Array): {
    schema: { metadata: Map<string, string> };
    batches: { data: ArrowData }[];
  };
}

/** The variants a slot's values take, in the order the `t` column numbers
 *  them. */
export interface Slot {
  v: Variant[];
}

/** A string derived from a sibling number field: field index `from`, and per
 *  code an upper-case flag and a suffix. */
export interface Derivation {
  from: number;
  rules: [0 | 1, string][];
}

export type Variant =
  | { k: 'null' }
  | { k: 'bool'; c?: boolean }
  | { k: 'num'; int: boolean; c?: number }
  | { k: 'str'; c?: string; derive?: Derivation }
  | { k: 'tuple'; items: Slot[] }
  | { k: 'list'; item: Slot }
  | { k: 'obj'; keys: string[]; fields: Slot[] }
  | { k: 'json' };

/** How a table stores its keys: a shared prefix before an int32, two
 *  dictionary halves around a separator, utf8 text, or JSON text for a key
 *  UTF-8 cannot carry. */
export type KeyMeta = { prefix: string } | { split: string } | { text: true } | { json: true };

export interface TableMeta {
  root: string;
  key: KeyMeta;
  slot: Slot;
}

/** The derived-string code for a row whose text no rule rebuilds. */
export const HELD = 255;

/** The table metadata's key in an IPC file's schema metadata. */
export const TABLE_META_KEY = 'brass:table';

/** Whether a variant stores a column. */
export function variantStored(v: Variant): boolean {
  switch (v.k) {
    case 'null':
      return false;
    case 'bool':
    case 'num':
    case 'str':
      return v.c === undefined;
  }
  return true;
}

// --- parts ---------------------------------------------------------------

// Each row decodes on its own, so a decoder that strips a leading BOM would
// take U+FEFF off the start of every value that begins with one.
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Named parts behind a JSON table of names and lengths. */
export function unpackParts(bytes: Uint8Array): [string, Uint8Array][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headLength = view.getUint32(0, true);
  const table = JSON.parse(utf8Decoder.decode(bytes.subarray(4, 4 + headLength))) as [
    string,
    number,
  ][];
  let at = 4 + headLength;
  return table.map(([name, length]) => {
    const part = bytes.subarray(at, at + length);
    at += length;
    if (part.byteLength !== length) throw new RangeError(`part ${name} is truncated`);
    return [name, part];
  });
}

// --- checking ------------------------------------------------------------

const ARROW_MAGIC = [0x41, 0x52, 0x52, 0x4f, 0x57, 0x31];

/** Throws unless `count` items of `stride` bytes fit in the buffer. */
function fits(count: number, stride: number, bb: ByteBuffer): void {
  if (!(count >= 0 && count * stride <= bb.capacity())) {
    throw new RangeError('an IPC vector runs past its bytes');
  }
}

/** Fields visited, bounded by the buffer, so a field tree whose children
 *  point back at shared tables cannot multiply the walk. */
interface FieldBudget {
  left: number;
}

function checkField(f: Field, bb: ByteBuffer, depth: number, budget: FieldBudget): void {
  if (depth > 64 || (budget.left -= 1) < 0) throw new RangeError('an IPC schema nests too deep');
  fits(f.childrenLength(), 4, bb);
  fits(f.customMetadataLength(), 4, bb);
  for (let i = 0; i < f.childrenLength(); i += 1) {
    const child = f.children(i);
    if (child === null) throw new RangeError('an IPC field is missing');
    checkField(child, bb, depth + 1, budget);
  }
}

function checkSchema(s: Schema, bb: ByteBuffer): void {
  fits(s.fieldsLength(), 4, bb);
  fits(s.customMetadataLength(), 4, bb);
  fits(s.featuresLength(), 8, bb);
  const budget = { left: bb.capacity() >> 2 };
  for (let i = 0; i < s.fieldsLength(); i += 1) {
    const field = s.fields(i);
    if (field === null) throw new RangeError('an IPC field is missing');
    checkField(field, bb, 0, budget);
  }
}

function checkBatch(rb: RecordBatch, bb: ByteBuffer): void {
  fits(rb.nodesLength(), 16, bb);
  fits(rb.buffersLength(), 16, bb);
  fits(rb.variadicBufferCountsLength(), 8, bb);
}

/**
 * Throws unless an Arrow IPC file's footer and every message it points at
 * stay inside the file. Arrow reads a file by its own offsets and vector
 * lengths, so a footer block naming a message of the wrong kind makes its
 * reader loop, and a declared length makes it allocate that much; both are
 * held to the bytes here before Arrow reads anything.
 */
export function checkIpcFile(bytes: Uint8Array): void {
  const n = bytes.byteLength;
  if (n < 22) throw new RangeError('an IPC file is truncated');
  for (let i = 0; i < ARROW_MAGIC.length; i += 1) {
    if (bytes[i] !== ARROW_MAGIC[i] || bytes[n - 6 + i] !== ARROW_MAGIC[i]) {
      throw new RangeError('an IPC file lacks its magic');
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, n);
  const footerLength = view.getInt32(n - 10, true);
  if (!(footerLength > 0 && footerLength <= n - 18)) {
    throw new RangeError('an IPC footer runs past its file');
  }
  const bodyEnd = n - 10 - footerLength;
  const fbb = new ByteBuffer(bytes.subarray(bodyEnd, n - 10));
  const footer = Footer.getRootAsFooter(fbb);
  const schema = footer.schema();
  if (schema === null) throw new RangeError('an IPC file has no schema');
  checkSchema(schema, fbb);
  fits(footer.recordBatchesLength(), 24, fbb);
  fits(footer.dictionariesLength(), 24, fbb);
  fits(footer.customMetadataLength(), 4, fbb);
  const blocks: [MessageHeader, number, (i: number) => ReturnType<Footer['dictionaries']>][] = [
    [MessageHeader.DictionaryBatch, footer.dictionariesLength(), (i) => footer.dictionaries(i)],
    [MessageHeader.RecordBatch, footer.recordBatchesLength(), (i) => footer.recordBatches(i)],
  ];
  for (const [want, count, blockAt] of blocks) {
    for (let i = 0; i < count; i += 1) {
      const block = blockAt(i);
      if (block === null) throw new RangeError('an IPC block is missing');
      const offset = Number(block.offset());
      const metaLength = block.metaDataLength();
      const bodyLength = Number(block.bodyLength());
      if (
        !(offset >= 8 && metaLength > 8 && bodyLength >= 0 && offset + metaLength + bodyLength <= bodyEnd)
      ) {
        throw new RangeError('an IPC block runs past its file');
      }
      if (view.getInt32(offset, true) !== -1) throw new RangeError('an IPC block names no message');
      const length = view.getInt32(offset + 4, true);
      if (!(length > 0 && length <= metaLength - 8)) {
        throw new RangeError('an IPC message runs past its block');
      }
      const mbb = new ByteBuffer(bytes.subarray(offset + 8, offset + 8 + length));
      const message = Message.getRootAsMessage(mbb);
      if (message.headerType() !== want) throw new RangeError('an IPC block names the wrong message');
      if (!(Number(message.bodyLength()) <= bodyLength)) {
        throw new RangeError('an IPC message body runs past its block');
      }
      fits(message.customMetadataLength(), 4, mbb);
      const rb =
        want === MessageHeader.RecordBatch
          ? (message.header(new RecordBatch()) as RecordBatch | null)
          : (message.header(new DictionaryBatch()) as DictionaryBatch | null)?.data() ?? null;
      if (rb === null) throw new RangeError('an IPC message has no batch');
      checkBatch(rb, mbb);
    }
  }
}


// Arrow's type ids for the column types a sealed table is written with.
const TYPE_INT = 2;
const TYPE_FLOAT = 3;
const TYPE_UTF8 = 5;
const TYPE_LIST = 12;
const TYPE_STRUCT = 13;
const TYPE_DICTIONARY = -1;

/**
 * Throws unless a stored table's buffers carry every row it declares. A
 * column's length is the uploader's claim, and the reader allocates and loops
 * on it, so each claim is held to the bytes behind it: a fixed-width column
 * has a value per row, offsets rise and stay inside the bytes or child they
 * index (so no two rows share a range, and decoding every row reads each
 * byte once), a struct's fields are each as long as it, and a dictionary is
 * no longer than the column that indexes it. A table's own struct carries
 * the key, gap and value columns.
 */
export function checkTableData(data: ArrowData): void {
  if (data.type.typeId !== TYPE_STRUCT || data.children.length !== 3) {
    throw new RangeError('a table is not a key, gap and value struct');
  }
  checkData(data);
}

function checkData(d: ArrowData): void {
  const n = d.length;
  if (d.offset !== 0 || !(n >= 0)) throw new RangeError('a column starts past its buffer');
  switch (d.type.typeId) {
    case TYPE_INT:
    case TYPE_FLOAT:
      if (d.values.length < n) throw new RangeError('a column is shorter than its rows');
      return;
    case TYPE_UTF8:
      checkOffsets(d.valueOffsets, n, d.values.length);
      return;
    case TYPE_LIST: {
      const child = d.children[0];
      if (child === undefined) throw new RangeError('a list has no items');
      checkOffsets(d.valueOffsets, n, child.length);
      checkData(child);
      return;
    }
    case TYPE_STRUCT:
      for (const child of d.children) {
        if (child.length < n) throw new RangeError('a field is shorter than its struct');
        checkData(child);
      }
      return;
    case TYPE_DICTIONARY: {
      const dictionary = d.dictionary;
      if (d.values.length < n || dictionary === undefined || dictionary.length > n) {
        throw new RangeError('a dictionary column does not cover its rows');
      }
      checkIndices(d.values, n, dictionary.length);
      for (const chunk of dictionary.data) {
        if (chunk.type.typeId !== TYPE_UTF8) throw new RangeError('a dictionary is not text');
        checkData(chunk);
      }
      return;
    }
  }
  throw new RangeError(`a column has type ${d.type.typeId}, which no sealed table is written with`);
}

/** Throws unless each of the first `n` values indexes into `extent`. */
function checkIndices(values: ArrayLike<number>, n: number, extent: number): void {
  for (let row = 0; row < n; row += 1) {
    const i = values[row]!;
    if (!(i >= 0 && i < extent)) throw new RangeError('an index runs past what it indexes');
  }
}

function checkOffsets(offsets: Int32Array, n: number, extent: number): void {
  if (offsets.length < n + 1) throw new RangeError('a column is shorter than its rows');
  let last = offsets[0]!;
  if (last < 0) throw new RangeError('an offset is negative');
  for (let row = 1; row <= n; row += 1) {
    const next = offsets[row]!;
    if (next < last) throw new RangeError('offsets fall');
    last = next;
  }
  if (last > extent) throw new RangeError('an offset runs past its bytes');
}

// --- reading -------------------------------------------------------------

type Obj = Record<string, unknown>;
export type Reader = (row: number) => unknown;

/** What one decode shares across its tables: each object key list's
 *  construction site, and each dictionary decoded once. A `lazy` context
 *  decodes a dictionary's entries as reads reach them, which suits a keyed
 *  read; a walk reads every entry, and decoding them up front is faster. */
export class ReadContext {
  private readonly shapes = new Map<string, number>();
  private readonly dictionaries = new WeakMap<object, string[]>();
  private readonly lazyDictionaries = new WeakMap<object, LazyDictionary>();

  constructor(readonly lazy = false) {}

  strings(dictionary: { data: ArrowData[] }): string[] {
    let strings = this.dictionaries.get(dictionary);
    if (strings === undefined) {
      strings = [];
      for (const chunk of dictionary.data) {
        const at = utf8At(chunk);
        for (let row = 0; row < chunk.length; row += 1) strings.push(at(row));
      }
      this.dictionaries.set(dictionary, strings);
    }
    return strings;
  }

  lazyStrings(dictionary: { data: ArrowData[] }): LazyDictionary {
    let strings = this.lazyDictionaries.get(dictionary);
    if (strings === undefined) {
      strings = new LazyDictionary(dictionary.data);
      this.lazyDictionaries.set(dictionary, strings);
    }
    return strings;
  }

  /** A flag per dictionary entry equal to `s`, or null where none is. */
  matches(dictionary: { data: ArrowData[] }, s: string): Uint8Array | null {
    return this.lazy ? this.lazyStrings(dictionary).matches(s) : dictionaryMatches(this.strings(dictionary), s);
  }

  shapeId(keys: readonly string[]): number {
    const sig = keys.join('\u0000');
    let id = this.shapes.get(sig);
    if (id === undefined) {
      id = this.shapes.size;
      this.shapes.set(sig, id);
    }
    return id;
  }
}

/** A dictionary whose entries are decoded on first read and kept. */
export class LazyDictionary {
  readonly length: number;
  private readonly decoded: (string | undefined)[];
  /** Each chunk's first entry. */
  private readonly starts: number[] = [];

  constructor(private readonly chunks: readonly ArrowData[]) {
    let length = 0;
    for (const chunk of chunks) {
      this.starts.push(length);
      length += chunk.length;
    }
    this.length = length;
    this.decoded = Array.from({ length });
  }

  at(i: number): string {
    let s = this.decoded[i];
    if (s === undefined) {
      let c = this.chunks.length - 1;
      while (c > 0 && this.starts[c]! > i) c -= 1;
      const chunk = this.chunks[c]!;
      const row = i - this.starts[c]!;
      const offsets = chunk.valueOffsets;
      s = utf8Decoder.decode((chunk.values as Uint8Array).subarray(offsets[row]!, offsets[row + 1]!));
      this.decoded[i] = s;
    }
    return s;
  }

  /** A flag per entry equal to `s`, found by comparing bytes, or null where
   *  none is. */
  matches(s: string): Uint8Array | null {
    // An entry reads with replacement characters where its bytes are not
    // UTF-8, so a wanted string carrying one is compared as text.
    if (s.includes('\uFFFD')) return dictionaryMatches(Array.from({ length: this.length }, (_, i) => this.at(i)), s);
    // Every entry decodes well formed, so a string that is not equals none.
    if (!wellFormed(s)) return null;
    const want = utf8Encoder.encode(s);
    const length = want.length;
    let flags: Uint8Array | null = null;
    this.chunks.forEach((chunk, c) => {
      const bytes = chunk.values as Uint8Array;
      const offsets = chunk.valueOffsets;
      for (let row = 0; row < chunk.length; row += 1) {
        const start = offsets[row]!;
        if (offsets[row + 1]! - start !== length) continue;
        let i = 0;
        while (i < length && bytes[start + i] === want[i]) i += 1;
        if (i === length) (flags ??= new Uint8Array(this.length))[this.starts[c]! + row] = 1;
      }
    });
    return flags;
  }
}

function utf8At(d: ArrowData): (row: number) => string {
  const bytes = d.values as Uint8Array;
  const offsets = d.valueOffsets;
  return (row) => utf8Decoder.decode(bytes.subarray(offsets[row]!, offsets[row + 1]!));
}

// Keys are compared by their bytes on a keyed read, so a key whose bytes are
// not UTF-8 is refused rather than read with replacement characters.
const keyDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A table's keys as text, row by row. Each key reads only in the form the
 * encoder writes it (a non-negative integer id, a separator that falls after
 * the first half, UTF-8 text, JSON text as `JSON.stringify` writes it), so a
 * walk and a keyed read (`rowsWithKey`) agree on every key; any other form
 * throws.
 */
export function keyReader(meta: TableMeta, d: ArrowData, cx: ReadContext): (row: number) => string {
  const key = meta.key;
  if ('prefix' in key) {
    const prefix = key.prefix;
    const ids = d.values;
    if (typeof prefix !== 'string') throw new RangeError('a key prefix is not text');
    for (let row = 0; row < d.length; row += 1) {
      const id = ids[row]!;
      if (!(Number.isInteger(id) && id >= 0)) throw new RangeError('a key id is not a whole number');
    }
    return (row) => prefix + String(ids[row]);
  }
  if ('split' in key) {
    const [a, b] = d.children as [ArrowData, ArrowData];
    if (cx.lazy) return lazySplitKeyReader(key.split, a, b, cx);
    const as = cx.strings(a.dictionary!);
    const bs = cx.strings(b.dictionary!);
    const ai = a.values;
    const bi = b.values;
    const sep = key.split;
    if (typeof sep !== 'string' || sep === '' || as.some((s) => (s + sep).indexOf(sep) !== s.length)) {
      throw new RangeError('a key separator does not split its keys');
    }
    return (row) => as[ai[row]!] + sep + bs[bi[row]!];
  }
  const bytes = d.values as Uint8Array;
  const offsets = d.valueOffsets;
  const at = (row: number): string => keyDecoder.decode(bytes.subarray(offsets[row]!, offsets[row + 1]!));
  if ('json' in key) {
    return (row) => {
      const text = at(row);
      const k: unknown = JSON.parse(text);
      if (typeof k !== 'string' || JSON.stringify(k) !== text) throw new RangeError('a JSON key is not as written');
      return k;
    };
  }
  return at;
}

/** Split keys read through lazy dictionaries. Each first half is checked
 *  against the separator when a read first reaches it. */
function lazySplitKeyReader(sep: unknown, a: ArrowData, b: ArrowData, cx: ReadContext): (row: number) => string {
  if (typeof sep !== 'string' || sep === '') throw new RangeError('a key separator does not split its keys');
  const as = cx.lazyStrings(a.dictionary!);
  const bs = cx.lazyStrings(b.dictionary!);
  const ai = a.values;
  const bi = b.values;
  const checked = new Uint8Array(as.length);
  return (row) => {
    const i = ai[row]!;
    const first = as.at(i);
    if (checked[i] === 0) {
      if ((first + sep).indexOf(sep) !== first.length) throw new RangeError('a key separator does not split its keys');
      checked[i] = 1;
    }
    return first + sep + bs.at(bi[row]!);
  };
}

const utf8Encoder = new TextEncoder();

/** Whether a string is well-formed UTF-16, which UTF-8 can carry. */
const wellFormed = (s: string): boolean => (s as unknown as { isWellFormed(): boolean }).isWellFormed();

/**
 * The rows of a table whose key reads as `key`, found from the key column
 * alone: an id compared as a number, a dictionary half by its index, text by
 * its bytes. Nothing is decoded for a row that does not match.
 */
export function rowsWithKey(meta: TableMeta, d: ArrowData, key: string, cx: ReadContext): number[] {
  const rows: number[] = [];
  const n = d.length;
  const k = meta.key;
  if ('prefix' in k) {
    if (!key.startsWith(k.prefix)) return rows;
    const digits = key.slice(k.prefix.length);
    const id = Number(digits);
    if (digits === '' || String(id) !== digits) return rows;
    const ids = d.values;
    for (let row = 0; row < n; row += 1) if (ids[row] === id) rows.push(row);
    return rows;
  }
  if ('split' in k) {
    const at = key.indexOf(k.split);
    if (at < 0) return rows;
    const [a, b] = d.children as [ArrowData, ArrowData];
    const inA = cx.matches(a.dictionary!, key.slice(0, at));
    const inB = cx.matches(b.dictionary!, key.slice(at + k.split.length));
    if (inA === null || inB === null) return rows;
    const ai = a.values;
    const bi = b.values;
    for (let row = 0; row < n; row += 1) if (inA[ai[row]!] === 1 && inB[bi[row]!] === 1) rows.push(row);
    return rows;
  }
  // Text keys are written well formed, and JSON keys as `JSON.stringify` writes them.
  if ('text' in k && !wellFormed(key)) return rows;
  const want = utf8Encoder.encode('json' in k ? JSON.stringify(key) : key);
  const bytes = d.values as Uint8Array;
  const offsets = d.valueOffsets;
  const length = want.length;
  for (let row = 0; row < n; row += 1) {
    const start = offsets[row]!;
    if (offsets[row + 1]! - start !== length) continue;
    let i = 0;
    while (i < length && bytes[start + i] === want[i]) i += 1;
    if (i === length) rows.push(row);
  }
  return rows;
}

/** A flag per dictionary entry equal to `s`, or null where none is. */
function dictionaryMatches(strings: readonly string[], s: string): Uint8Array | null {
  let flags: Uint8Array | null = null;
  for (let i = 0; i < strings.length; i += 1) {
    if (strings[i] === s) (flags ??= new Uint8Array(strings.length))[i] = 1;
  }
  return flags;
}

export function readSlot(slot: Slot, d: ArrowData, cx: ReadContext): Reader {
  if (d.offset !== 0) throw new RangeError('a slot column starts past its buffer');
  let c = 0;
  const tags = slot.v.length > 1 ? d.children[c++]!.values : null;
  const readers = slot.v.map((v) => readVariant(v, variantStored(v) ? d.children[c++]! : null, cx));
  if (tags === null) return readers[0]!;
  checkIndices(tags, d.length, readers.length);
  return (row) => readers[tags[row]!]!(row);
}

function readVariant(v: Variant, d: ArrowData | null, cx: ReadContext): Reader {
  switch (v.k) {
    case 'null':
      return () => null;
    case 'bool': {
      if (v.c !== undefined) {
        const c = v.c;
        return () => c;
      }
      const values = d!.values;
      return (row) => values[row] === 1;
    }
    case 'num': {
      if (v.c !== undefined) {
        const c = v.c;
        return () => c;
      }
      const values = d!.values;
      return (row) => values[row];
    }
    case 'str': {
      if (v.c !== undefined) {
        const c = v.c;
        return () => c;
      }
      if (v.derive) throw new TypeError('a derived string is read through its object');
      const idx = d!.values;
      if (cx.lazy) {
        const lazy = cx.lazyStrings(d!.dictionary!);
        return (row) => lazy.at(idx[row]!);
      }
      const strings = cx.strings(d!.dictionary!);
      return (row) => strings[idx[row]!];
    }
    case 'json': {
      const at = utf8At(d!);
      return (row) => JSON.parse(at(row)) as unknown;
    }
    case 'tuple':
      return tupleReader(v.items.map((s, p) => readSlot(s, d!.children[p]!, cx)));
    case 'list': {
      const offsets = d!.valueOffsets;
      const item = readSlot(v.item, d!.children[0]!, cx);
      return (row) => {
        const out: unknown[] = [];
        for (let j = offsets[row]!; j < offsets[row + 1]!; j += 1) out.push(item(j));
        return out;
      };
    }
    case 'obj': {
      // The encoder writes an object whose keys assign onto `{}` in order as
      // JSON text instead, so a field named `__proto__` is not a table's.
      if (v.keys.includes('__proto__') || v.keys.length !== v.fields.length) {
        throw new RangeError('an object variant names a key no table carries');
      }
      // Fields every row agrees on ride in the template the object is cloned
      // from; the rest are read per row.
      const template: Obj = {};
      const varying: string[] = [];
      const readers: Reader[] = [];
      v.fields.forEach((s, f) => {
        const key = v.keys[f]!;
        const only = s.v.length === 1 ? s.v[0]! : null;
        if (only?.k === 'null') template[key] = null;
        else if (
          (only?.k === 'num' || only?.k === 'str' || only?.k === 'bool') &&
          only.c !== undefined
        ) {
          template[key] = only.c;
        } else {
          template[key] = null;
          varying.push(key);
          const derive = only?.k === 'str' ? only.derive : undefined;
          readers.push(
            derive === undefined
              ? readSlot(s, d!.children[f]!, cx)
              : derivedReader(
                  derive,
                  d!.children[f]!.children[0]!,
                  d!.children[derive.from]!.children[0]!.values,
                ),
          );
        }
      });
      return objectReader(cx.shapeId(v.keys), template, varying, readers);
    }
  }
}

function derivedReader(derive: Derivation, d: ArrowData, numbers: ArrayLike<number>): Reader {
  const codes = d.children[0]!.values;
  for (let row = 0; row < d.length; row += 1) {
    const code = codes[row]!;
    if (code !== HELD && !(code >= 0 && code < derive.rules.length)) {
      throw new RangeError('a derived string names no rule');
    }
  }
  const held = utf8At(d.children[1]!);
  const upper = derive.rules.map((r) => r[0] === 1);
  const suffix = derive.rules.map((r) => r[1]);
  return (row) => {
    const code = codes[row]!;
    if (code === HELD) return held(row);
    const s = String(numbers[row]);
    return (upper[code] ? s.toUpperCase() : s) + suffix[code]!;
  };
}

// An array literal allocates at its length, where pushing grows the array.
const TUPLES: ((rs: Reader[]) => Reader)[] = [
  () => () => [],
  ([r0]) => (row) => [r0!(row)],
  ([r0, r1]) => (row) => [r0!(row), r1!(row)],
  ([r0, r1, r2]) => (row) => [r0!(row), r1!(row), r2!(row)],
  ([r0, r1, r2, r3]) => (row) => [r0!(row), r1!(row), r2!(row), r3!(row)],
  ([r0, r1, r2, r3, r4]) => (row) => [r0!(row), r1!(row), r2!(row), r3!(row), r4!(row)],
  ([r0, r1, r2, r3, r4, r5]) => (row) => [r0!(row), r1!(row), r2!(row), r3!(row), r4!(row), r5!(row)],
  ([r0, r1, r2, r3, r4, r5, r6]) => (row) => [r0!(row), r1!(row), r2!(row), r3!(row), r4!(row), r5!(row), r6!(row)],
  ([r0, r1, r2, r3, r4, r5, r6, r7]) => (row) => [r0!(row), r1!(row), r2!(row), r3!(row), r4!(row), r5!(row), r6!(row), r7!(row)],
  ([r0, r1, r2, r3, r4, r5, r6, r7, r8]) => (row) => [r0!(row), r1!(row), r2!(row), r3!(row), r4!(row), r5!(row), r6!(row), r7!(row), r8!(row)],
  ([r0, r1, r2, r3, r4, r5, r6, r7, r8, r9]) => (row) => [r0!(row), r1!(row), r2!(row), r3!(row), r4!(row), r5!(row), r6!(row), r7!(row), r8!(row), r9!(row)],
  ([r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10]) => (row) => [r0!(row), r1!(row), r2!(row), r3!(row), r4!(row), r5!(row), r6!(row), r7!(row), r8!(row), r9!(row), r10!(row)],
  ([r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11]) => (row) => [r0!(row), r1!(row), r2!(row), r3!(row), r4!(row), r5!(row), r6!(row), r7!(row), r8!(row), r9!(row), r10!(row), r11!(row)],
];

function tupleReader(rs: Reader[]): Reader {
  const literal = TUPLES[rs.length];
  if (literal !== undefined) return literal(rs);
  const n = rs.length;
  return (row) => {
    const out: unknown[] = [];
    for (let p = 0; p < n; p += 1) out.push(rs[p]!(row));
    return out;
  };
}

type Maker = (template: Obj, keys: string[], readers: Reader[]) => Reader;

// One construction site per object shape. V8 keeps type feedback per source
// site, and a site that clones one template and stores one set of keys stays
// monomorphic, where one shared site sees every shape in the stream and runs
// at about half the speed. Each array holds distinct copies of one site, by
// the number of fields a row reads; shape `id` takes copy `id`, and a shape
// past the copies takes the shared loop.
const SITES0: Maker[] = [
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
  (t) => () => ({ ...t }),
];
const SITES1: Maker[] = [
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
  (t, [k0], [r0]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); return o; },
];
const SITES2: Maker[] = [
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
  (t, [k0, k1], [r0, r1]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); return o; },
];
const SITES3: Maker[] = [
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
  (t, [k0, k1, k2], [r0, r1, r2]) => (row) => { const o = { ...t }; o[k0!] = r0!(row); o[k1!] = r1!(row); o[k2!] = r2!(row); return o; },
];
const SITES: Maker[][] = [SITES0, SITES1, SITES2, SITES3];

function objectReader(id: number, template: Obj, varying: string[], rs: Reader[]): Reader {
  const site = SITES[varying.length]?.[id];
  if (site !== undefined) return site(template, varying, rs);
  const n = varying.length;
  return (row) => {
    const o: Obj = { ...template };
    for (let f = 0; f < n; f += 1) o[varying[f]!] = rs[f]!(row);
    return o;
  };
}

// --- a map's tables ------------------------------------------------------

/** One table of a map, ready to read: each row's position in the map, its
 *  key, and its value. */
export interface ReadyTable {
  positions: Int32Array;
  key: (row: number) => string;
  value: Reader;
}

/** A stored table's rows prepared for reading. Positions are absolute, and a
 *  table's gap column runs from zero. */
export function readyTable(meta: TableMeta, data: ArrowData, cx: ReadContext): ReadyTable {
  const [keyCol, gapCol, rootCol] = data.children as [ArrowData, ArrowData, ArrowData];
  const positions = new Int32Array(data.length);
  const gaps = gapCol.values;
  let at = 0;
  for (let row = 0; row < data.length; row += 1) {
    at += gaps[row]!;
    positions[row] = at;
  }
  return { positions, key: keyReader(meta, keyCol, cx), value: readSlot(meta.slot, rootCol, cx) };
}
