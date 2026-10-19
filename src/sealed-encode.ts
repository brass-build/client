// The stored form's tables, built from sealed content or from an importer's
// output directly. Portable: no Node API, so the same encoder runs
// wherever an importer runs (the platform's worker, a browser tab, the CLI),
// and only the compression around its output differs by place.
//
// It sees each map's (key, plain JSON value) pairs in stored order and infers
// typed Arrow tables from them (the slot and variant model is described in
// `sealed-arrow.ts`, which reads what this writes). Nothing here names a
// format. A map is encoded in chunks of stored positions, each chunk its own
// tables, so the values held parsed at once are one chunk's however large the
// map.
//
// @internal

import {
  Dictionary,
  Field,
  Float64,
  Int32,
  List,
  RecordBatch,
  Schema,
  Struct,
  Table,
  Uint8,
  Utf8,
  makeData,
  makeVector,
  tableToIPC,
  type DataType,
} from 'apache-arrow';

import {
  ARROW_MANIFEST_PART,
  SEALED_INNER_MAX_BYTES,
  SealedContentTooLargeError,
  VERSION_ARROW_STAGED,
  arrowFrameBytes,
  planSealedContent,
  planSealedStore,
  type ArrowManifest,
  type ArrowManifestRoot,
  type SealedContent,
  type SealedContentJson,
  type MapEntries,
  type RootPlan,
  type SealedStoreBuiltBy,
  type SealedStoreSource,
} from './sealed-store.js';
import { UNPAGED_MAX_RECORDS } from './record-paging.js';
import { gzipSync } from 'fflate';
import {
  HELD,
  TABLE_META_KEY,
  type KeyMeta,
  type Slot,
  type TableMeta,
  type Variant,
} from './sealed-arrow.js';

/** Map entries a chunk holds. A chunk's values are held parsed while its
 *  tables are built; the next chunk's tables follow in the same frame. */
export const SEALED_CHUNK_ENTRIES = 1 << 17;

const MAX_VARIANTS = 16;
const MAX_TUPLE = 64;
const MAX_DEPTH = 32;
const MAX_TABLES = 1024;
const MIN_TABLE_ROWS = 8;
const MAX_RULES = 255;
const MAX_SUFFIX = 16;

type Kind = 'null' | 'bool' | 'num' | 'str' | 'arr' | 'obj';
type Obj = Record<string, unknown>;

function kindOf(v: unknown): Kind {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return 'bool';
    case 'number':
      return 'num';
    case 'string':
      return 'str';
    case 'object':
      return Array.isArray(v) ? 'arr' : 'obj';
  }
  throw new TypeError(`a ${typeof v} is not a JSON value`);
}

/** A value's variant signature: its kind, and for an object its keys, with
 *  each field's kind where `fieldKinds`. */
function signature(v: unknown, fieldKinds: boolean): string {
  const kind = kindOf(v);
  if (kind !== 'obj') return kind;
  const o = v as Obj;
  // Each key is length-prefixed, so no key can read as a boundary.
  let s = 'obj';
  for (const key in o) s += fieldKinds ? `${key.length}:${key}${kindOf(o[key])};` : `${key.length}:${key};`;
  return s;
}

/** Indices of `values` by signature, in first-seen order. */
function groupBy(values: readonly unknown[], fieldKinds: boolean): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < values.length; i += 1) {
    const s = signature(values[i], fieldKinds);
    let list = groups.get(s);
    if (list === undefined) groups.set(s, (list = []));
    list.push(i);
  }
  return groups;
}

/** Whether a string is well-formed UTF-16, which UTF-8 can carry. */
const wellFormed = (s: string): boolean => (s as unknown as { isWellFormed(): boolean }).isWellFormed();

/** Whether an object's keys survive assignment in order onto `{}`. */
const assignable = (keys: readonly string[]): boolean =>
  keys.every((k) => k !== '__proto__' && wellFormed(k));

// --- columns -------------------------------------------------------------

type ArrowData = ReturnType<typeof makeData>;
type Column = [DataType, ArrowData];

const utf8 = new TextEncoder();

function utf8Column(strings: readonly string[]): Column {
  const offsets = new Int32Array(strings.length + 1);
  const parts = strings.map((s) => utf8.encode(s));
  parts.forEach((p, i) => (offsets[i + 1] = offsets[i]! + p.byteLength));
  const bytes = new Uint8Array(offsets[strings.length]!);
  parts.forEach((p, i) => bytes.set(p, offsets[i]!));
  const type = new Utf8();
  return [type, makeData({ type, length: strings.length, valueOffsets: offsets, data: bytes })];
}

