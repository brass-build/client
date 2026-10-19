// The shape of a document that references other documents: the references a
// key holds, the reserved CRDT roots they live in, the status the platform
// reports for a key, and the frames and bodies that carry it. This is the one
// definition; the platform's `@brass-build/contracts` re-exports it.
//
// The document's CRDT is the source of truth for each key's references and
// read marks. Nothing read out of the roots is authority: a reference's
// `organization_id` is a hint for resolving it and grants nothing.

import { sha256Hex } from './sha256.js';

// The narrowing a reference was chosen under, as `InputReferenceWire.accept`.
interface SelectionAccept {
  names?: readonly string[];
  extensions?: readonly string[];
  families?: readonly string[];
}

const DEFAULT_STREAM_NAME = 'default';

const NAME_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isNameToken(value: string): boolean {
  return NAME_TOKEN_PATTERN.test(value);
}

// A stored reference may carry its families as `types`, which reads the same.
function parseSelectionAccept(value: unknown): SelectionAccept | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const list = (v: unknown): readonly string[] | null => {
    if (!Array.isArray(v)) return null;
    const items = v.filter((x): x is string => typeof x === 'string' && x !== '');
    return items.length > 0 ? items : null;
  };
  const names = list(raw['names']);
  const extensions = list(raw['extensions']);
  const families = list(raw['families']) ?? list(raw['types']);
  if (!names && !extensions && !families) return null;
  return {
    ...(names ? { names } : {}),
    ...(extensions ? { extensions } : {}),
    ...(families ? { families } : {}),
  };
}

function documentTopic(docId: string, branchId: string): string {
  return `doc:${docId}:${branchId}`;
}

function parseDocTopic(topic: string): { docId: string; branchId: string } | null {
  const m = /^doc:(doc_[A-Za-z0-9_-]{32}):(b_[A-Za-z0-9_-]{32})$/.exec(topic);
  return m && m[1] && m[2] ? { docId: m[1], branchId: m[2] } : null;
}

// --- Identifiers -----------------------------------------------------------

const DOC_ID_PATTERN = /^doc_[A-Za-z0-9_-]{32}$/;
const LINE_ID_PATTERN = /^b_[A-Za-z0-9_-]{32}$/;
// Organization and project ids are opaque here; the shape only has to keep
// them safe inside a key or an identity string.
const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @internal */
export function isInputDocId(value: unknown): value is string {
  return typeof value === 'string' && DOC_ID_PATTERN.test(value);
}

/** @internal */
export function isInputLineId(value: unknown): value is string {
  return typeof value === 'string' && LINE_ID_PATTERN.test(value);
}

// --- Keys ------------------------------------------------------------------

/** @internal The longest key an app may record references under. */
export const INPUT_KEY_MAX_CHARS = 128;

/**
 * @internal
 * An app key: a letter or digit, then letters, digits and `._:@/+=~-`. `#`
 * is excluded because the key is the tail of a row's sort key, and so is
 * whitespace, which an app writing `stamp:${id}` never produces on purpose.
 */
export const INPUT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+=~-]{0,127}$/;

/** @internal Keys under this prefix are the platform's own, refused from an app. */
export const INPUT_KEY_RESERVED_PREFIX = 'brass:';

/** @internal */
export function isInputKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    INPUT_KEY_PATTERN.test(value) &&
    !value.toLowerCase().startsWith(INPUT_KEY_RESERVED_PREFIX)
  );
}

// --- References ------------------------------------------------------------

/** @internal How much a reference covers. */
export type InputReferenceExtent = 'organization' | 'project' | 'document';

/**
 * @internal
 * One reference a key holds: a file, a folder, a project or an organization,
 * as `Brass.chooseInputs` returned it, optionally naming one stream of a
 * document. `accept` is the narrowing it was chosen under, and two references
 * to one place under different narrowings are different references.
 */
export interface InputReferenceWire {
  organization_id: string;
  extent: InputReferenceExtent;
  project_id?: string;
  doc_id?: string;
  /** A stream of the referenced document. Absent means its default stream. */
  stream?: string;
  /** The name the picker showed. Display only, and not part of the identity. */
  label?: string;
  accept?: SelectionAccept;
}

/** @internal */
export const INPUT_REFERENCE_LABEL_MAX_CHARS = 256;

/**
 * @internal
 * Reads a reference off an untrusted value: the wire, or an entry a peer
 * wrote into the reserved roots. Null when it is not one.
 */
