import type { Document } from './documents.js';
import type { ListHandle, MapHandle } from './handle-types.js';

/**
 * A container read whole.
 *
 * The handles an app holds do not offer this: an app is handed its records
 * through `subscribe`, so a fire costs what changed rather than what the
 * document holds. A serializer is the other kind of caller. It runs detached,
 * with no subscription to have been fed by, and it needs the document once, so
 * it is handed a view that reads whole containers instead of being told to go
 * and fetch them.
 */
export interface StoredMap<T = unknown> extends MapHandle<T> {
  read(): Record<string, T>;
}

export interface StoredList<T = unknown> extends ListHandle<T> {
  read(): T[];
}

/**
 * The document as a serializer sees it: the same containers, readable whole.
 *
 * A `Document` satisfies this, which is what keeps a serializer the platform
 * ships and one an app registers on one surface. The difference between them
 * is where they run, not what they are allowed to reach.
 */
export interface StoredDocument {
  readonly id: string | null;
  map<T = unknown>(key: string): StoredMap<T>;
  list<T = unknown>(key: string): StoredList<T>;
}

// A per-app serializer that turns an app-owned (blob) document's records
// back into the source file's bytes: the inverse of the parse the app ran
// on `doc.sourceBlob()` when it opened the file. Register one at boot with
// `Brass.registerSerializer`.
//
// The platform invokes it, never the app: on a download from a hosted Brass
// surface, the platform asks the running app to serialise, then handles
// staging, naming, and delivery. Producing the bytes is the serializer's
// whole job. An app with no registered serializer cannot export its blob
// documents (the platform falls back to the stale-original passthrough).
export type DocumentSerializer = (
  doc: StoredDocument & Document,
) => Uint8Array | Promise<Uint8Array>;
