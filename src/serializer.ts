import type { Document } from './documents.js';

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
  doc: Document,
) => Uint8Array | Promise<Uint8Array>;