export function parseInputReference(raw: unknown): InputReferenceWire | null {
  if (!isRecord(raw)) return null;
  const extent = raw['extent'];
  const organizationId = raw['organization_id'];
  if (typeof organizationId !== 'string' || !ENTITY_ID_PATTERN.test(organizationId)) return null;
  const ref: InputReferenceWire = { organization_id: organizationId, extent: 'organization' };
  if (extent === 'document') {
    if (!isInputDocId(raw['doc_id'])) return null;
    ref.extent = 'document';
    ref.doc_id = raw['doc_id'];
    const stream = raw['stream'];
    if (stream !== undefined) {
      if (typeof stream !== 'string' || !isNameToken(stream)) return null;
      if (stream !== DEFAULT_STREAM_NAME) ref.stream = stream;
    }
  } else if (extent === 'project') {
    const projectId = raw['project_id'];
    if (typeof projectId !== 'string' || !ENTITY_ID_PATTERN.test(projectId)) return null;
    if (raw['stream'] !== undefined) return null;
    ref.extent = 'project';
    ref.project_id = projectId;
  } else if (extent === 'organization') {
    if (raw['stream'] !== undefined) return null;
  } else {
    return null;
  }
  // A project reference may also say which project a document sits in; the
  // identity reads only the field its extent names.
  if (ref.extent === 'document' && typeof raw['project_id'] === 'string') {
    if (!ENTITY_ID_PATTERN.test(raw['project_id'])) return null;
    ref.project_id = raw['project_id'];
  }
  const label = raw['label'];
  if (label !== undefined) {
    if (typeof label !== 'string' || label.length > INPUT_REFERENCE_LABEL_MAX_CHARS) return null;
    ref.label = label;
  }
  if (raw['accept'] !== undefined) {
    if (!isRecord(raw['accept'])) return null;
    // A narrowing with no clause narrows nothing, so it is the same
    // reference as one carrying none.
    const accept = parseSelectionAccept(raw['accept']);
    if (accept !== null) ref.accept = accept;
  }
  return ref;
}

function isEmptyAccept(accept: SelectionAccept): boolean {
  return !accept.families?.length && !accept.names?.length && !accept.extensions?.length;
}

// The narrowing as one canonical string: families and extensions compared
// case-insensitively, extensions without their dot, names case-insensitively
// (the match is), each list sorted and de-duplicated.
function canonicalAccept(accept: SelectionAccept): string {
  const norm = (xs: readonly string[] | undefined, strip = false) =>
    [...new Set((xs ?? []).map((x) => (strip ? x.replace(/^\./, '') : x).toLowerCase()))].sort();
  return JSON.stringify({
    t: norm(accept.families),
    e: norm(accept.extensions, true),
    n: norm(accept.names),
  });
}

/**
 * @internal
 * The reference's stable identity: the key it is stored under in the
 * references root, and what the platform's rows name it by.
 *
 * `d:<doc_id>`, `d:<doc_id>/<stream>`, `p:<project_id>` or
 * `o:<organization_id>`, followed by `~<16 hex>` when the reference carries a
 * narrowing. The label is not part of it, so renaming a choice does not make
 * it a different reference.
 */
export function inputReferenceId(ref: InputReferenceWire): string {
  let id: string;
  if (ref.extent === 'document') {
    id = `d:${ref.doc_id ?? ''}`;
    if (ref.stream !== undefined && ref.stream !== DEFAULT_STREAM_NAME) id += `/${ref.stream}`;
  } else if (ref.extent === 'project') {
    id = `p:${ref.project_id ?? ''}`;
  } else {
    id = `o:${ref.organization_id}`;
  }
  if (ref.accept && !isEmptyAccept(ref.accept)) {
    id += `~${sha256Hex(canonicalAccept(ref.accept)).slice(0, 16)}`;
  }
  return id;
}

const INPUT_REFERENCE_ID_PATTERN =
  /^(?:d:doc_[A-Za-z0-9_-]{32}(?:\/[a-z0-9][a-z0-9._-]{0,63})?|[po]:[A-Za-z0-9_-]{1,64})(?:~[0-9a-f]{16})?$/;

/** @internal */
export function isInputReferenceId(value: unknown): value is string {
  return typeof value === 'string' && INPUT_REFERENCE_ID_PATTERN.test(value);
}

/**
 * @internal
 * The hash of a reference set: what keys with identical references share one
 * resolution under. Order and duplicates do not move it, and neither does a
 * label.
 */
export function inputReferenceSetHash(refs: readonly InputReferenceWire[]): string {
  const ids = [...new Set(refs.map(inputReferenceId))].sort();
  return sha256Hex(`inputs-v1\n${ids.join('\n')}`);
}

const SET_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** @internal */
export function isInputReferenceSetHash(value: unknown): value is string {
  return typeof value === 'string' && SET_HASH_PATTERN.test(value);
}

// --- Limits ----------------------------------------------------------------

/**
 * @internal
 * The most distinct documents a document's keys report across all of them.
 * Past it the status says `truncated`; it is never a refusal.
 */
export const INPUT_DOCS_MAX = 2000;

/** @internal The most references one key may hold in a provisional body. */
export const INPUT_REFS_MAX_PER_KEY = 2000;

/** @internal The most read marks one key may carry in a provisional body. */
export const INPUT_READ_MARKS_MAX_PER_KEY = INPUT_DOCS_MAX;

/** @internal The longest version stamp a read mark or a file may carry. */
export const INPUT_STAMP_MAX_CHARS = 64;

// --- The reserved CRDT roots -------------------------------------------------

/**
 * @internal
 * The document roots holding every key's references and read marks. Both are
 * flat maps at the root: a root container's id is fixed by its name, so every
 * peer writes into the same container. A container created under a map entry
 * is not: two peers creating one concurrently make two, and the entry keeps
 * one of them, dropping the other's writes. So nothing here nests.
 *
 * The names sit outside both the `brass:` record-store key space and any name
 * an app passes to `doc.map`, so record paging and the frozen-to-CRDT
 * conversion, which walk app roots, never reach them.
 *
 * `INPUTS_REFS_ROOT`: `<key>␟<referenceId>` -> the reference.
 * `INPUTS_READ_ROOT`: `<key>␟<docId>␟<stamp>␟<kind>` -> true.
 */