function int32Column(data: Int32Array): Column {
  const type = new Int32();
  return [type, makeData({ type, length: data.length, data })];
}

function uint8Column(data: Uint8Array): Column {
  const type = new Uint8();
  return [type, makeData({ type, length: data.length, data })];
}

function float64Column(data: Float64Array): Column {
  const type = new Float64();
  return [type, makeData({ type, length: data.length, data })];
}

function struct(names: string[], columns: Column[], length: number): Column {
  const type = new Struct(columns.map((c, i) => new Field(names[i]!, c[0], true)));
  return [
    type,
    makeData({ type, length, children: columns.map((c) => c[1]) } as Parameters<typeof makeData>[0]),
  ];
}

/** A row's position in the slot's columns: `at[i]`, or `i` where dense. */
const rowOf = (at: Int32Array | null, i: number): number => (at === null ? i : at[i]!);

/** What an encode stored, for the caller's log line. */
export interface SealedEncodeStats {
  tables: number;
  values: number;
  /** Values, at any depth, stored as JSON text. */
  jsonValues: number;
  /** Bytes inside the frame, before compression. */
  rawBytes: number;
}

class Writer {
  private nextDictionary = 0;
  readonly stats: SealedEncodeStats = { tables: 0, values: 0, jsonValues: 0, rawBytes: 0 };

  dictionary(strings: (string | undefined)[]): Column {
    const index = new Map<string, number>();
    const indices = new Int32Array(strings.length);
    strings.forEach((s, row) => {
      if (s === undefined) return;
      let at = index.get(s);
      if (at === undefined) index.set(s, (at = index.size));
      indices[row] = at;
    });
    const type = new Dictionary(new Utf8(), new Int32(), this.nextDictionary++);
    const dictionary = makeVector(utf8Column([...index.keys()])[1]);
    return [type, makeData({ type, length: strings.length, data: indices, dictionary } as Parameters<typeof makeData>[0])];
  }

  private json(values: readonly unknown[], idx: readonly number[], at: Int32Array | null, length: number): Column {
    const strings: string[] = Array.from({ length }, () => '');
    for (const i of idx) {
      strings[rowOf(at, i)] = JSON.stringify(values[i]);
      this.stats.jsonValues += 1;
    }
    return utf8Column(strings);
  }

  slot(values: readonly unknown[], at: Int32Array | null, length: number, depth: number): { slot: Slot; column: Column } {
    const all = values.map((_, i) => i);
    if (depth > MAX_DEPTH) return this.jsonSlot(values, all, at, length);
    let groups = groupBy(values, true);
    if (groups.size > MAX_VARIANTS) groups = groupBy(values, false);
    if (groups.size > MAX_VARIANTS) return this.jsonSlot(values, all, at, length);
    const variants: Variant[] = [];
    const names: string[] = [];
    const columns: Column[] = [];
    let tags: Uint8Array | null = null;
    if (groups.size > 1) {
      tags = new Uint8Array(length);
      names.push('t');
      columns.push(uint8Column(tags));
    }
    for (const [sig, idx] of groups) {
      const vi = variants.length;
      if (tags) for (const i of idx) tags[rowOf(at, i)] = vi;
      const built = this.variant(sig.startsWith('obj') ? 'obj' : (sig as Kind), values, idx, at, length, depth);
      variants.push(built.variant);
      if (built.column) {
        names.push(`v${vi}`);
        columns.push(built.column);
      }
    }
    return { slot: { v: variants }, column: struct(names, columns, length) };
  }

  private jsonSlot(values: readonly unknown[], idx: number[], at: Int32Array | null, length: number): { slot: Slot; column: Column } {
    return { slot: { v: [{ k: 'json' }] }, column: struct(['v0'], [this.json(values, idx, at, length)], length) };
  }

