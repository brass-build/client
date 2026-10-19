// The importer contract, shared by every place an importer runs.
//
// An importer is a leaf: given one file, it returns content as JSON covering
// one or more named streams of one document, plus an optional report. It
// holds no Document and calls nothing on Brass. Whatever runs it (the SDK in a
// browser tab, the platform's import worker) reads the file, encodes what it returns
// with `encodeImportStreams`, and hands the encoded streams to the platform,
// which seals them as the document's first content. Nothing here or in a
// runner knows which importer it is running.
//
// Loro-free, so the platform's worker and the published SDK share it.

import type { ImportReport } from './import-report.js';
import { sealedRootKindOf, type SealedStoreBuiltBy } from './sealed-store.js';

/** The file an importer is given. */
export interface ImportFile {
  /** The file's own name, extension included. */
  name: string;
  /** The file's media type, as it was uploaded. */
  content_type: string;
  /** The file's size in bytes. */
  byte_size: number;
  /** @internal A short-lived URL the bytes can be fetched from, where the
   *  runner has one. */
  url?: string;
  /** The file's bytes. */
  bytes(): Promise<Uint8Array>;
}

/**
 * One stream's content as JSON: one entry per top-level collection, the same
 * keys `doc.map`, `doc.list`, `doc.orderedMap` and `doc.text` read it back
 * through. An object is a map (its entries are the records), an array is a
 * list, and a string is a text. An ordered map is its two collections: the
 * map of records and the list of their keys.
 */
export type ImportContent = Record<string, Record<string, unknown> | readonly unknown[] | string>;

/** What an importer returns: the content of every stream it produces, keyed
 *  by stream name, and what it skipped or assumed. The document's own stream
 *  is `default`; any other name is a stream an app opens with
 *  `doc.stream(name)`. */
export interface ImportResult {
  streams: Record<string, ImportContent>;
  /** What the import skipped or assumed. Omit it for a file read cleanly. */
  report?: ImportReport;
}

export type DocumentImporter = (
  file: ImportFile,
) => ImportResult | Promise<ImportResult>;

/** The document's own stream. */
export const DEFAULT_IMPORT_STREAM = 'default';

// A stream name is a manifest name token (`NAME_TOKEN_PATTERN` in the
// platform's contracts): the platform refuses anything else.
const STREAM_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A result an importer returned that no runner can store, naming what is
 *  wrong with it. */
export class ImportResultError extends Error {}

/**
 * The importer's return value, validated, or null when it returned no
 * content. Throws `ImportResultError` naming the stream or collection it
 * could not read.
 */
export function readImportResult(value: unknown): ImportResult | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ImportResultError('The importer must return { streams }.');
  }
  const { streams, report } = value as { streams?: unknown; report?: unknown };
  if (streams === undefined || streams === null) return null;
  if (typeof streams !== 'object' || Array.isArray(streams)) {
    throw new ImportResultError(
      'The importer returned streams that are not an object keyed by stream name.',
    );
  }
  for (const [name, content] of Object.entries(streams)) {
    if (!STREAM_NAME.test(name)) {
      throw new ImportResultError(
        `The importer returned a stream named "${name}". A stream name is ` +
          'lowercase letters, digits, ".", "-" and "_".',
      );
    }
    if (content === null || typeof content !== 'object' || Array.isArray(content)) {
      throw new ImportResultError(
        `The importer returned stream "${name}" as something other than an ` +
          'object of collections.',
      );
    }
    for (const [key, root] of Object.entries(content as Record<string, unknown>)) {
      if (sealedRootKindOf(root) === null) {
        throw new ImportResultError(
          `The importer returned "${key}" in stream "${name}" as neither an ` +
            'object, an array, nor a string.',
        );
      }
    }
  }
  return {
    streams: streams as Record<string, ImportContent>,
    ...(report !== undefined && report !== null
      ? { report: report as ImportReport }
      : {}),
  };
}