export const INPUTS_REFS_ROOT = '__brass_input_refs';
/** @internal */
export const INPUTS_READ_ROOT = '__brass_input_read';

/**
 * @internal
 * Joins the parts of an entry key: U+241F SYMBOL FOR UNIT SEPARATOR, which no
 * app key, reference id, doc id or stamp can contain.
 */
export const INPUTS_ENTRY_SEPARATOR = '␟';
const SEP = INPUTS_ENTRY_SEPARATOR;

/** @internal */
export function inputRefEntryKey(key: string, refId: string): string {
  return `${key}${SEP}${refId}`;
}

/** @internal */
export function parseInputRefEntryKey(entryKey: string): { key: string; refId: string } | null {
  const parts = entryKey.split(SEP);
  if (parts.length !== 2) return null;
  const [key, refId] = parts;
  return isInputKey(key) && isInputReferenceId(refId) ? { key, refId } : null;
}

/** @internal Digits a stamp is zero-padded to in an entry key, so the keys sort by stamp. */
export const INPUT_STAMP_DIGITS = 16;

/**
 * @internal
 * A version of a document, as a read mark records it: the milliseconds since
 * the epoch of the `updated_at` the reader read the document at.
 */
export function inputStampFromUpdatedAt(updatedAt: string): number | null {
  const ms = Date.parse(updatedAt);
  return Number.isSafeInteger(ms) && ms >= 0 && ms < 10 ** INPUT_STAMP_DIGITS ? ms : null;
}

function isStamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < 10 ** INPUT_STAMP_DIGITS
  );
}

/**
 * @internal
 * What a reader acknowledged for one input document: that it read the
 * document at `stamp`, or (`removed`) that it was told the document stopped
 * being an input, `stamp` then being the last version it knew.
 *
 * Marks for one document order by stamp, and at one stamp a read follows a
 * removal, so a document that returns unchanged after its removal was
 * acknowledged is reported again and its next read settles it.
 */
export interface InputReadMark {
  stamp: number;
  removed: boolean;
}

const READ_KIND = { removed: '0', read: '1' } as const;

/** @internal */
export function inputReadEntryKey(key: string, docId: string, mark: InputReadMark): string {
  const stamp = String(mark.stamp).padStart(INPUT_STAMP_DIGITS, '0');
  const kind = mark.removed ? READ_KIND.removed : READ_KIND.read;
  return `${key}${SEP}${docId}${SEP}${stamp}${SEP}${kind}`;
}

/** @internal The prefix every read mark of one key shares, or of one document under it. */
export function inputReadEntryPrefix(key: string, docId?: string): string {
  return docId === undefined ? `${key}${SEP}` : `${key}${SEP}${docId}${SEP}`;
}

/** @internal */
export function parseInputReadEntryKey(
  entryKey: string,
): { key: string; docId: string; mark: InputReadMark } | null {
  const parts = entryKey.split(SEP);
  if (parts.length !== 4) return null;
  const [key, docId, stamp, kind] = parts as [string, string, string, string];
  if (!isInputKey(key) || !isInputDocId(docId)) return null;
  if (!new RegExp(`^[0-9]{${INPUT_STAMP_DIGITS}}$`).test(stamp)) return null;
  if (kind !== READ_KIND.removed && kind !== READ_KIND.read) return null;
  return { key, docId, mark: { stamp: Number(stamp), removed: kind === READ_KIND.removed } };
}

/**
 * @internal
 * The mark that acknowledges a file leaving a key, given the latest mark the
 * reader holds for it and the version it left at (`updatedAt` on the removed
 * entry; null when the entry carries none). The mark sits at that version, so
 * a read of the file returning at it follows the removal. When the version
 * did not move past the reader's last read, the removal has to sit one stamp
 * past that read to follow it, and `inputReadMarkFor` lifts a later read of
 * the returning file to the removal's stamp. A removal already acknowledged
 * keeps its mark.
 */
export function inputRemovalMark(
  latest: InputReadMark | null,
  updatedAt: string | null,
): InputReadMark {
  if (latest?.removed === true) return latest;
  const leftAt = updatedAt === null ? null : inputStampFromUpdatedAt(updatedAt);
  const floor = latest === null ? 0 : latest.stamp + 1;
  return { stamp: Math.max(leftAt ?? 0, floor), removed: true };
}

/**
 * @internal
 * The mark that records reading a file at `stamp`, given the latest mark the
 * reader holds for it: at `stamp`, or at a removal's stamp when that removal
 * sits past it, which is the one stamp a read can take to follow it.
 */
export function inputReadMarkFor(latest: InputReadMark | null, stamp: number): InputReadMark {
  if (latest?.removed === true && latest.stamp > stamp) return { stamp: latest.stamp, removed: false };
  return { stamp, removed: false };
}