  private variant(
    kind: Kind,
    values: readonly unknown[],
    idx: readonly number[],
    at: Int32Array | null,
    length: number,
    depth: number,
  ): { variant: Variant; column?: Column } {
    const first = values[idx[0]!];
    const same = (): boolean => idx.every((i) => values[i] === first);
    switch (kind) {
      case 'null':
        return { variant: { k: 'null' } };
      case 'bool': {
        if (same()) return { variant: { k: 'bool', c: first as boolean } };
        const col = new Uint8Array(length);
        for (const i of idx) col[rowOf(at, i)] = values[i] ? 1 : 0;
        return { variant: { k: 'bool' }, column: uint8Column(col) };
      }
      case 'num': {
        if (same()) return { variant: { k: 'num', int: false, c: first as number } };
        const int = idx.every((i) => {
          const n = values[i] as number;
          return Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff && !Object.is(n, -0);
        });
        if (int) {
          const col = new Int32Array(length);
          for (const i of idx) col[rowOf(at, i)] = values[i] as number;
          return { variant: { k: 'num', int }, column: int32Column(col) };
        }
        const col = new Float64Array(length);
        for (const i of idx) col[rowOf(at, i)] = values[i] as number;
        return { variant: { k: 'num', int }, column: float64Column(col) };
      }
      case 'str': {
        if (!idx.every((i) => wellFormed(values[i] as string))) {
          return { variant: { k: 'json' }, column: this.json(values, idx, at, length) };
        }
        if (same()) return { variant: { k: 'str', c: first as string } };
        const strings: (string | undefined)[] = Array.from({ length }, () => undefined);
        for (const i of idx) strings[rowOf(at, i)] = values[i] as string;
        return { variant: { k: 'str' }, column: this.dictionary(strings) };
      }
      case 'arr':
        return this.array(values as readonly unknown[][], idx, at, length, depth);
      case 'obj':
        return this.object(values as readonly Obj[], idx, at, length, depth);
    }
  }

  private array(
    values: readonly unknown[][],
    idx: readonly number[],
    at: Int32Array | null,
    length: number,
    depth: number,
  ): { variant: Variant; column: Column } {
    const width = values[idx[0]!]!.length;
    const rows = Int32Array.from(idx, (i) => rowOf(at, i));
    if (width <= MAX_TUPLE && idx.every((i) => values[i]!.length === width)) {
      const items: Slot[] = [];
      const columns: Column[] = [];
      for (let p = 0; p < width; p += 1) {
        const built = this.slot(
          idx.map((i) => values[i]![p]),
          rows,
          length,
          depth + 1,
        );
        items.push(built.slot);
        columns.push(built.column);
      }
      return {
        variant: { k: 'tuple', items },
        column: struct(items.map((_, p) => `p${p}`), columns, length),
      };
    }
    // Rows rise through `idx`, so a row's items follow the row before's.
    const offsets = new Int32Array(length + 1);
    const counts = new Int32Array(length);
    const flat: unknown[] = [];
    for (const i of idx) {
      counts[rowOf(at, i)] = values[i]!.length;
      for (const item of values[i]!) flat.push(item);
    }
    for (let row = 0; row < length; row += 1) offsets[row + 1] = offsets[row]! + counts[row]!;
    const item = this.slot(flat, null, flat.length, depth + 1);
    const type = new List(new Field('item', item.column[0], true));
    return {
      variant: { k: 'list', item: item.slot },
      column: [
        type,
        makeData({ type, length, valueOffsets: offsets, child: item.column[1] } as Parameters<typeof makeData>[0]),
      ],
    };
  }

  private object(
    values: readonly Obj[],
    idx: readonly number[],
    at: Int32Array | null,
    length: number,
    depth: number,
  ): { variant: Variant; column: Column } {
    const keys = Object.keys(values[idx[0]!]!);
    if (!assignable(keys)) return { variant: { k: 'json' }, column: this.json(values, idx, at, length) };
    const rows = Int32Array.from(idx, (i) => rowOf(at, i));
    const fieldValues = keys.map((k) => idx.map((i) => values[i]![k]));
    const derived = derivations(fieldValues);
    const fields: Slot[] = [];
    const columns: Column[] = [];
    keys.forEach((_, f) => {
      const from = derived.get(f);
      const built =
        from !== undefined
          ? this.derived(fieldValues[f] as string[], fieldValues[from] as number[], from, rows, length)
          : this.slot(fieldValues[f]!, rows, length, depth + 1);
      fields.push(built.slot);
      columns.push(built.column);
    });
    return { variant: { k: 'obj', keys, fields }, column: struct(keys.map((_, f) => `f${f}`), columns, length) };
  }

  /** A string field as codes against its sibling number field. */
  private derived(strings: readonly string[], numbers: readonly number[], from: number, rows: Int32Array, length: number): { slot: Slot; column: Column } {
    const rules = new Map<string, number>();
    const list: [0 | 1, string][] = [];
    const codes = new Uint8Array(length);
    const held: string[] = Array.from({ length }, () => '');
    strings.forEach((s, i) => {
      const rule = ruleOf(s, numbers[i]!);
      let code: number | undefined;
      if (rule !== null) {
        const name = `${rule[0]}${rule[1]}`;
        code = rules.get(name);
        if (code === undefined && list.length < MAX_RULES) {
          rules.set(name, (code = list.length));
          list.push(rule);
        }
      }
      if (code === undefined) {
        codes[rows[i]!] = HELD;
        held[rows[i]!] = s;
      } else codes[rows[i]!] = code;
    });
    return {
      slot: { v: [{ k: 'str', derive: { from, rules: list } }] },
      column: struct(['v0'], [struct(['d', 'h'], [uint8Column(codes), utf8Column(held)], length)], length),
    };
  }

