import type { Document } from './documents.js';
import type { ListHandle, MapHandle } from './handle-types.js';

/**
 * The document as a serializer sees it: the `Document` an app reads, walked
 * with `entries()` / `values()`. Its `read()` is kept so a serializer written
 * against it still compiles.
 */
export interface StoredMap<T = unknown> extends MapHandle<T> {
  /** @deprecated Walk the map with `entries()`. */
  read(): Record<string, T>;
}
export interface StoredList<T = unknown> extends ListHandle<T> {
  /** @deprecated Walk the list with `values()`. */
  read(): T[];
}
/** The document a serializer reads. */
export interface StoredDocument {
  readonly id: string | null;
  map<T = unknown>(key: string): StoredMap<T>;
  list<T = unknown>(key: string): StoredList<T>;
}

// A per-app serializer that turns an app-owned (blob) document's records
// back into the source file's bytes: the inverse of the app's importer.
// Register one at boot with `Brass.registerSerializer`.
//
// The platform invokes it, never the app: on a download from a hosted Brass
// surface, the platform asks the running app to serialise, then handles
// staging, naming, and delivery. Producing the bytes is the serializer's
// whole job. An app with no registered serializer cannot export its blob
// documents (the platform falls back to the stale-original passthrough).
export type DocumentSerializer = (
  doc: StoredDocument & Document,
) => Uint8Array | Promise<Uint8Array>;