/** @internal Whether `a` is a later acknowledgement than `b`. */
export function inputReadMarkAfter(a: InputReadMark, b: InputReadMark): boolean {
  if (a.stamp !== b.stamp) return a.stamp > b.stamp;
  return !a.removed && b.removed;
}

/** @internal */
export function parseInputReadMark(raw: unknown): InputReadMark | null {
  if (!isRecord(raw) || !isStamp(raw['stamp']) || typeof raw['removed'] !== 'boolean') return null;
  return { stamp: raw['stamp'], removed: raw['removed'] };
}

/** @internal One key's references and read marks, as decoded off the two roots. */
export interface InputsKeyState {
  /** Sorted by reference id, so two peers' decodes compare equal. */
  refs: InputReferenceWire[];
  /** The latest mark per document. */
  read: Record<string, InputReadMark>;
}

/**
 * @internal
 * Every key holding references, from the two roots' plain-object forms.
 * Tolerant, since peers write the roots: an entry whose key does not parse,
 * whose value is not a reference, or whose reference id does not match the
 * one re-derived from its value is dropped rather than failing the read. A
 * read mark is kept only when present (`true`), and only the latest per
 * document counts. Keys with no references are absent, along with their
 * marks.
 */
export function decodeInputsRoots(refsRoot: unknown, readRoot: unknown): Map<string, InputsKeyState> {
  const refsByKey = new Map<string, Map<string, InputReferenceWire>>();
  if (isRecord(refsRoot)) {
    for (const [entryKey, value] of Object.entries(refsRoot)) {
      const parsed = parseInputRefEntryKey(entryKey);
      const ref = parseInputReference(value);
      if (parsed === null || ref === null || inputReferenceId(ref) !== parsed.refId) continue;
      const held = refsByKey.get(parsed.key) ?? new Map<string, InputReferenceWire>();
      held.set(parsed.refId, ref);
      refsByKey.set(parsed.key, held);
    }
  }
  const out = new Map<string, InputsKeyState>();
  for (const key of [...refsByKey.keys()].sort()) {
    const held = refsByKey.get(key)!;
    const refs = [...held.keys()].sort().map((id) => held.get(id)!);
    out.set(key, { refs, read: {} });
  }
  if (isRecord(readRoot)) {
    for (const [entryKey, value] of Object.entries(readRoot)) {
      if (value !== true) continue;
      const parsed = parseInputReadEntryKey(entryKey);
      const state = parsed ? out.get(parsed.key) : undefined;
      if (!parsed || !state) continue;
      const prior = state.read[parsed.docId];
      if (!prior || inputReadMarkAfter(parsed.mark, prior)) state.read[parsed.docId] = parsed.mark;
    }
  }
  return out;
}

/**
 * @internal
 * The writes one root takes: entries to set and entry keys to delete. Every
 * write is per entry, so a concurrent writer's other entries survive.
 */
export interface InputsRootWrites<V> {
  set: Record<string, V>;
  delete: string[];
}

/**
 * @internal
 * The writes that make `key`'s references `next` (null clears the key), given
 * the refs root as this writer sees it. Only the difference is written:
 * entries this writer did not see are not touched, so a reference another
 * peer adds concurrently survives. Throws on a reference that would not
 * decode.
 */
export function inputRefsWrites(
  refsRoot: Readonly<Record<string, unknown>>,
  key: string,
  next: readonly InputReferenceWire[] | null,
): InputsRootWrites<InputReferenceWire> {
  if (!isInputKey(key)) throw new TypeError('Not a valid input key');
  const wanted = new Map<string, InputReferenceWire>();
  for (const ref of next ?? []) {
    const parsed = parseInputReference(ref);
    if (parsed === null) throw new TypeError('Not a valid input reference');
    wanted.set(inputRefEntryKey(key, inputReferenceId(parsed)), parsed);
  }
  const writes: InputsRootWrites<InputReferenceWire> = { set: {}, delete: [] };
  for (const entryKey of Object.keys(refsRoot).sort()) {
    if (parseInputRefEntryKey(entryKey)?.key === key && !wanted.has(entryKey)) {
      writes.delete.push(entryKey);
    }
  }
  for (const entryKey of [...wanted.keys()].sort()) {
    const ref = wanted.get(entryKey)!;
    if (!sameJson(refsRoot[entryKey], ref)) writes.set[entryKey] = ref;
  }
  return writes;
}

/**
 * @internal
 * The writes that record `mark` for `docId` under `key`, given the read root
 * as this writer sees it: the mark's entry, and the deletion of every earlier
 * mark for that document. A later mark already present is left in place, and
 * still wins.
 */
export function inputReadMarkWrites(
  readRoot: Readonly<Record<string, unknown>>,
  key: string,
  docId: string,
  mark: InputReadMark,
): InputsRootWrites<true> {
  if (!isInputKey(key) || !isInputDocId(docId) || parseInputReadMark(mark) === null) {
    throw new TypeError('Not a valid read mark');
  }
  const own = inputReadEntryKey(key, docId, mark);
  const writes: InputsRootWrites<true> = { set: {}, delete: [] };
  for (const entryKey of Object.keys(readRoot).sort()) {
    const parsed = parseInputReadEntryKey(entryKey);
    if (parsed?.key === key && parsed.docId === docId && inputReadMarkAfter(mark, parsed.mark)) {
      writes.delete.push(entryKey);
    }
  }
  if (readRoot[own] !== true) writes.set[own] = true;
  return writes;
}