  table(root: string, keys: readonly string[], values: readonly unknown[], positions: Int32Array): Uint8Array {
    this.stats.tables += 1;
    this.stats.values += values.length;
    const n = keys.length;
    const key = keyColumn(keys, (strings) => this.dictionary(strings));
    // A table's positions rise, so each is stored as the gap from the row
    // before, the first from zero.
    const gaps = new Int32Array(n);
    for (let row = 0; row < n; row += 1) gaps[row] = positions[row]! - (row === 0 ? 0 : positions[row - 1]!);
    const built = this.slot(values, null, n, 0);
    const columns: [string, Column][] = [
      ['key', key.column],
      ['ordGap', int32Column(gaps)],
      ['r', built.column],
    ];
    const meta: TableMeta = { root, key: key.meta, slot: built.slot };
    const fields = columns.map(([name, c]) => new Field(name, c[0], false));
    const schema = new Schema(fields, new Map([[TABLE_META_KEY, JSON.stringify(meta)]]));
    const data = makeData({
      type: new Struct(fields),
      length: n,
      children: columns.map(([, c]) => c[1]),
    } as Parameters<typeof makeData>[0]);
    return tableToIPC(new Table([new RecordBatch(schema, data as never)]), 'file');
  }
}

/** `s` as `String(n)`, upper-cased or not, plus a short suffix; or null. */
function ruleOf(s: string, n: number): [0 | 1, string] | null {
  const plain = String(n);
  if (s.startsWith(plain) && s.length - plain.length <= MAX_SUFFIX) return [0, s.slice(plain.length)];
  const upper = plain.toUpperCase();
  if (upper !== plain && s.startsWith(upper) && s.length - upper.length <= MAX_SUFFIX) return [1, s.slice(upper.length)];
  return null;
}

/** The rows `derivations` reads across every pair of a string field and a
 *  number field together, so an object with many fields costs a smaller
 *  sample rather than a longer encode. A smaller sample only decides which
 *  fields are derived; a row no rule derives is held either way. */
const DERIVATION_SAMPLE_BUDGET = 200_000;
const DERIVATION_SAMPLE_MIN = 16;

/** Which string fields derive from which number field: a field of strings
 *  that differ, beside a field of numbers that differ, where a rule derives at
 *  least half the strings of a sample. */
function derivations(fields: readonly unknown[][]): Map<number, number> {
  const out = new Map<number, number>();
  const kinds = fields.map((values) => {
    const first = values[0];
    if (values.every((v) => v === first)) return null;
    if (values.every((v) => typeof v === 'number')) return 'num';
    if (values.every((v) => typeof v === 'string' && wellFormed(v))) return 'str';
    return null;
  });
  const strs = kinds.reduce((n, k) => n + (k === 'str' ? 1 : 0), 0);
  const nums = kinds.reduce((n, k) => n + (k === 'num' ? 1 : 0), 0);
  if (strs === 0 || nums === 0) return out;
  const sample = Math.min(
    fields[0]!.length,
    1000,
    Math.max(DERIVATION_SAMPLE_MIN, Math.floor(DERIVATION_SAMPLE_BUDGET / (strs * nums))),
  );
  kinds.forEach((k, s) => {
    if (k !== 'str') return;
    let best = -1;
    let bestHits = 0;
    kinds.forEach((kn, n) => {
      if (kn !== 'num') return;
      let hits = 0;
      for (let i = 0; i < sample; i += 1) {
        if (ruleOf(fields[s]![i] as string, fields[n]![i] as number) !== null) hits += 1;
      }
      if (hits * 2 >= sample && hits > bestHits) {
        best = n;
        bestHits = hits;
      }
    });
    if (best >= 0) out.set(s, best);
  });
  return out;
}

/** Separators `keySeparator` tries, so its cost stays linear in the keys. */
const MAX_SEPARATOR_CANDIDATES = 8;

/** The separator that splits every key in two at its first occurrence with
 *  the fewest distinct halves, where the halves number at most half the keys;
 *  or null. Only a character that is not a letter or digit is tried, from the
 *  first `MAX_SEPARATOR_CANDIDATES` of the first key. A key splits at its
 *  first separator, so its first half never contains one and the join
 *  restores it exactly. */
