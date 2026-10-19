// A whole document read out as plain JSON, from the bytes a join delivers.
//
// The caller is a detached reader: `@brass-build/cli`, which fetches a
// document's snapshot and tail and wants what it holds, with no session, no
// socket, and no app around it. That read is the store's own business, so it
// lives here beside `flattenPagedLookup` rather than being reassembled by
// whoever needs it. A second implementation of the paging precedence is the
// bug this module exists to prevent.
//
// The whole document, not a window over it. A reader building against an
// example file needs the record TYPES the file carries, and a prefix of a
// store does not carry them: an import arrives grouped by entity type, so the
// first records of a large file are a couple of types out of hundreds. The
// caller holding the document locally can answer any question about it; a
// caller holding a slice can only answer the ones the slice happens to cover.
//
// Nothing here is bounded, and that is deliberate: this runs on a developer's
// machine, which is the only place a large document fits. The platform's own
// join refuses rather than serving a partial document, so the bytes handed in
// are complete or they are not served at all.

// Through the runtime seam, not from `loro-crdt` directly: which engine build
// this package carries is decided by the two `wasm-runtime` halves, and a
// third module naming the dependency is an import the browser substitution
// does not reach. The reader is synchronous by design, so it takes the engine
// and not `ensureWasmReady`: its caller holds the bytes already, which means
// something upstream has opened a document and readied the runtime.
import { LoroDoc } from './wasm-runtime.js';
import type { JoinContent } from './join-content.js';
import { isReservedRootName } from './references.js';
import { importTailOp } from './tail-op-import.js';
import {
  META_KEY,
  flattenPagedLookup,
  isPagedMarker,
  pagedRootKey,
} from './record-paging.js';

/** A document's root containers, each read whole, keyed as the document
 *  keys them. A map root reads back as the object an app sees through
 *  `doc.map(key)`, a list as its items, a text root as its string. The JSON
 *  types tell them apart, so nothing here restates the container kind. */
export type DocumentContents = Record<string, unknown>;

/**
 * Materialise a document from a join's bytes and read every root.
 *
 * `snapshot` is the compacted state (null for a document that has never been
 * compacted) and `ops` the tail that follows it, in seq order. Both are the
 * shapes `GET /documents/{docId}?include=snapshot` delivers, once its inline
 * and presigned entries are resolved to bytes.
 */
export function readDocumentContents(
  snapshot: Uint8Array | null,
  ops: readonly Uint8Array[],
): DocumentContents {
  const doc = new LoroDoc();
  if (snapshot !== null) doc.import(snapshot);
  for (const op of ops) importTailOp(doc, op);
  return readRoots(doc);
}

/**
 * Read every root of a join's decoded content.
 *
 * Frozen content is read as it stands, with no CRDT engine: it carries no tail
 * (the conversion that would give it one is the platform's). CRDT content and
 * a document with no snapshot are materialised with `ops`, as
 * `readDocumentContents` does.
 */
export function readJoinContents(
  content: JoinContent,
  ops: readonly Uint8Array[],
): DocumentContents {
  if (content.kind === 'frozen') {
    if (ops.length > 0) {
      throw new Error('Frozen content arrived with changes above it, so it is not the whole document.');
    }
    return content.content.toJSON();
  }
  return readDocumentContents(content.kind === 'crdt' ? content.bytes : null, ops);
}

// A root container id is `cid:root-<name>:<Type>`; the name arrives as the
// key, so only the type suffix is read.
function containerType(containerId: string): string {
  return containerId.slice(containerId.lastIndexOf(':') + 1);
}

function readRoots(doc: LoroDoc): DocumentContents {
  const contents: DocumentContents = {};
  // Root ids only, so the enumeration converts nothing: each root below
  // decides its own read.
  for (const [key, containerId] of Object.entries(doc.getShallowValue())) {
    // The document's references and read marks are not content.
    if (isReservedRootName(key)) continue;
    switch (containerType(String(containerId))) {
      case 'Map':
        contents[key] = readMapRoot(doc, key);
        break;
      case 'List':
        contents[key] = doc.getList(key).toJSON();
        break;
      case 'MovableList':
        contents[key] = doc.getMovableList(key).toJSON();
        break;
      case 'Text':
        contents[key] = doc.getText(key).toString();
        break;
      default:
        // A container type this build does not read. Named with a null so
        // the root's existence survives the read rather than the document
        // appearing not to have it.
        contents[key] = null;
    }
  }
  return contents;
}

function readMapRoot(doc: LoroDoc, key: string): Record<string, unknown> {
  // Whether the store is paged is read from the root's own `meta` key, which
  // is authoritative: in an unpaged store every key is a record key, a
  // reserved-looking one included, because nothing refused it before the
  // store was written.
  const paged = isPagedMarker(doc.getMap(META_KEY).get(pagedRootKey(key)));
  // One bulk conversion, then the flatten: a per-container walk of a large
  // map costs work that grows with the map's own container count.
  const lookup = doc.getMap(key).toJSON() as Record<string, unknown>;
  return flattenPagedLookup(lookup, paged);
}