/** @internal The writes that clear every read mark under `key`, as when the key is cleared. */
export function inputReadClearWrites(
  readRoot: Readonly<Record<string, unknown>>,
  key: string,
): InputsRootWrites<true> {
  const prefix = inputReadEntryPrefix(key);
  return { set: {}, delete: Object.keys(readRoot).filter((k) => k.startsWith(prefix)).sort() };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Status (GET) -----------------------------------------------------------

export type InputFileChange = 'added' | 'modified' | 'removed';

/** @internal */
export const INPUT_FILE_CHANGES: readonly InputFileChange[] = ['added', 'modified', 'removed'];

/**
 * @internal
 * One input file as it is now. `name` is the document's name; `from` names
 * the key's references that include it by `inputReferenceId`, nearest first;
 * `ref` is a reference to this one file.
 */
export interface InputStatusFileWire {
  doc_id: string;
  name: string;
  /** The file's family, absent on a document that has none. */
  schema_type?: string;
  updated_at: string;
  from: string[];
  ref: InputReferenceWire;
  /** Present while an app imports the file and has not yet: the file is
   *  stored or on its way, and no import of it ran or failed. A reader that
   *  is not that app is refused `not_imported` while it is present. */
  awaits_import?: true;
}

/**
 * @internal
 * One file the reader has not read at its current version. `from` is as on a
 * file; a removed file's names the references that included it, and is empty
 * when none still exists. `key` is present in the keyless status.
 *
 * `updated_at` is present on a `removed` entry: the version the file left the
 * key at, which is the latest version either the platform or this reader's
 * read mark knew. A reader acknowledges the removal with a mark at that
 * version (`inputRemovalMark`), so a file that returns at it is reported
 * again and its next read settles it.
 */
export interface InputStatusChangeWire {
  doc_id: string;
  change: InputFileChange;
  from: string[];
  key?: string;
  updated_at?: string;
}

/** @internal One key's status, as `GET` answers it and the SDK hands an app. */
export interface InputStatusWire {
  key: string;
  refs: InputReferenceWire[];
  files: InputStatusFileWire[];
  changed: InputStatusChangeWire[];
  /** Input files this reader cannot reach. They are counted, never reported removed. */
  hidden_count: number;
  /** The document's keys reached more than `INPUT_DOCS_MAX` documents. */
  truncated: boolean;
  /** Moves every time anything in this status moves. */
  rev: number;
  /**
   * Present, and true, when the platform cannot vouch that the references
   * and read marks above reflect the document: ops are sequenced past the
   * last projection and the projection is blocked (the branch refuses
   * writes) or did not finish, or the key's row holds a provisional write
   * the projection has already passed. The answer is the last one the
   * platform recorded rather than a wrong one, and it clears once a
   * projection completes.
   */
  stale?: boolean;
  /**
   * Present, and true, while a place one of the key's references names is
   * still receiving its files: a drive connected there has not finished
   * listing them. `files` and `changed` hold the ones that have arrived.
   */
  arriving?: boolean;
}

/**
 * @internal
 * One page of the keyless status: a run of the document's keys in key order,
 * and each one's changed files. `hidden_count` and `truncated` cover the
 * page; `truncated` is also set when the page's changed entries were cut at
 * `INPUT_KEYS_CHANGED_MAX`. `cursor` resumes after the page's last key, or is
 * null on the last page.
 */
export interface InputStatusAll {
  keys: string[];
  changed: Array<InputStatusChangeWire & { key: string }>;
  hidden_count: number;
  truncated: boolean;
  rev: number;
  /** As on `InputStatusWire`, for any of the document's keys on the line. */
  stale?: boolean;
  cursor: string | null;
}

/**
 * @internal
 * What the keyless status answers to a cursor pinned to a revision the
 * document's keys have since moved past. The reader starts again.
 */
export interface InputStatusAllResync {
  rev: number;
  resync: true;
}

/** @internal The most keys one page of the keyless status carries. */
export const INPUT_KEYS_PAGE_SIZE = 50;
/** @internal The most changed entries one page of the keyless status carries. */
export const INPUT_KEYS_CHANGED_MAX = INPUT_DOCS_MAX;

/**
 * @internal
 * One page of a key's full status. A page covers a range of document ids:
 * `files` and `changed` hold the entries inside it, in ascending doc id
 * order, and `cursor` resumes after it, or is null on the last page.
 */
export interface InputStatusPage extends InputStatusWire {
  cursor: string | null;
}

/** @internal Query parameters on `GET` of a key's status. */
export const INPUT_STATUS_SINCE_PARAM = 'since_rev';
/** @internal */
export const INPUT_STATUS_CURSOR_PARAM = 'cursor';
/**
 * @internal
 * The line whose keys a `GET` reads: a branch or a stream of the document,
 * named as a document join names it. Absent reads the document's default
 * branch.
 */
export const INPUT_STATUS_LINE_PARAM = 'branch';
/** @internal The most documents one page or one delta carries. */
export const INPUT_STATUS_PAGE_SIZE = 500;

/**
 * @internal
 * A page cursor: the revision the first page answered at and the last doc id
 * the previous page held. Pinning the revision is what keeps a paged read
 * consistent; a server whose status moved since answers a resync, and the
 * reader starts again.
 */
export function encodeInputStatusCursor(cursor: { rev: number; after: string }): string {
  return `${cursor.rev}.${cursor.after}`;
}

/**
 * @internal
 * A keyless status cursor: `encodeInputStatusCursor` over the revision the
 * first page answered at and the last key the previous page held.
 */
export function decodeInputKeysCursor(raw: unknown): { rev: number; after: string } | null {
  if (typeof raw !== 'string') return null;
  const m = /^(0|[1-9][0-9]{0,14})\.(.+)$/s.exec(raw);
  if (!m || !m[1] || !m[2] || !isInputKey(m[2])) return null;
  return { rev: Number(m[1]), after: m[2] };
}

/** @internal */
export function decodeInputStatusCursor(raw: unknown): { rev: number; after: string } | null {
  if (typeof raw !== 'string') return null;
  const m = /^(0|[1-9][0-9]{0,14})\.(doc_[A-Za-z0-9_-]{32})$/.exec(raw);
  if (!m || !m[1] || !m[2]) return null;
  return { rev: Number(m[1]), after: m[2] };
}

/**
 * @internal
 * What `GET ?since_rev=<n>` answers when it can: what moved between `since_rev`
 * and `rev`. Upserts replace the entry with the same doc id; removes name doc
 * ids. `refs` is present only when the key's references moved.
 */
export interface InputStatusDelta {
  key: string;
  since_rev: number;
  rev: number;
  refs?: InputReferenceWire[];
  files: { upsert: InputStatusFileWire[]; remove: string[] };
  changed: { upsert: InputStatusChangeWire[]; remove: string[] };
  hidden_count: number;
  truncated: boolean;
  /** As on `InputStatusWire`; the status a delta moves to carries it or drops it. */
  stale?: boolean;
  /** As on `InputStatusWire`, carried or dropped the same way. */
  arriving?: boolean;
}

/**
 * @internal
 * What `GET ?since_rev=<n>` answers when it cannot describe the gap (the
 * revision is older than what the server keeps, or the delta would exceed a
 * page). The reader pages the full status.
 */
export interface InputStatusResync {
  key: string;
  rev: number;
  resync: true;
}

/**
 * @internal
 * The status a delta moves `status` to, or null when the delta does not start
 * at `status.rev` (a gap, which the reader closes by fetching again).
 */
export function applyInputStatusDelta(
  status: InputStatusWire,
  delta: InputStatusDelta,
): InputStatusWire | null {
  if (delta.key !== status.key || delta.since_rev !== status.rev) return null;
  return {
    key: status.key,
    refs: delta.refs ?? status.refs,
    files: applyUpserts(status.files, delta.files),
    changed: applyUpserts(status.changed, delta.changed),
    hidden_count: delta.hidden_count,
    truncated: delta.truncated,
    rev: delta.rev,
    ...(delta.stale === true ? { stale: true } : {}),
    ...(delta.arriving === true ? { arriving: true } : {}),
  };
}

function applyUpserts<T extends { doc_id: string }>(
  current: readonly T[],
  diff: { upsert: readonly T[]; remove: readonly string[] },
): T[] {
  const byId = new Map(current.map((e) => [e.doc_id, e]));
  for (const id of diff.remove) byId.delete(id);
  for (const e of diff.upsert) byId.set(e.doc_id, e);
  return [...byId.values()].sort((a, b) => (a.doc_id < b.doc_id ? -1 : a.doc_id > b.doc_id ? 1 : 0));
}

/** @internal Reads a key's status (or a page of one) off the wire. Null when malformed. */
export function parseInputStatus(raw: unknown): InputStatusWire | null {
  if (!isRecord(raw) || !isInputKey(raw['key'])) return null;
  const refs = parseList(raw['refs'], parseInputReference);
  const files = parseList(raw['files'], parseInputStatusFile);
  const changed = parseList(raw['changed'], parseInputStatusChange);
  const counts = parseCounts(raw);
  const stale = parseStale(raw);
  const arriving = parseArriving(raw);
  if (refs === null || files === null || changed === null || counts === null || stale === null || arriving === null) {
    return null;
  }
  return { key: raw['key'], refs, files, changed, ...counts, ...stale, ...arriving };
}

/** @internal */
export function parseInputStatusPage(raw: unknown): InputStatusPage | null {
  const status = parseInputStatus(raw);
  if (status === null || !isRecord(raw)) return null;
  const cursor = raw['cursor'];
  if (cursor !== null && decodeInputStatusCursor(cursor) === null) return null;
  return { ...status, cursor: cursor as string | null };
}

/** @internal Reads a keyless status page, or the resync a moved cursor draws. Null when malformed. */
export function parseInputStatusAll(raw: unknown): InputStatusAll | InputStatusAllResync | null {
  if (!isRecord(raw)) return null;
  if (raw['resync'] === true) return isRev(raw['rev']) ? { rev: raw['rev'], resync: true } : null;
  const cursor = raw['cursor'] ?? null;
  if (cursor !== null && decodeInputKeysCursor(cursor) === null) return null;
  const keys = raw['keys'];
  if (!Array.isArray(keys) || !keys.every(isInputKey)) return null;
  const changed = parseList(raw['changed'], parseInputStatusChange);
  const counts = parseCounts(raw);
  const stale = parseStale(raw);
  if (changed === null || counts === null || stale === null) return null;
  const keyed: Array<InputStatusChangeWire & { key: string }> = [];
  for (const c of changed) {
    if (c.key === undefined) return null;
    keyed.push({ ...c, key: c.key });
  }
  return { keys: [...keys], changed: keyed, ...counts, ...stale, cursor: cursor as string | null };
}

/** @internal Reads a `since_rev` answer: a delta, a resync, or null when malformed. */
export function parseInputStatusDelta(raw: unknown): InputStatusDelta | InputStatusResync | null {
  if (!isRecord(raw) || !isInputKey(raw['key'])) return null;
  const rev = raw['rev'];
  if (!isRev(rev)) return null;
  if (raw['resync'] === true) return { key: raw['key'], rev, resync: true };
  const since = raw['since_rev'];
  if (!isRev(since) || since > rev) return null;
  const files = parseDiff(raw['files'], parseInputStatusFile);
  const changed = parseDiff(raw['changed'], parseInputStatusChange);
  const counts = parseCounts(raw);
  const stale = parseStale(raw);
  const arriving = parseArriving(raw);
  if (files === null || changed === null || counts === null || stale === null || arriving === null) return null;
  const delta: InputStatusDelta = {
    key: raw['key'],
    since_rev: since,
    rev,
    files,
    changed,
    hidden_count: counts.hidden_count,
    truncated: counts.truncated,
    ...stale,
    ...arriving,
  };
  if (raw['refs'] !== undefined) {
    const refs = parseList(raw['refs'], parseInputReference);
    if (refs === null) return null;
    delta.refs = refs;
  }
  return delta;
}

function parseInputStatusFile(raw: unknown): InputStatusFileWire | null {
  if (!isRecord(raw) || !isInputDocId(raw['doc_id'])) return null;
  const updatedAt = raw['updated_at'];
  if (typeof updatedAt !== 'string' || updatedAt.length > INPUT_STAMP_MAX_CHARS) return null;
  const name = raw['name'];
  if (typeof name !== 'string') return null;
  const from = parseFrom(raw['from']);
  const ref = parseInputReference(raw['ref']);
  if (from === null || ref === null) return null;
  const schemaType = raw['schema_type'];
  if (schemaType !== undefined && typeof schemaType !== 'string') return null;
  const awaitsImport = raw['awaits_import'];
  if (awaitsImport !== undefined && awaitsImport !== true) return null;
  return {
    doc_id: raw['doc_id'],
    name,
    ...(schemaType !== undefined ? { schema_type: schemaType } : {}),
    updated_at: updatedAt,
    from,
    ref,
    ...(awaitsImport === true ? { awaits_import: true as const } : {}),
  };
}

function parseInputStatusChange(raw: unknown): InputStatusChangeWire | null {
  if (!isRecord(raw) || !isInputDocId(raw['doc_id'])) return null;
  const change = raw['change'];
  if (!INPUT_FILE_CHANGES.includes(change as InputFileChange)) return null;
  const from = parseFrom(raw['from']);
  if (from === null) return null;
  const out: InputStatusChangeWire = { doc_id: raw['doc_id'], change: change as InputFileChange, from };
  if (raw['key'] !== undefined) {
    if (!isInputKey(raw['key'])) return null;
    out.key = raw['key'];
  }
  if (raw['updated_at'] !== undefined) {
    const at = raw['updated_at'];
    if (typeof at !== 'string' || at.length > INPUT_STAMP_MAX_CHARS) return null;
    out.updated_at = at;
  }
  return out;
}

function parseFrom(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.every(isInputReferenceId) ? [...raw] : null;
}

function parseCounts(
  raw: Record<string, unknown>,
): { hidden_count: number; truncated: boolean; rev: number } | null {
  const hidden = raw['hidden_count'];
  const truncated = raw['truncated'];
  const rev = raw['rev'];
  if (!isRev(hidden) || typeof truncated !== 'boolean' || !isRev(rev)) return null;
  return { hidden_count: hidden, truncated, rev };
}

// `stale` is optional on the wire and carried only when true.
function parseStale(raw: Record<string, unknown>): { stale?: true } | null {
  const stale = raw['stale'];
  if (stale === undefined || stale === false) return {};
  return stale === true ? { stale: true } : null;
}

// `arriving` is optional on the wire and carried only when true.
function parseArriving(raw: Record<string, unknown>): { arriving?: true } | null {
  const arriving = raw['arriving'];
  if (arriving === undefined || arriving === false) return {};
  return arriving === true ? { arriving: true } : null;
}

function parseDiff<T>(
  raw: unknown,
  parse: (v: unknown) => T | null,
): { upsert: T[]; remove: string[] } | null {
  if (!isRecord(raw)) return null;
  const upsert = parseList(raw['upsert'], parse);
  const remove = raw['remove'];
  if (upsert === null || !Array.isArray(remove) || !remove.every(isInputDocId)) return null;
  return { upsert, remove: [...remove] };
}

function parseList<T>(raw: unknown, parse: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const entry of raw) {
    const parsed = parse(entry);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function isRev(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// --- Live nudge (WS) --------------------------------------------------------

/** @internal */
export const INPUT_STATUS_FRAME_TYPE = 'doc_input_status';

/**
 * @internal
 * Says a key's status moved to `rev`; the reader fetches the delta from the
 * revision it holds. Posted on the branched topic of the line the key is
 * recorded on, since an editable open routes frames by exact topic.
 */
export interface InputStatusNudgeFrame {
  type: typeof INPUT_STATUS_FRAME_TYPE;
  topic: string;
  key: string;
  rev: number;
}

/** @internal */
export function inputStatusNudgeFrame(
  docId: string,
  lineId: string,
  key: string,
  rev: number,
): InputStatusNudgeFrame {
  return { type: INPUT_STATUS_FRAME_TYPE, topic: documentTopic(docId, lineId), key, rev };
}

/** @internal Reads a nudge frame. Null for any other frame or a malformed one. */
export function parseInputStatusNudge(
  raw: unknown,
): { docId: string; lineId: string; key: string; rev: number } | null {
  if (!isRecord(raw) || raw['type'] !== INPUT_STATUS_FRAME_TYPE) return null;
  const topic = typeof raw['topic'] === 'string' ? parseDocTopic(raw['topic']) : null;
  if (topic === null || !isInputKey(raw['key']) || !isRev(raw['rev'])) return null;
  return { docId: topic.docId, lineId: topic.branchId, key: raw['key'], rev: raw['rev'] };
}

// --- Provisional write (POST) -----------------------------------------------

/**
 * @internal
 * What the SDK posts, to the key's own path, once the op carrying a key's
 * change is acknowledged: the key's references and the latest read mark per
 * document as the client's copy holds them after that op. `op_seq` names that
 * op, which has to have landed on `branch_id` and been written by the posting
 * user; it is what orders the provisional row against the projection
 * compaction makes, and the server writes the row only when it is past both
 * the line's `projected_through` and the row's own `seq`. An empty `refs`
 * clears the key.
 */
export interface ProvisionalInputsBody {
  branch_id: string;
  op_seq: number;
  refs: InputReferenceWire[];
  read: Record<string, InputReadMark>;
}

/** @internal A provisional post: the key, which names the route's path, and its body. */
export interface ProvisionalInputsPost {
  key: string;
  body: ProvisionalInputsBody;
}

/**
 * @internal
 * What a provisional post answers. `written` is false when the row already
 * reflects this op or a later one, which is the ordinary outcome of a late or
 * repeated post rather than a refusal; `rev` is the row's revision either way.
 */
export interface ProvisionalInputsAnswer {
  key: string;
  rev: number;
  written: boolean;
}

/** @internal */
export function parseProvisionalInputsAnswer(raw: unknown): ProvisionalInputsAnswer | null {
  if (!isRecord(raw) || !isInputKey(raw['key']) || !isRev(raw['rev'])) return null;
  if (typeof raw['written'] !== 'boolean') return null;
  return { key: raw['key'], rev: raw['rev'], written: raw['written'] };
}

/** @internal */
export type InputsParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * @internal
 * Reads a provisional body for document `docId`. Refuses a reference to any
 * stream of `docId` itself, and references that repeat one identity.
 */
export function parseProvisionalInputsBody(
  raw: unknown,
  opts: { docId: string },
): InputsParseResult<ProvisionalInputsBody> {
  if (!isRecord(raw)) return fail('Body must be an object');
  const { branch_id: lineId, op_seq: opSeq } = raw;
  if (!isInputLineId(lineId)) return fail('branch_id is not a valid line id');
  if (typeof opSeq !== 'number' || !Number.isSafeInteger(opSeq) || opSeq < 1) {
    return fail('op_seq must be a positive integer');
  }
  const refsRaw = raw['refs'];
  if (!Array.isArray(refsRaw)) return fail('refs must be an array');
  if (refsRaw.length > INPUT_REFS_MAX_PER_KEY) return fail('Too many references');
  const refs: InputReferenceWire[] = [];
  const seen = new Set<string>();
  for (const entry of refsRaw) {
    const ref = parseInputReference(entry);
    if (ref === null) return fail('refs holds an invalid reference');
    if (ref.extent === 'document' && ref.doc_id === opts.docId) {
      return fail('A document cannot reference itself');
    }
    const id = inputReferenceId(ref);
    if (seen.has(id)) return fail('refs repeats a reference');
    seen.add(id);
    refs.push(ref);
  }
  const readRaw = raw['read'];
  if (!isRecord(readRaw)) return fail('read must be an object');
  const docIds = Object.keys(readRaw);
  if (docIds.length > INPUT_READ_MARKS_MAX_PER_KEY) return fail('Too many read marks');
  const read: Record<string, InputReadMark> = {};
  for (const docId of docIds) {
    const mark = parseInputReadMark(readRaw[docId]);
    if (!isInputDocId(docId) || mark === null) return fail('read holds an invalid mark');
    read[docId] = mark;
  }
  return { ok: true, value: { branch_id: lineId, op_seq: opSeq, refs, read } };
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