function keySeparator(keys: readonly string[]): string | null {
  if (keys.length < 2) return null;
  const candidates = [...new Set(keys[0]!)]
    .filter((c) => !/[\p{L}\p{N}]/u.test(c))
    .slice(0, MAX_SEPARATOR_CANDIDATES);
  const limit = keys.length / 2;
  let best: { sep: string; distinct: number } | null = null;
  for (const sep of candidates) {
    const a = new Set<string>();
    const b = new Set<string>();
    let ok = true;
    for (const k of keys) {
      const at = k.indexOf(sep);
      if (at === -1) {
        ok = false;
        break;
      }
      a.add(k.slice(0, at));
      b.add(k.slice(at + sep.length));
      // Past half the keys, this separator cannot qualify.
      if (a.size + b.size > limit) {
        ok = false;
        break;
      }
    }
    const distinct = a.size + b.size;
    if (ok && (best === null || distinct < best.distinct)) best = { sep, distinct };
  }
  return best?.sep ?? null;
}

/** Keys as int32 under a shared prefix where each is that prefix and a
 *  canonical non-negative integer; as two dictionary halves where a separator
 *  at least halves the distinct values; else as utf8 text, or JSON text where
 *  a key is not well formed. */
function keyColumn(keys: readonly string[], dictionary: (s: (string | undefined)[]) => Column): { meta: KeyMeta; column: Column } {
  const split = (k: string): [string, string] => {
    let at = k.length;
    while (at > 0 && k.charCodeAt(at - 1) >= 48 && k.charCodeAt(at - 1) <= 57) at -= 1;
    return [k.slice(0, at), k.slice(at)];
  };
  if (keys.length > 0) {
    const prefix = split(keys[0]!)[0];
    const ids = new Int32Array(keys.length);
    const fits = keys.every((k, row) => {
      const [p, digits] = split(k);
      if (p !== prefix || digits === '') return false;
      const n = Number(digits);
      if (n > 0x7fffffff || String(n) !== digits) return false;
      ids[row] = n;
      return true;
    });
    if (fits && wellFormed(prefix)) return { meta: { prefix }, column: int32Column(ids) };
  }
  if (!keys.every((k) => wellFormed(k))) {
    return { meta: { json: true }, column: utf8Column(keys.map((k) => JSON.stringify(k))) };
  }
  const sep = keySeparator(keys);
  if (sep !== null) {
    const halves = keys.map((k) => k.indexOf(sep));
    return {
      meta: { split: sep },
      column: struct(
        ['a', 'b'],
        [dictionary(keys.map((k, i) => k.slice(0, halves[i]))), dictionary(keys.map((k, i) => k.slice(halves[i]! + sep.length)))],
        keys.length,
      ),
    };
  }
  return { meta: { text: true }, column: utf8Column(keys) };
}

// --- grouping ------------------------------------------------------------

/** A chunk's entries grouped into tables: each table's members as indices
 *  into the chunk, rising. */
function tablesOf(values: readonly unknown[]): number[][] {
  const groups = [...groupBy(values, true).values()];
  const out: number[][] = [];
  for (const members of groups) {
    const head = values[members[0]!];
    const split = kindOf(head) === 'obj' ? discriminate(values as readonly Obj[], members) : null;
    if (split === null) out.push(members);
    else for (const part of split) out.push(part);
  }
  // Tables averaging fewer than MIN_TABLE_ROWS rows (objects whose key sets
  // barely repeat) cost a schema each, so the chunk is then one table.
  if (out.length > MAX_TABLES || out.length * MIN_TABLE_ROWS > values.length) return [values.map((_, i) => i)];
  return out;
}

/** The group split by the string field with the fewest distinct values,
 *  where that is between 2 and an eighth of the group; or null. */
function discriminate(values: readonly Obj[], members: readonly number[]): number[][] | null {
  const limit = Math.min(MAX_TABLES, Math.max(2, Math.floor(members.length / 8)));
  let best: Map<string, number[]> | null = null;
  for (const key of Object.keys(values[members[0]!]!)) {
    const parts = new Map<string, number[]>();
    let ok = true;
    for (const i of members) {
      const v = values[i]![key];
      if (typeof v !== 'string') {
        ok = false;
        break;
      }
      let list = parts.get(v);
      if (list === undefined) {
        if (parts.size >= limit) {
          ok = false;
          break;
        }
        parts.set(v, (list = []));
      }
      list.push(i);
    }
    if (ok && parts.size >= 2 && (best === null || parts.size < best.size)) best = parts;
  }
  return best === null ? null : [...best.values()];
}