/** How many entries a stream's content holds, across its collections. */
export function importContentEntries(content: ImportContent): number {
  let count = 0;
  for (const root of Object.values(content)) {
    if (typeof root === 'string') count += root === '' ? 0 : 1;
    else if (Array.isArray(root)) count += root.length;
    else count += Object.keys(root).length;
  }
  return count;
}

/** One stream, encoded in the form its producer uploads
 *  (`encodeSealedUpload`). */
export interface EncodedImportStream {
  name: string;
  bytes: Uint8Array;
  /** Entries the stream holds, counted before the encode consumed them. */
  entries: number;
}

/**
 * Encode every stream a result holds, the default stream first. A stream
 * holding no entries is left out, and a result where every stream is empty
 * encodes to nothing, which a runner reports rather than seals: the import
 * stamp is permanent, and a document stamped with nothing in it has no path
 * back to its file.
 *
 * CONSUMES the result's map values (see `sealedTablesOfImport`).
 */
export async function encodeImportStreams(
  result: ImportResult,
  builtBy?: SealedStoreBuiltBy,
): Promise<EncodedImportStream[]> {
  const { encodeSealedUpload } = await import('./sealed-encode.js');
  const names = Object.keys(result.streams).sort((a, b) =>
    a === DEFAULT_IMPORT_STREAM ? -1 : b === DEFAULT_IMPORT_STREAM ? 1 : 0,
  );
  const out: EncodedImportStream[] = [];
  for (const name of names) {
    const content = result.streams[name]!;
    const entries = importContentEntries(content);
    if (entries === 0) continue;
    out.push({ name, bytes: await encodeSealedUpload(content, builtBy), entries });
  }
  return out;
}

// --- The staging bundle -------------------------------------------------
//
// A runner outside the platform stages every stream of one import as ONE
// object, so the seal reads one upload and the streams land together or not
// at all. `BRSB`, a version byte, the stream count, then per stream a u16
// name length, the name, a u32 byte length, and the bytes.

const BUNDLE_MAGIC = 0x42_52_53_42;
const BUNDLE_VERSION = 1;

export function encodeStreamBundle(
  streams: readonly { name: string; bytes: Uint8Array }[],
): Uint8Array {
  const encoder = new TextEncoder();
  const names = streams.map((s) => encoder.encode(s.name));
  let total = 9;
  for (let i = 0; i < streams.length; i += 1) {
    total += 2 + names[i]!.byteLength + 4 + streams[i]!.bytes.byteLength;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, BUNDLE_MAGIC);
  view.setUint8(4, BUNDLE_VERSION);
  view.setUint32(5, streams.length);
  let at = 9;
  for (let i = 0; i < streams.length; i += 1) {
    const name = names[i]!;
    view.setUint16(at, name.byteLength);
    at += 2;
    out.set(name, at);
    at += name.byteLength;
    const bytes = streams[i]!.bytes;
    view.setUint32(at, bytes.byteLength);
    at += 4;
    out.set(bytes, at);
    at += bytes.byteLength;
  }
  return out;
}

/** The streams a bundle carries, or null for bytes that are not a bundle this
 *  reader can read. */
export function decodeStreamBundle(
  bytes: Uint8Array,
): { name: string; bytes: Uint8Array }[] | null {
  if (bytes.byteLength < 9) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== BUNDLE_MAGIC || view.getUint8(4) !== BUNDLE_VERSION) {
    return null;
  }
  const count = view.getUint32(5);
  const decoder = new TextDecoder();
  const out: { name: string; bytes: Uint8Array }[] = [];
  let at = 9;
  for (let i = 0; i < count; i += 1) {
    if (at + 2 > bytes.byteLength) return null;
    const nameLength = view.getUint16(at);
    at += 2;
    if (at + nameLength + 4 > bytes.byteLength) return null;
    const name = decoder.decode(bytes.subarray(at, at + nameLength));
    at += nameLength;
    const length = view.getUint32(at);
    at += 4;
    if (at + length > bytes.byteLength) return null;
    out.push({ name, bytes: bytes.subarray(at, at + length) });
    at += length;
  }
  return at === bytes.byteLength ? out : null;
}