// --- importer output as JSON ---------------------------------------------

const OMIT: unique symbol = Symbol('omit');

/**
 * `JSON.parse(JSON.stringify(value))`, without the text: `toJSON` is called
 * with the key JSON would pass, boxed primitives unwrap, a non-finite number
 * and -0 read as JSON writes them, and a member JSON drops is dropped (null
 * in an array). Throws where `JSON.stringify` throws on a BigInt.
 */
export function jsonValue(value: unknown, key = ''): unknown {
  const out = plain(value, key);
  return out === OMIT ? null : out;
}

function plain(value: unknown, key: string | number): unknown {
  if (
    (typeof value === 'object' && value !== null) ||
    typeof value === 'function' ||
    typeof value === 'bigint'
  ) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      value = (toJSON as (k: string) => unknown).call(value, String(key));
    }
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
    case 'bigint':
      throw new TypeError('Do not know how to serialize a BigInt');
    case 'object':
      break;
    default:
      return OMIT;
  }
  if (value === null) return null;
  // A subtree JSON would write unchanged is kept as it is, and a container is
  // copied only once a member reads differently, so a body an importer built
  // as plain JSON is not built twice.
  if (Array.isArray(value)) {
    const n = value.length;
    let out: unknown[] | null = Object.getPrototypeOf(value) === Array.prototype ? null : [];
    for (let i = 0; i < n; i += 1) {
      const item: unknown = value[i];
      let read = plain(item, i);
      if (read === OMIT) read = null;
      if (out === null) {
        if (Object.is(read, item)) continue;
        out = Array.prototype.slice.call(value, 0, i) as unknown[];
      }
      out.push(read);
    }
    return out ?? value;
  }
  if (value instanceof Number) return plain(Number(value), key);
  if (value instanceof String) return String(value);
  if (value instanceof Boolean) return value.valueOf();
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  let out: Record<string, unknown> | null = Object.getPrototypeOf(source) === Object.prototype ? null : {};
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i]!;
    const member: unknown = source[k];
    const read = plain(member, k);
    if (out === null) {
      if (Object.is(read, member)) continue;
      out = {};
      for (let j = 0; j < i; j += 1) define(out, keys[j]!, source[keys[j]!]);
    }
    if (read !== OMIT) define(out, k, read);
  }
  return out ?? source;
}

function define(out: Record<string, unknown>, k: string, value: unknown): void {
  if (k === '__proto__') {
    Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
  } else {
    out[k] = value;
  }
}

/** The length of `JSON.stringify(value)` for a value `jsonValue` returned. */
export function jsonLength(value: unknown): number {
  switch (typeof value) {
    case 'string':
      return quotedLength(value);
    case 'number':
      return String(value).length;
    case 'boolean':
      return value ? 4 : 5;
    default:
      break;
  }
  if (value === null) return 4;
  if (Array.isArray(value)) {
    let n = 2 + Math.max(0, value.length - 1);
    for (const item of value) n += jsonLength(item);
    return n;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  let n = 2 + Math.max(0, keys.length - 1);
  for (const k of keys) n += quotedLength(k) + 1 + jsonLength(object[k]);
  return n;
}

function quotedLength(s: string): number {
  let n = 2;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) {
      n += 2;
    } else if (c < 0x20) {
      n += 6;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 2;
        i += 1;
      } else {
        n += 6;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      n += 6;
    } else {
      n += 1;
    }
  }
  return n;
}

// --- the frame -----------------------------------------------------------

function packParts(parts: readonly [string, Uint8Array][]): Uint8Array {
  const head = utf8.encode(JSON.stringify(parts.map(([n, b]) => [n, b.byteLength])));
  const out = new Uint8Array(4 + head.byteLength + parts.reduce((n, [, b]) => n + b.byteLength, 0));
  new DataView(out.buffer).setUint32(0, head.byteLength, true);
  out.set(head, 4);
  let at = 4 + head.byteLength;
  for (const [, b] of parts) {
    out.set(b, at);
    at += b.byteLength;
  }
  return out;
}

/** A root as the encoder walks it: a map's entries in stored order. */
type SealedRoot =
  | { kind: 'map'; name: string; entries: Iterable<readonly [string, unknown]> }
  | { kind: 'list'; name: string; items: unknown[] }
  | { kind: 'list'; name: string; keysOf: string }
  | { kind: 'text'; name: string; text: string };

export interface SealedTablesOptions {
  chunkEntries?: number;
}

/** The uncompressed frame body: the manifest and every table's IPC file. */
export interface SealedTables {
  inner: Uint8Array;
  stats: SealedEncodeStats;
  encodeMs: number;
}

/**
 * Sealed content's tables.
 *
 * Walks each map once, in stored order, holding one chunk of its values at a
 * time. A key the content repeats keeps its first entry. The bytes depend on
 * the content alone.
 */
export function sealedTablesOfContent(
  content: SealedContent,
  options: SealedTablesOptions = {},
): SealedTables {
  function* roots(): Generator<SealedRoot> {
    for (const name of content.rootNames()) {
      const kind = content.kindOf(name);
      if (kind === 'map') {
        yield { kind: 'map', name, entries: content.mapRoot(name)!.entries() };
      } else if (kind === 'list') {
        const keysOf = content.keyWalkOf(name);
        yield keysOf !== null
          ? { kind: 'list', name, keysOf }
          : { kind: 'list', name, items: content.list(name) ?? [] };
      } else if (kind === 'text') {
        yield { kind: 'text', name, text: content.text(name) ?? '' };
      }
    }
  }
  return encodeRoots(roots(), content.builtBy(), options);
}

/** Sees every value an import's tables are built from, as it is read. */
export interface SealedValueObserver {
  /** A map above `UNPAGED_MAX_RECORDS`, before its values. */
  pagedMap?(records: number): void;
  /** A map value or a list item, and whether its map is paged. */
  value?(value: unknown, paged: boolean): void;
  text?(text: string): void;
}

/**
 * An importer's content, straight from the importer: the same tables
 * `sealedTablesOfContent` builds for the same content staged and decoded.
 *
 * Each value is read as `JSON.parse(JSON.stringify(value))` would read it
 * (`jsonValue`) when its chunk reaches it, and released from `content` once
 * read, so a value built lazily is built one chunk at a time.
 *
 * CONSUMES the map values.
 */
export function sealedTablesOfImport(
  content: SealedContentJson,
  builtBy?: SealedStoreBuiltBy,
  options: SealedTablesOptions & { observe?: SealedValueObserver } = {},
): SealedTables {
  return sealedTablesOfPlan(planSealedContent(content), builtBy, options);
}

/** A record store handed over as triples (`SealedStoreSource`): the tables
 *  `sealedTablesOfImport` builds for the same store's JSON. CONSUMES
 *  `source.records`. */
export function sealedTablesOfRecords(
  source: SealedStoreSource,
  options: SealedTablesOptions & { observe?: SealedValueObserver } = {},
): SealedTables {
  return sealedTablesOfPlan(planSealedStore(source), source.builtBy, options);
}

function sealedTablesOfPlan(
  plan: readonly RootPlan[],
  builtBy: SealedStoreBuiltBy | undefined,
  options: SealedTablesOptions & { observe?: SealedValueObserver },
): SealedTables {
  const observe = options.observe;
  function* mapEntries(entries: MapEntries): Generator<readonly [string, unknown]> {
    const paged = entries.keys.length > UNPAGED_MAX_RECORDS;
    if (paged) observe?.pagedMap?.(entries.keys.length);
    for (let i = 0; i < entries.keys.length; i += 1) {
      const value = jsonValue(entries.value(i));
      entries.release(i);
      observe?.value?.(value, paged);
      yield [entries.keys[i]!, value];
    }
  }
  function* roots(): Generator<SealedRoot> {
    for (const root of plan) {
      if (root.kind === 'map') {
        yield { kind: 'map', name: root.name, entries: mapEntries(root.entries) };
      } else if (root.kind === 'list') {
        if ('keysOf' in root) {
          yield root;
          continue;
        }
        const items = root.items.map((item, index) => {
          const value = jsonValue(item, String(index));
          observe?.value?.(value, false);
          return value;
        });
        yield { kind: 'list', name: root.name, items };
      } else {
        observe?.text?.(root.text);
        yield root;
      }
    }
  }
  return encodeRoots(roots(), builtBy ?? null, options);
}

function encodeRoots(
  sealedRoots: Iterable<SealedRoot>,
  by: SealedStoreBuiltBy | null,
  options: SealedTablesOptions,
): SealedTables {
  const chunkEntries = options.chunkEntries ?? SEALED_CHUNK_ENTRIES;
  const started = performance.now();
  const writer = new Writer();
  const roots: ArrowManifestRoot[] = [];
  const parts: [string, Uint8Array][] = [];
  let innerBytes = 0;
  // Refused as the tables are built, so content past what a reader decodes
  // stops before the rest of it is encoded.
  const pushTable = (bytes: Uint8Array): void => {
    innerBytes += bytes.byteLength;
    if (innerBytes > SEALED_INNER_MAX_BYTES) throw new SealedContentTooLargeError();
    parts.push([String(parts.length + 1), bytes]);
  };
  for (const root of sealedRoots) {
    const name = root.name;
    if (root.kind === 'map') {
      roots.push(['map', name]);
      const seen = new Set<string>();
      let keys: string[] = [];
      let values: unknown[] = [];
      let positions: number[] = [];
      let at = 0;
      const flush = (): void => {
        if (keys.length === 0) return;
        for (const members of tablesOf(values)) {
          pushTable(
            writer.table(
              name,
              members.map((i) => keys[i]!),
              members.map((i) => values[i]),
              Int32Array.from(members, (i) => positions[i]!),
            ),
          );
        }
        keys = [];
        values = [];
        positions = [];
      };
      for (const [key, value] of root.entries) {
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
        values.push(value);
        positions.push(at);
        at += 1;
        if (keys.length >= chunkEntries) flush();
      }
      flush();
      // An empty map is one table of no rows, so its root reads back.
      if (at === 0) pushTable(writer.table(name, [], [], new Int32Array(0)));
    } else if (root.kind === 'list') {
      roots.push('keysOf' in root ? ['list', name, null, root.keysOf] : ['list', name, root.items]);
    } else {
      roots.push(['text', name, root.text]);
    }
  }
  const manifest: ArrowManifest = [by !== null ? [by.id, by.version] : null, roots];
  const manifestBytes = utf8.encode(JSON.stringify(manifest));
  if (innerBytes + manifestBytes.byteLength > SEALED_INNER_MAX_BYTES) throw new SealedContentTooLargeError();
  const inner = packParts([[ARROW_MANIFEST_PART, manifestBytes], ...parts]);
  writer.stats.rawBytes = inner.byteLength;
  return { inner, stats: writer.stats, encodeMs: performance.now() - started };
}

/** The ZSTD level the stored form is compressed at. */
export const SEALED_ZSTD_LEVEL = 19;

interface NativeZstd {
  zstdCompressSync?(bytes: Uint8Array, options: unknown): Uint8Array;
  constants: Record<string, number>;
}

function nativeZstd(): NativeZstd | undefined {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
      .process;
    const zlib = proc?.getBuiltinModule?.('node:zlib') as NativeZstd | undefined;
    return zlib?.zstdCompressSync !== undefined ? zlib : undefined;
  } catch {
    return undefined;
  }
}

/** A frame body as frame 4, where the runtime carries a ZSTD compressor. */
export function zstdFrame(inner: Uint8Array): Uint8Array | null {
  const zlib = nativeZstd();
  if (zlib === undefined) return null;
  const compressed = zlib.zstdCompressSync!(inner, {
    params: {
      [zlib.constants.ZSTD_c_compressionLevel!]: SEALED_ZSTD_LEVEL,
      [zlib.constants.ZSTD_c_checksumFlag!]: 1,
    },
    pledgedSrcSize: inner.byteLength,
  });
  return arrowFrameBytes(new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return gzipSync(bytes);
}

/**
 * An importer's stream in the form its producer uploads: the stored frame
 * where the runtime compresses ZSTD (Node), else the same tables gzipped as
 * the staging frame, which the seal recompresses. Either way the platform
 * reads every value before it stores the line.
 *
 * CONSUMES the map values, as `sealedTablesOfImport` does.
 */
export async function encodeSealedUpload(
  content: SealedContentJson,
  builtBy?: SealedStoreBuiltBy,
  options: UploadOptions = {},
): Promise<Uint8Array> {
  return uploadFrame(sealedTablesOfImport(content, builtBy).inner, options);
}

export interface UploadOptions {
  /** Write the gzipped staging frame even where ZSTD is available. */
  staged?: boolean;
}

/** `encodeSealedUpload` for a record store handed over as triples. CONSUMES
 *  `source.records`. */
export async function encodeSealedRecordsUpload(
  source: SealedStoreSource,
  options: UploadOptions = {},
): Promise<Uint8Array> {
  return uploadFrame(sealedTablesOfRecords(source).inner, options);
}

async function uploadFrame(inner: Uint8Array, options: UploadOptions): Promise<Uint8Array> {
  const stored = options.staged === true ? null : zstdFrame(inner);
  return stored ?? arrowFrameBytes(await gzip(inner), VERSION_ARROW_STAGED);
}
