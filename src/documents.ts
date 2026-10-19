// SDK surface: `Brass.Document` plain-object proxy over Loro.
//
// Two load-bearing Loro gotchas:
//   1. `LoroDoc.subscribe(fn)` fires synchronously on every import,
//      including the initial snapshot import (8.5 s on a 50k snapshot).
//      So lazy-attach the Loro subscriber only on first `doc.subscribe`
//      (see `_ensureLoroSubscribed`).
//   2. The `getOwnPropertyDescriptor` trap participates in
//      `Object.keys`; doing `loroMap.keys().includes(key)` there makes
//      `Object.keys()` O(N^2). It reads a single `loroMap.get(key)`.

import type { ImportReport } from './import-report.js';
import { INPUTS_READ_ROOT, INPUTS_REFS_ROOT } from './inputs.js';
import { importTailOp } from './tail-op-import.js';
import {
  InputStatusHub,
  type InputStatus,
  type InputsLocalRoots,
  type InputsStatusRuntime,
} from './inputs-status.js';
import {
  InputFollowers,
  type InputDocumentHandlers,
  type InputDocumentOptions,
} from './input-documents.js';
import {
  LoroDoc,
  LoroMap,
  type LoroText,
  type PeerID,
  type Value,
  VersionVector,
  decodeImportBlobMeta,
} from './wasm-runtime.js';

import {
  NON_UNDOABLE_COMMIT_ORIGIN,
  PAGING_COMMIT_ORIGIN,
  UndoController,
  UndoGroup,
} from './undo.js';
import { joinStampOf } from './join-stamp.js';
import {
  decodeInputsRoots,
  inputReadClearWrites,
  inputReadMarkFor,
  inputReadMarkWrites,
  inputRemovalMark,
  inputRefsWrites,
  inputStampFromUpdatedAt,
  isInputDocId,
  isInputKey,
  parseInputReference,
  type InputReadMark,
  type InputReferenceWire as WireReference,
  type InputsRootWrites,
} from './inputs.js';
import {
  ProvisionalInputsTracker,
  isReservedRootName,
  latestReadMark,
  type InputsWrite,
  type MarkReadEntry,
  type MarkReadHandle,
  type MarkReadOptions,
  type MarkReadStatus,
  type ProvisionalInputsPoster,
} from './references.js';
import type { DocSyncDiagnostics, UndoControllerOptions } from './types.js';
import {
  createOrderedMapHandle,
  createRootListHandle,
  createRootMapHandle,
  rebindRootListAnchor,
  rebindRootMapAnchor,
  resyncRootHandle,
  snapshotRootMapKeys,
  teardownRootHandle,
  type StateVersion,
} from './handles.js';
import type {
  ChangeOrigin,
  ChangeSource,
  HandleOwner,
  ListHandle,
  MapHandle,
  MutateOptions,
  OrderedMapHandle,
  TextHandle,
  TextSubscriber,
} from './handle-types.js';
import { appCallbackError } from './subscriber-delivery.js';
import {
  flattenPagedLookup,
  isPagedMarker,
  isPagedMarkerEntry,
  META_KEY,
  pagedRootKey,
  RECORDS_KEY,
  rootCarriesMarkers,
} from './record-paging.js';
import { MAX_OP_BLOB_CHARS } from './ws-frame-limit.js';
import type {
  BranchSummary,
  DocumentSourceBlob,
  DocumentStreamInfo,
  PushToDriveInput,
  PushToDriveResult,
} from './documents-namespace.js';
import type { DriveResolveResult, InputReference } from './hosted-ui.js';
import {
  GoneSignal,
  WorkStatusSignal,
  DriveStatusSignal,
  DrivePublishTargetSignal,
  type DocumentGoneListener,
  type DocumentGoneReason,
  type DocumentGoneUnsubscribe,
  type DocumentStatusListener,
  type DocumentStatusUnsubscribe,
  type DocumentWorkStatus,
  type DocumentDriveStatus,
  type DocumentDriveStatusListener,
  type DocumentDriveStatusUnsubscribe,
  type DocumentDriveTrackingState,
  type DriveMirrorDirection,
  type DrivePublishTarget,
  type DrivePublishState,
} from './document-signals.js';
import {
  ThumbnailCapture,
  type CanvasSource,
  type ThumbnailUploader,
} from './document-thumbnail-capture.js';
import {
  CheckpointScheduler,
  type CheckpointCreator,
} from './document-checkpoints.js';
import { whenSaved } from './when-saved.js';
import { BrassError } from './errors.js';
import type { OpenedDocument } from './open-document.js';
import type { OpenModeOptions, ReadOnlyDocument } from './read-only-document.js';
import {
  BranchController,
  type BranchProvider,
} from './document-branches.js';
import { releaseUnsavedWork, trackUnsavedWork } from './unload-guard.js';
import {
  CommandMenu,
  type Command,
  type CommandGroup,
  type CommandSurface,
  type HostedUiProvider,
} from './document-commands.js';
import { DocumentStream, type StreamRuntime } from './document-streams.js';
import { createEmitter } from './emitter.js';
import {
  CONVERSION_PEER_ID,
  SealedContent,
  type SealedContentJson,
  type SealedStore,
} from './sealed-store.js';
import { sealedRoots, type SealedRoots } from './sealed-handles.js';
import { StableHandles } from './stable-handles.js';
import type { JoinContent } from './join-content.js';

// The stream name `doc.stream()` resolves to the document's own default
// state; mirrors the server's reserved name.
export const DEFAULT_STREAM_NAME = 'default';

export type { BranchProvider };

export type {
  Command,
  CommandGroup,
  CommandSurface,
  HostedUiProvider,
};

export type { CanvasSource };

export type {
  DocumentGoneListener,
  DocumentGoneReason,
  DocumentGoneUnsubscribe,
  DocumentStatusListener,
  DocumentStatusUnsubscribe,
  DocumentWorkStatus,
  DocumentDriveStatus,
  DocumentDriveStatusListener,
  DocumentDriveStatusUnsubscribe,
  DocumentDriveTrackingState,
  DriveMirrorDirection,
  DrivePublishTarget,
};

// The proxy callback receives an object with the root map (`entities`)
// surfaced as a plain JS proxy. Mutating it records Loro ops; the SDK
// commits them on return from `fn`. `E` is the app's entity shape,
// defaulting to the untyped `EntityProxy`:
//
//   doc.mutate<MyEntity>((d) => {
//     d.entities[id] = myTypedEntity;     // no cast needed
//   });
//
// The `extends object` constraint (not `Record<string, unknown>`) lets
// closed interfaces through: TS does not infer an index signature for a
// closed interface, so the stricter constraint would force a cast at
// every mutate site.
export interface DocumentMutator<E extends object = EntityProxy> {
  entities: Record<string, E>;
}

// What the entity proxy presents by default: any nested plain object
// shape backed by a LoroMap / LoroMovableList container tree. `Record<string,
// unknown>` because Loro's value type is dynamic; typed apps pass their
// shape to `DocumentMutator<E>` / `doc.mutate<E>` instead.
export type EntityProxy = Record<string, unknown>;

export type DocumentSubscriber = (event: SyntheticSubscribeEvent) => void;
export type DocumentUnsubscribe = () => void;

/**
 * Which handle reads a collection: `map` for `doc.map(key)`, `list` for
 * `doc.list(key)`, `text` for `doc.text(key)`.
 *
 * An ordered map is a pairing of a `map` and a `list` rather than a kind of
 * its own, so both halves are listed under their own keys.
 *
 * Read it as an open set and render an unrecognised kind as one you cannot
 * name, so a kind added later reaches your app as a value rather than as a
 * break. This set grew from two to three when `doc.text` arrived.
 */
export type RootKind = KnownRootKind | (string & {});

// The kinds this build resolves, kept narrow so the producer below is still
// checked against them: the public type is open, which on its own would let a
// misspelt kind through as an ordinary string.
type KnownRootKind = 'map' | 'list' | 'text';

// Loro names a container's type in its id (`cid:root-notes:Map`), so the kind
// comes off the enumeration itself and costs no read. A type this package
// cannot hand anyone a handle for, and cannot describe as text either, is
// left out rather than guessed at, so every entry a reader gets is one they
// can act on.
function rootKindOf(containerId: string): KnownRootKind | null {
  const type = containerId.slice(containerId.lastIndexOf(':') + 1);
  if (type === 'Map') return 'map';
  if (type === 'MovableList' || type === 'List') return 'list';
  if (type === 'Text') return 'text';
  return null;
}

// Maps count entries, lists and text count length. Both are the container's
// own counter rather than a projection of what it holds.
/** Whether a root map holds nothing but paged markers, which its handle hides,
 *  so the collection reads as empty. */
function holdsOnlyMarkers(rootKey: string, container: unknown): boolean {
  if (!rootCarriesMarkers(rootKey) || !(container instanceof LoroMap)) return false;
  return container.keys().every((key) => isPagedMarkerEntry(rootKey, key));
}

// A root's projected value when the collection holds nothing: a map, list
// or text with no content.
function projectsEmpty(value: unknown): boolean {
  if (value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function rootIsEmpty(container: unknown): boolean {
  const sized = container as { size?: number; length?: number };
  if (typeof sized.size === 'number') return sized.size === 0;
  if (typeof sized.length === 'number') return sized.length === 0;
  return false;
}

// The discriminated event `doc.subscribe` fires. Every event the document
// produces arrives in this shape, whether a content change or one of the
// SDK's own metadata ticks, so an app can ignore the argument and re-read in
// the handler, or narrow on `event.kind`.
export type SyntheticSubscribeEvent =
  // A content change, with what produced it. `source` is the same value the
  // handle surface reports as `origin.source`.
  | { kind: 'change'; source: ChangeSource }
  | { kind: 'history'; version: number }
  | { kind: 'return-to-head' }
  // A bare re-read tick: the document's branch state settled or changed
  // (the list loaded on open, or a switch/create landed). Carries no
  // payload; the SDK's own chrome (the toolbar branch chip, the page
  // title) re-reads the current branch name, and an app never needs the
  // branch model, management is hosted.
  | { kind: 'branches' }
  | { kind: 'saving-count' }
  // The document's capacity verdict changed, so `doc.atCapacity` reads
  // differently than it did. Fired on its own kind rather than folded into
  // `saving-count` because an app acts on it differently: a saving count
  // moves constantly and settles, while this one gates whether adding more
  // is worth offering at all.
  | { kind: 'capacity' }
  | { kind: 'commands' };

// Snapshot of the Document's undo/redo state, pushed to
// `Document.subscribeUndoState` subscribers on every flip.
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

export type UndoStateSubscriber = (state: UndoState) => void;

// Commit-origin tags stamped on every locally-produced commit via Loro's
// `setNextCommitOrigin`, so `origin.source` can be recovered off the
// event. Stamping the commit (not a JS-side flag) survives a
// microtask-deferred subscribe callback: the tag travels with the event.
// `mutate()` carries `MUTATE`; `undo()`/`redo()` stamp their own tag
// before driving the UndoManager so they read back as `'undo'`/`'redo'`
// not `'local'`. A remote op (`by === 'import'`) and a checkout
// (`by === 'checkout'`) need no tag.
const MUTATE_COMMIT_ORIGIN = 'brass.mutate';
const UNDO_COMMIT_ORIGIN = 'brass.undo';
const REDO_COMMIT_ORIGIN = 'brass.redo';

// Classify a Loro event by what produced it. The render path never calls
// this (it reconciles by value); it backs a change's `origin.source` for
// attribution and the SDK's own local-vs-remote side-effect gating
// (thumbnail capture, auto-checkpoint).
// A reserved root map as plain entries, the view the write rules diff against.
function rootView(map: LoroMap): Record<string, unknown> {
  return map.toJSON() as Record<string, unknown>;
}

// Applies one reserved root's writes per entry. Returns whether anything moved.
function applyRootWrites<V>(map: LoroMap, writes: InputsRootWrites<V>): boolean {
  for (const key of writes.delete) map.delete(key);
  for (const [key, value] of Object.entries(writes.set)) map.set(key, value as unknown as Value);
  return writes.delete.length > 0 || Object.keys(writes.set).length > 0;
}

// The reserved roots hold the document's references and read marks, which
// only `dependsOn` and `markRead` write.
function assertAppRootName(key: string): void {
  if (isReservedRootName(key)) {
    throw new TypeError(`"${key}" is reserved for Brass; choose another collection name`);
  }
}

function changeSourceOf(event: unknown): ChangeSource {
  const by = (event as { by?: unknown }).by;
  if (by === 'import') return 'remote';
  // by === 'local': disambiguate via the commit-origin tag.
  const origin = (event as { origin?: unknown }).origin;
  if (origin === UNDO_COMMIT_ORIGIN) return 'undo';
  if (origin === REDO_COMMIT_ORIGIN) return 'redo';
  return 'local';
}

// Whether a text container stores `value` unchanged. Loro's text is UTF-8, so
// an unpaired surrogate is stored as U+FFFD and what the document holds is
// not the string that was written. Scanned here rather than through
// `String.prototype.isWellFormed`, which is younger than the browsers this
// package runs in.
function storedVerbatim(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    // A trailing surrogate reached before its lead is unpaired by itself.
    if (unit > 0xdbff) return false;
    i += 1;
    const low = i < value.length ? value.charCodeAt(i) : 0;
    if (low < 0xdc00 || low > 0xdfff) return false;
  }
  return true;
}

// Per-chunk cap on a blob this Document pushes as several ops: a durability
// resync's missing slice (`computeResyncPush`) and a local commit no write
// budget bounded (`splitLocalUpdate`).
//
// Each chunk goes out through the same local-op hook an ordinary commit
// uses, so the transport picks itself by size and a chunk this large takes
// the HTTP op write. Sizing the chunk to a WebSocket frame instead is what
// makes a heal the most expensive write the SDK performs: the slice a bulk
// write leaves behind is the whole document, and at frame size that is
// thousands of ops written one after another against the same document.
// Measured, a 40 MB divergence healed in 16 KB chunks overwhelmed that
// document's write path and left the join a tail it refused to serve. The
// same divergence at this size is tens of ops.
const RESYNC_PUSH_MAX_BYTES = 512 * 1024;

// Hard ceiling for a single irreducible op (one Loro op, unsplittable),
// beyond which the chunk is skipped with a warning rather than retried
// forever, while the doc's other chunks still heal.
//
// Skipping drops an edit the server never received, so this sits at exactly
// what the write path can carry rather than at what a frame holds. Base64
// turns B raw bytes into ceil(B/3)*4 characters, so the last raw size whose
// encoding still fits the durable cap is three quarters of it. Derived
// rather than written out, because the two have to move together and a
// literal here would let the ceiling drift above what the server accepts,
// which turns a heal into silent loss. A blob this large travels through
// the staged upload rather than a request body, a path the write already
// takes on its own size.
const RESYNC_PUSH_HARD_MAX_BYTES = Math.floor((MAX_OP_BLOB_CHARS * 3) / 4);

// What one run of the durability handshake settled. Only `covered` means the
// durable frontier holds everything local does; a caller driving the
// handshake to close a known divergence keeps asking on anything else.
//
//   covered      the server holds it all, so the handshake is finished
//   pushed       chunks are on the wire and their acks decide the outcome
//   in-flight    an earlier push has not settled, so this run stood down
//   undecodable  the frontier did not parse, so nothing was compared
//   closed       the doc was freed before the handshake ran
/** @internal */
export type ResyncPushOutcome =
  | 'covered'
  | 'pushed'
  | 'in-flight'
  | 'undecodable'
  | 'closed';

type CounterRange = { peer: PeerID; from: number; to: number };

// Per author, the sorted, disjoint half-open counter ranges a server holds.
//
// A version vector cannot describe this: it says an author's ops are held up
// to a counter, and a server's op log can hold an author's later ops while
// missing an earlier one. Each tail blob therefore contributes its own range
// rather than raising a per-author maximum, which would read the hole as held.
type HeldRanges = Map<PeerID, [number, number][]>;

function holdRange(held: HeldRanges, peer: PeerID, from: number, to: number): void {
  if (to <= from) return;
  const merged: [number, number][] = [];
  let next: [number, number] = [from, to];
  for (const range of held.get(peer) ?? []) {
    if (range[1] < next[0] || range[0] > next[1]) {
      merged.push(range);
    } else {
      next = [Math.min(range[0], next[0]), Math.max(range[1], next[1])];
    }
  }
  merged.push(next);
  merged.sort((a, b) => a[0] - b[0]);
  held.set(peer, merged);
}

// What the durable state holds: the snapshot, which is causally complete so
// every author's ops from zero, plus each tail blob's own per-author range.
// Throws on a malformed vector or blob.
function durableHoldings(
  persistedSnapshotVersionVector: Uint8Array,
  durableTailBlobs: readonly Uint8Array[],
): HeldRanges {
  const held: HeldRanges = new Map();
  for (const [peer, to] of VersionVector.decode(persistedSnapshotVersionVector).toJSON()) {
    holdRange(held, peer, 0, to);
  }
  for (const blob of durableTailBlobs) {
    const meta = decodeImportBlobMeta(blob, false);
    const start = meta.partialStartVersionVector.toJSON();
    for (const [peer, to] of meta.partialEndVersionVector.toJSON()) {
      holdRange(held, peer, start.get(peer) ?? 0, to);
    }
  }
  return held;
}

// The ranges of `local` the durable state does not hold, in counter order
// per author.
function rangesMissingFrom(local: VersionVector, held: HeldRanges): CounterRange[] {
  const missing: CounterRange[] = [];
  for (const [peer, to] of local.toJSON()) {
    let from = 0;
    for (const [heldFrom, heldTo] of held.get(peer) ?? []) {
      if (heldFrom >= to) break;
      if (heldFrom > from) missing.push({ peer, from, to: heldFrom });
      from = Math.max(from, heldTo);
    }
    if (from < to) missing.push({ peer, from, to });
  }
  return missing;
}

// Group ranges so no group carries two ranges of one author. A blob's header
// names one start and one end per author, so a blob spanning two separate
// ranges of an author would read, to whoever folds it into a frontier, as
// holding the ops between them as well.
function oneRangePerAuthor(ranges: readonly CounterRange[]): CounterRange[][] {
  const groups: CounterRange[][] = [];
  const seen = new Map<PeerID, number>();
  for (const range of ranges) {
    const index = seen.get(range.peer) ?? 0;
    seen.set(range.peer, index + 1);
    (groups[index] ??= []).push(range);
  }
  return groups;
}


function rangeOpCount(ranges: readonly CounterRange[]): number {
  return ranges.reduce((n, r) => n + (r.to - r.from), 0);
}

// Split half-open per-peer counter ranges in two after `at` ops, splitting at
// most one range across the boundary. Order is preserved.
function splitRangesAt(
  ranges: readonly CounterRange[],
  at: number,
): [CounterRange[], CounterRange[]] {
  const first: CounterRange[] = [];
  const second: CounterRange[] = [];
  let acc = 0;
  for (const r of ranges) {
    const len = r.to - r.from;
    if (acc >= at) {
      second.push(r);
    } else if (acc + len <= at) {
      first.push(r);
      acc += len;
    } else {
      const splitAt = r.from + (at - acc);
      first.push({ peer: r.peer, from: r.from, to: splitAt });
      second.push({ peer: r.peer, from: splitAt, to: r.to });
      acc = at;
    }
  }
  return [first, second];
}

// Split into two halves by op count. `total` must be >= 2 so both halves are
// non-empty (the caller handles total === 1 as the irreducible single-op case).
function splitRangesByLength(
  ranges: readonly CounterRange[],
  total: number,
): [CounterRange[], CounterRange[]] {
  return splitRangesAt(ranges, Math.floor(total / 2));
}

// Split into `parts` pieces of roughly equal op count, in order.
//
// A caller that already knows the whole range's byte size can name the number
// of pieces it wants instead of discovering it by halving, which costs one
// export per level and re-exports the same ops at every level: an 8 MB commit
// takes 31 exports to reach sixteen chunks by halving and 16 by naming them.
// The pieces are still measured afterwards, so an uneven commit that leaves a
// piece over the cap is split further from there.
function splitRangesEvenly(
  ranges: readonly CounterRange[],
  parts: number,
): CounterRange[][] {
  let rest = [...ranges];
  let remaining = rangeOpCount(rest);
  if (parts <= 1 || remaining <= parts) return [rest];
  const out: CounterRange[][] = [];
  for (let left = parts; left > 1; left -= 1) {
    const at = Math.floor(remaining / left);
    if (at < 1) break;
    const [first, second] = splitRangesAt(rest, at);
    out.push(first);
    rest = second;
    remaining -= at;
  }
  out.push(rest);
  return out.filter((piece) => rangeOpCount(piece) > 0);
}

// The `meta` root a document's paged marker lives in, or `null` while the
// document has none.
//
// The marker is read on every root-map read, edit and keyed lookup, and a
// reader that answers from a copy taken earlier is what puts paged-shaped keys
// into a store whose marker says unpaged, or reads a root a peer paged as its
// raw page entries. Answering off the live container instead makes both
// impossible: a peer's write lands in that same container, so the next read
// sees it, with no invalidation to get right.
//
// What is remembered per document is the resolved CONTAINER, and only once the
// root exists. A root handle reads through to the document's current state, so
// holding one keeps the value live: a peer's import and a checkout both land
// on the same container the cell already points at.
//
// Holding it is also what keeps this off the leak. Every `getMap` mints a new
// wasm-bindgen handle that dropping does not reclaim (the same fact `pageValue`
// and `entryExists` free around), and this resolves on every root-map read,
// edit and keyed lookup, so minting per call retains ~145 bytes each for the
// length of the session. One handle per document is a bounded cost instead.
//
// Resolution goes through `getByPath` rather than `getMap`, which is
// get-or-create and would materialize an empty `meta` on a document that has
// none (in the wire shape of every unpaged document, and as a local write on a
// read-only open). Its cost tracks the document's container count, and it is
// paid once per document.
const metaRoots = new WeakMap<LoroDoc, { map: LoroMap | null }>();

function metaRoot(source: LoroDoc): LoroMap | null {
  let cell = metaRoots.get(source);
  if (cell === undefined) {
    cell = { map: null };
    metaRoots.set(source, cell);
  }
  if (cell.map === null) {
    const found = source.getByPath(META_KEY);
    if (!(found instanceof LoroMap)) return null;
    cell.map = found;
  }
  return cell.map;
}

/** The `meta` root, creating it if `source` has none, and remembering it so
 *  later reads resolve without minting a second handle. */
function metaRootOrCreate(source: LoroDoc): LoroMap {
  const existing = metaRoot(source);
  if (existing !== null) return existing;
  const created = source.getMap(META_KEY);
  metaRoots.set(source, { map: created });
  return created;
}

/** Whether one root map is paged. Same predicate the record-store readers
 *  use, so the SDK handle path and those readers cannot disagree. */
function readRootPaged(source: LoroDoc, rootKey: string): boolean {
  return isPagedMarker(metaRoot(source)?.get(pagedRootKey(rootKey)));
}

/** Whether a root's JSON is the keyed lookup a record store flattens. A root
 *  that projects to a list or a scalar cannot hold pages whatever `meta`
 *  says, so it is handed back untouched. */
function isRootLookup(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Mark `rootKey` paged, under a `meta` key of its own. Written ONCE and never
// revised: pages are addressed by session and index, so nothing downstream
// needs to know how many there are or how much the store grows afterwards.
//
// A key per root is what lets two peers page two different roots at the same
// time. One entry naming every paged root would have to be read, extended and
// written back whole, and the losing side of that race takes its root's marker
// with it (see `PAGED_ROOT_PREFIX`); two keys merge.
//
// The marker commits on its own, under an origin the undo stack excludes, and
// `commitPending` lands whatever the running mutation has written so far
// first. Two properties ride on that. Peers and the server never see a page
// without the marker that says how to read it, because the marker's op
// precedes every op carrying a page. And nothing an app authored is taken out
// of the undo stack with it: a commit carrying both would exclude the records
// as well as the marker.
function pageRoot(
  source: LoroDoc,
  rootKey: string,
  commitPending: () => void,
): void {
  if (readRootPaged(source, rootKey)) return;
  commitPending();
  metaRootOrCreate(source).set(pagedRootKey(rootKey), true);
  source.setNextCommitOrigin(PAGING_COMMIT_ORIGIN);
  source.commit();
}

// Why a live Document refuses local writes. Each names a refusal the server
// would make, so `mutate` can say which one applies rather than answering
// every refusal with one message.
/**
 * Why a reader may not write, where the refusal comes from somewhere OUTSIDE
 * this document: the server, the link they arrived through, or the caller's
 * own ask. `_markReadOnly` takes one of these and nothing else, because the
 * reasons below it are states the document computes for itself and could not
 * be handed one of.
 * @internal
 */
/** The three ways a document is open: editable, read-only and following
 *  edits, or frozen at what it loaded.
 *  @internal */
export type ReopenMode = 'edit' | 'read' | 'frozen';

interface PendingReopen {
  mode: ReopenMode;
  // What the reopen produced, whether or not a later reopen superseded it.
  result: Promise<OpenedDocument>;
  superseded: boolean;
  // What the call that started it receives.
  promise: Promise<OpenedDocument>;
}

export type ForcedReadOnlyReason =
  // Opened through a view-only share link.
  | 'link'
  // The reader's grant on this document does not carry write access.
  | 'grant'
  // The app acting on the reader's behalf may not edit this document.
  | 'app'
  // A change this copy holds was refused, so it shows something no other
  // reader has. Editing on top of it builds more of the same, and `reload()`
  // is what returns the copy to what the platform holds.
  | 'unsaved'
  // A stream reached the largest size the platform can keep, so it refuses
  // further writes. Unlike `unsaved`, no reload follows: a stream is one
  // part of a document, and the rest keeps taking writes, so the app reads
  // `stream.atCapacity` and stops offering the bulk work on this stream.
  | 'capacity'
  // The document opened with no live connection to write through, so a
  // change would stay on this device.
  | 'no_connection'
  // The caller asked for a snapshot of the document rather than a session on
  // it. Unlike every reason above, this one is the caller's own choice rather
  // than a limit on them, so a reader seeing it may well hold write access and
  // reach it by opening the document again without asking for a snapshot.
  | 'snapshot'
  // The document is too large for the platform to make editable, so it opens
  // as a copy to read and no reload changes that.
  | 'too_large'
  // The document still holds only the file it was uploaded as, and no
  // importer takes that file's type, so the file is its content.
  | 'not_imported';

/**
 * Why a reader may not write, in the vocabulary `mutate` refuses in.
 *
 * The four beyond the forced ones are states this document computes for
 * itself: it is showing a historical version, its reader has the version bar
 * open, its content has not arrived, or the work that would bring it ended
 * with nothing. They are derived rather than set, which is why one function
 * (`_readOnlyBecause`) answers both `readOnly` and the refusal message. Two
 * ladders over the same conditions is what they replace, and the pair could
 * disagree about whether a document was writable and about why.
 * @internal
 */
export type ReadOnlyReason =
  | ForcedReadOnlyReason
  // A historical version is showing (a checkout).
  | 'version'
  // The reader has the version bar open. Browsing locks the document at the
  // live head as well as at an earlier point: stepping moves between the
  // points history KEEPS, and an edit at the head makes no such point, so an
  // edit made under the open bar puts the reader's own newest work somewhere
  // the bar cannot travel to. Reading history and writing it are separate
  // modes, and the bar carries the Close that leaves this one.
  | 'browsing'
  // Content-replacing work is still coming. Editing would write ops onto a
  // document the incoming bytes are about to replace, and it is also what
  // stops an app's "seed an empty doc" path from clobbering a document that
  // only looks empty because it has not loaded yet.
  | 'loading'
  // That work ended with no content. A document nothing could prepare is
  // empty, and an edit there writes ops into one the app is about to be told
  // could not be opened.
  | 'load_failed'
  // `reopen` is replacing this copy. The copy closes once the new one has
  // joined, and closing it drops whatever it has not sent, so an edit made
  // here in the meantime would be lost.
  | 'reopening';

const READ_ONLY_MESSAGES: Record<ReadOnlyReason, string> = {
  link: 'Document is read-only: it was opened via a view-only share link.',
  grant: 'Document is read-only: you have view-only access to it.',
  app: 'Document is read-only: this app is not permitted to edit it.',
  unsaved:
    'Document is read-only: a change could not be saved, so this copy holds ' +
    'work the platform does not. Brass is replacing it with the platform copy.',
  capacity:
    'Stream is read-only: it reached the largest size the platform can keep. ' +
    'Reopen it to keep working from the saved state.',
  no_connection:
    'Document is read-only: it opened with no live connection, so a change ' +
    'would stay on this device.',
  snapshot:
    'Document is read-only: it was opened as a snapshot. Open it without ' +
    'asking for one to edit.',
  too_large:
    'Document is read-only: it is too large for Brass to make editable ' +
    '(see `doc.status`).',
  not_imported:
    'Document is read-only: it holds an uploaded file that has not been ' +
    'imported, and no importer takes its type.',
  version:
    'Document is read-only: it is showing a historical version. ' +
    'Return to the latest version to edit.',
  browsing:
    'Document is read-only: the reader is browsing its versions. ' +
    'Close the version bar to edit.',
  loading:
    'Document is still loading its content; wait for the load to finish ' +
    'before editing (see `doc.onStatus`).',
  reopening:
    'Document is read-only while it reopens; edit the copy `reopen` resolves with.',
  load_failed:
    'Document is read-only: its content could not be prepared ' +
    '(see `doc.status`). Reopen it to try again.',
};

// What `status` reads while this client's edits wait on a connection that has
// never opened. Pending, because Brass keeps trying and the edits save the
// moment it connects; not blocking, because editing stays open.
const NOT_SAVED_NOTICE: DocumentWorkStatus = {
  message:
    'Your changes are not saved yet. Brass cannot connect to save them and ' +
    'keeps trying. Keep this page open until they are saved.',
  pending: true,
  blocking: false,
};

// What `status` reads while one of this client's edits goes unanswered by a
// connection that answers its others. Pending and not blocking for the same
// reasons as `NOT_SAVED_NOTICE`.
const UNANSWERED_NOTICE: DocumentWorkStatus = {
  message:
    'Some of your changes are not saved yet. Brass keeps trying to save them. ' +
    'Keep this page open until they are saved.',
  pending: true,
  blocking: false,
};

const SAVE_NOTICES = { never_opened: NOT_SAVED_NOTICE, unanswered: UNANSWERED_NOTICE };

export interface DocumentOptions {
  // Root key the Document wraps. Defaults to `"entities"` to match the
  // wire protocol's top-level shape.
  rootKey?: string;
  /** The document's content in its frozen form, for a stream the platform
   *  holds that way. Its roots answer every read, and no CRDT engine
   *  materialises them.
   *  @internal */
  frozenContent?: SealedContent;
  /** The seq `frozenContent` was sealed at, as the join named it.
   *  @internal */
  frozenSeal?: number;
  /** Author every commit as this peer rather than a random one.
   *
   *  What it buys is a DETERMINISTIC document: the same records written under
   *  the same peer produce the same ops, so two sides that build a document
   *  from one record set independently build the same one, and their later
   *  edits merge instead of doubling every record. That is what lets a stored
   *  record set become a CRDT wherever it is first needed, with nothing
   *  coordinating which side does it.
   *
   *  Only a conversion sets this. A live editor keeps its own peer, so the
   *  ops it writes after a conversion are its own.
   *  @internal */
  peerId?: `${number}`;
  // The server-minted `doc_id`. Set by the SDK's open / create paths so
  // callers read `doc.id` to track the active doc. `null` on
  // direct-construction (`Document.create()` / `openFromSnapshot`),
  // which only happens in tests and offline-only flows.
  docId?: string;
  // The branch this Document is open on. Surfaced as `doc.branchId` and
  // passed to `createBranch` as the fork source. `null` on the
  // offline / test path.
  branchId?: string;
  // True when opened at a historical version. A read-only Document
  // throws from `mutate` and carries no live WS transport.
  /** @deprecated Pass `readOnly: true` to `session.open` / `Brass.openDocumentById`, which types the result `ReadOnlyDocument`. */
  readOnly?: boolean;
  // Why `readOnly` was set, which picks the message `mutate` throws.
  // Defaults to the view-only link.
  /** @internal */
  readOnlyReason?: ForcedReadOnlyReason;
  // The historical version materialized at, when opened via `{ version
  // }`; `null` for a live (head) open. The server's *effective* version,
  // which may round down when compaction has TTL'd the exact op.
  version?: number;
  // Per-document undo/redo controller config (max retained steps).
  undo?: UndoControllerOptions;
}

// Hook called on every locally-generated Loro update.
// `Brass.openDocumentById` installs it to ship op blobs over WS; without
// it, `mutate` still mutates local CRDT state (offline / tests /
// migration) but nothing leaves the process. The returned `clientOpId`
// correlates the eventual `op_ack` with the originating mutation (for
// optimistic-UI pending markers).
type LocalOpSendHook = (opBlob: Uint8Array) => string;

// Public Document class. Wraps a LoroDoc; exposes mutate / subscribe /
// toJSON / close. Construction is cheap: the Loro subscriber attaches
// lazily (see `_ensureLoroSubscribed`).
// A root text handle, plus the three hooks the Document drives on it. A text
// container's subscription anchors to one LoroDoc, so a version checkout has
// to move it the way it moves a map's or a list's anchor.
interface RootTextHandle extends TextHandle {
  _rebind(next: LoroText): void;
  _resync(): void;
  _teardown(): void;
}

// The roots a document's referenced inputs live in are written only by the
// SDK's own input writers, so a frozen root carrying one of those names
// converts to nothing.
const INPUTS_ROOTS: ReadonlySet<string> = new Set([INPUTS_REFS_ROOT, INPUTS_READ_ROOT]);

/**
 * The CRDT a frozen stream becomes: its content written through the same
 * handles an app writes through, so what a conversion produces is what an app
 * writing the same content would have produced, paging and all.
 *
 * Every side converts by calling this. It is authored by the pinned
 * conversion peer (`CONVERSION_PEER_ID`) over the content in stored order, so
 * one frozen stream always converts to the same document; it is NOT a licence
 * for two builds to convert separately and expect to agree, because the rest
 * of the output moves with the paging constants and the batching budget, which
 * is why the platform converts once and stores the result.
 *
 * A list that is a map's key walk is that map's order, so the two are written
 * as one ordered map.
 *
 * @internal
 */
export function snapshotFromSealedContent(content: SealedContent): Uint8Array {
  const names = content.rootNames().filter((n) => !INPUTS_ROOTS.has(n));
  const walked = new Map<string, string>();
  for (const name of names) {
    const map = content.keyWalkOf(name);
    if (map !== null && !walked.has(map)) walked.set(map, name);
  }
  // A `Document` registers its root container on construction, so the root
  // key is one the content writes anyway rather than an empty `entities` map
  // in every snapshot.
  const rootKey =
    [...walked.keys()][0] ??
    names.find((n) => content.kindOf(n) === 'map') ??
    'entities';
  const doc = Document.create({ rootKey, peerId: CONVERSION_PEER_ID });
  try {
    for (const name of names) {
      // A reserved root is written only through `dependsOn` / `markRead`.
      if (isReservedRootName(name)) continue;
      const kind = content.kindOf(name);
      if (kind === 'map') {
        const order = walked.get(name);
        const write = (draft: Record<string, unknown>): void => {
          content.forEachMapEntry(name, (key, value) => {
            draft[key] = value;
          });
        };
        if (order !== undefined) doc.orderedMap<unknown>(name, order).mutate(write);
        else doc.map<unknown>(name).mutate(write);
      } else if (kind === 'list') {
        const map = content.keyWalkOf(name);
        if (map !== null && walked.get(map) === name) continue;
        const items = content.list(name) ?? [];
        if (items.length === 0) continue;
        doc.list<unknown>(name).mutate((list) => {
          for (const item of items) list.push(item);
        });
      } else if (kind === 'text') {
        const text = content.text(name) ?? '';
        if (text !== '') doc.text(name).update(text);
      }
    }
    return doc._exportSnapshot();
  } finally {
    doc.close();
  }
}

/**
 * A CRDT snapshot's content as JSON, read the way an app reads it (a paged
 * root flattened to its records), holding exactly the roots the snapshot
 * holds. A Document registers its root map on construction, so it is opened
 * on a root the snapshot already has rather than on the default.
 * @internal
 */
export function snapshotContentJSON(snapshot: Uint8Array): Record<string, unknown> {
  // One engine, and the roots named from its shallow value: a whole-engine
  // `toJSON` here would hold a second copy of the content beside the one the
  // read below builds.
  const engine = new LoroDoc();
  engine.import(snapshot);
  const shallow = engine.getShallowValue() as Record<string, unknown>;
  const held = Object.keys(shallow);
  const rootKey = held.find((k) => {
    if (isReservedRootName(k)) return false;
    const id = shallow[k];
    return typeof id === 'string' && id.endsWith(':Map');
  });
  const doc = Document._fromEngine(engine, rootKey !== undefined ? { rootKey } : undefined);
  try {
    const json = doc.toJSON();
    for (const key of Object.keys(json)) if (!held.includes(key)) delete json[key];
    return json;
  } finally {
    doc.close();
  }
}

/** The CRDT a stored record store becomes. The same conversion as
 *  `snapshotFromSealedContent`, reached from the record-store view.
 *  @internal */
/** A whole CRDT document as plain JSON, its paged roots as records. */
function engineJSON(source: LoroDoc): Record<string, unknown> {
  const json = source.toJSON() as Record<string, unknown>;
  // The document's references and read marks are the platform's, read
  // through `dependsOn` and the input status rather than as content.
  for (const key of Object.keys(json)) if (isReservedRootName(key)) delete json[key];
  const meta = json[META_KEY];
  if (isRootLookup(meta)) {
    for (const key of Object.keys(meta)) {
      if (isPagedMarkerEntry(META_KEY, key)) delete meta[key];
    }
  }
  // A paged root holds its records inside page entries beside the store's
  // own edit bookkeeping, so flatten it to the same record lookup
  // `doc.map(root).read()` hands back: a serializer and a whole-document
  // renderer read this surface, and a store that crossed the paging
  // threshold has to reach them as records. Every root is asked, because a
  // root no handle was ever taken on is paged by the same rule as one that
  // was; a root the marker does not name comes back as loro produced it.
  for (const [rootKey, value] of Object.entries(json)) {
    if (!isRootLookup(value)) continue;
    if (!readRootPaged(source, rootKey)) continue;
    json[rootKey] = flattenPagedLookup(value, true);
  }
  return json;
}

/** A CRDT engine holding decoded join content. */
function engineFrom(content: JoinContent): LoroDoc {
  const doc = new LoroDoc();
  if (content.kind === 'crdt') doc.import(content.bytes);
  else if (content.kind === 'frozen') doc.import(snapshotFromSealedContent(content.content));
  return doc;
}

/**
 * A version of a Document over frozen content, as the content its handles read.
 *
 * Frozen content with nothing above it is the version itself. Anything else
 * (a version stored as a CRDT, or a tail over the seal) is materialised and
 * read back as content: a preview takes no write, so the engine it needs is
 * built for the read and freed after it.
 */
function frozenPreview(content: JoinContent, tailOpBlobs: Uint8Array[]): SealedContent {
  if (content.kind === 'frozen' && tailOpBlobs.length === 0) return content.content;
  const engine = engineFrom(content);
  try {
    for (const blob of tailOpBlobs) importTailOp(engine, blob);
    return SealedContent.fromJSON(engineJSON(engine) as SealedContentJson);
  } finally {
    engine.free();
  }
}

export function snapshotFromSealedStore(store: SealedStore): Uint8Array {
  return snapshotFromSealedContent(store.content);
}

/** What a record-store writer is handed. */
export interface RecordStoreSource {
  schemaVersion: string;
  header: readonly { tag: string; body: unknown }[];
  /** Walks every record, in order. */
  forEachRecord(
    visit: (key: string, tag: string | null, body: unknown) => void,
  ): void;
}

/**
 * Write a record store as a CRDT snapshot through the one conversion every
 * frozen stream takes.
 */
export function recordStoreSnapshot(source: RecordStoreSource): Uint8Array {
  const records: [string, string | null, unknown][] = [];
  source.forEachRecord((key, tag, body) => {
    records.push([key, tag, body]);
  });
  return snapshotFromSealedContent(
    SealedContent.fromRecords({
      schemaVersion: source.schemaVersion,
      header: source.header,
      records,
    }),
  );
}

/**
 * Materialises a line at a version: the content the join names, the tail
 * above it, and the version the server resolved. `streamSeqs` is the per-stream
 * seq vector at that version (from the newest checkpoint at or below it),
 * `{ line_id: seq }`, which lets a preview bring every opened stream to the
 * same point; absent for a stream line's own timeline and before any
 * checkpoint recorded one.
 * @internal
 */
export type CheckoutFetcher = (
  docId: string,
  version: number,
  branchId: string,
) => Promise<{
  content: JoinContent;
  tailOpBlobs: Uint8Array[];
  effectiveVersion: number;
  streamSeqs?: Record<string, number>;
}>;

export class Document {
  private _importReport: ImportReport | null = null;
  private _changed = false;
  private _changeNotice: ((fire: () => void) => () => void) | null = null;
  private _stopChangeNotice: (() => void) | null = null;
  private readonly _changedListeners = new Set<() => void>();
  // A frozen copy's reload, wired by the transport: re-joins and applies the
  // result in place. `null` on every other open.
  private _frozenReloader: (() => Promise<void>) | null = null;
  // Opens this document again in another mode. Installed by whichever layer
  // opened it: the session for the document it holds, the client otherwise.
  private _reopener: ((mode: ReopenMode) => Promise<OpenedDocument>) | null = null;
  private _reloading: Promise<void> | null = null;
  // `onStatus` listeners on a frozen copy, which hears status on the same
  // notice the change report rides.
  private _statusWatches = 0;
  private _inputsRuntime: InputsStatusRuntime | null = null;
  // Built on the first status subscription.
  private _inputStatusHub: InputStatusHub | null = null;
  // The `subscribeInputDocuments` followers, which close and park stop so no
  // retry, handler or kept copy outlives the document.
  private readonly _inputFollowers = new InputFollowers();

  // The CRDT engine. `null` until something reads it: a Document over frozen
  // content never does, so it holds no engine at all.
  private _engine: LoroDoc | null;
  private _rootKey: string;
  // Server-minted `doc_id`, or `null` when constructed without one
  // (test / offline path).
  private readonly _docId: string | null;
  private readonly _branchId: string | null;
  // Active checkout state. `null` means the Document is on the live
  // head of `_branchId`: edits are accepted, the WS stream applies
  // remote ops directly to `_doc`. A non-null state means a historical
  // version is being previewed: `_checkout.previewDoc` holds the
  // materialised state at that version, reads go through it, and
  // `mutate` throws. The LIVE `_doc` keeps receiving ops in the
  // background; returning to head just clears the checkout state and
  // the live state is already current.
  private _checkout: {
    previewDoc: LoroDoc;
    previewRoot: LoroMap;
    version: number;
  } | null;
  // Bumped by every `_checkoutVersion` (before its await) and every
  // `returnToHead`. A `_checkoutVersion` reads its token before awaiting the
  // fetch and bails after if the token moved, so a return-to-live or a newer
  // checkout issued during the fetch window wins instead of being overwritten
  // when the stale fetch resolves. Without it, `returnToHead` sees
  // `_checkout === null` mid-fetch, no-ops, and the resolving checkout strands
  // the doc in the historical preview the user just left.
  private _checkoutGeneration = 0;
  // True for Documents that have no live WS channel: the cold-link
  // `Brass.openDocumentById(id, { version })` shape. Such Documents
  // are frozen at the constructor-time version; `_checkoutVersion`
  // and `returnToHead` reject. The live + checkout-on-demand path
  // leaves this `false`.
  private readonly _isFrozen: boolean;
  // The frozen content this Document reads, when the platform holds its
  // content in that encoding. Its roots serve `map` / `list` / `orderedMap`
  // and `toJSON` in place of the CRDT's, so an app reads one document
  // surface whichever way the content is stored. `null` for a CRDT document.
  private _sealedRoots: SealedRoots | null;
  // The frozen content at the head, and the content the roots read now: the
  // head, or a version a checkout swapped in. `null` with `_sealedRoots`.
  private _frozenHead: SealedContent | null;
  private _frozenShown: SealedContent | null;
  // The version a Document over frozen content is showing, or `null` for its
  // head.
  private _frozenVersion: number | null = null;
  // The seq the frozen content was sealed at, which is what says whether a
  // later join's frozen content is the same content.
  private _frozenSeal: number | null;
  // What `map` / `list` / `text` / `orderedMap` hand out: one handle per
  // root, over whichever storage this Document holds now.
  private readonly _handles = new StableHandles((err) => this._handleOwner.reportSubscriberThrow(err));
  // What an engine built for this Document after construction is built with:
  // the root a CRDT open would root `mutate` at, and the caller's engine
  // options.
  private _engineRootKey: string;
  private readonly _engineOptions: Pick<DocumentOptions, 'peerId' | 'undo'>;
  // Swaps this Document's frozen content for the CRDT the server now holds,
  // wired by the transport. Absent, a remote op over frozen content reloads.
  private _storageUpgrader: (() => void) | null = null;
  // Forced read-only on a LIVE head open (distinct from `_isFrozen`, which
  // is a version-pinned open with no live channel): the Document keeps a
  // live WS subscription and applies incoming remote ops, but local
  // `mutate` is rejected, so the reader sees edits stream in while being
  // unable to write. Set at open from the join's `can_edit` (a viewer's
  // grant, a view-only link), and latched on afterwards by
  // `_markReadOnly` when the server refuses a write on the same grounds.
  private _forcedReadOnly: boolean;
  // Set while `reopen` replaces this copy (see the `reopening` reason).
  private _reopening = false;
  private _pendingReopen: PendingReopen | null = null;
  // Which refusal `_forcedReadOnly` stands for, so `mutate` names it.
  private _readOnlyReason: ForcedReadOnlyReason;
  // The UndoManager is constructed eagerly so the first call to
  // `doc.mutate(...)` lands in the undo stack. Lazy construction
  // (deferred to first `doc.undo()`) would miss every commit made
  // before that point, which is not the behaviour callers expect.
  // The UndoManager attaches its own `subscribeLocalUpdates` listener
  // only; it does NOT fire on snapshot import, so the
  // cold-load contract is unaffected (imports are not local commits).
  private _undo: UndoController | null;
  // The document's one undo stack across its streams. A Document owns the
  // group it was created with; a stream's own Document joins its document's
  // group when the stream opens (`_joinUndoGroup`).
  private _undoGroup: UndoGroup = new UndoGroup();
  // One subscriber channel. Every event reaches every subscriber, whatever
  // produced it (local mutate, remote import, undo, redo, checkout); the
  // app reconciles by value and reads `origin.source` only when it has a
  // non-render reason to know the cause. A throwing subscriber is swallowed
  // so it cannot strand the others or the WS router.
  private readonly _subs = createEmitter<SyntheticSubscribeEvent>({
    onError: () => {},
  });
  // Subscribers registered via `subscribeUndoState`. Fired after
  // every underlying Loro event when `canUndo()` or `canRedo()`
  // changed value vs the last fire, so UI bound to undo/redo
  // enabled state stays current without the consumer caring
  // whether the originating event was a local mutate, undo,
  // redo, or remote import.
  private readonly _undoStateSubs: Set<UndoStateSubscriber> = new Set();
  private _lastCanUndo = false;
  private _lastCanRedo = false;
  private _replayingUndo = false;
  // The change a replay produced, held until the replay ends so `subscribe`
  // fires once per `undo()` / `redo()`. A listener that writes in reaction
  // would otherwise commit mid-replay, joining the step being replayed.
  private _replayChange: ChangeSource | null = null;
  private _unsubLoro: (() => void) | null = null;
  private _unsubLocal: (() => void) | null = null;
  // Local commits drive this hook with the resulting op blob; the hook
  // returns a `clientOpId` tracked for `op_ack` correlation. In-flight
  // op bytes (keyed by `clientOpId`) live in `_outstandingByClientId`;
  // `applyRemoteOp` checks them to short-circuit self-originated
  // round-trips.
  private _localOpHook: LocalOpSendHook | null = null;
  // Materialises a historical version against the server; returns the
  // snapshot bytes (or null) + tail op blobs + effective version.
  private _checkoutFetcher: CheckoutFetcher | null = null;
  // The stream seq vector from the active preview, so a stream opened WHILE
  // a preview is active can open at its historical seq too. Cleared on
  // `returnToHead`.
  private _checkoutStreamSeqs: Record<string, number> | null = null;
  // Transport-provided cursor for the branch's live head seq. A
  // provider (not a stored number) so the Document never has to be
  // notified of every op. `null` on the offline / test path; a
  // read-only historical open reports its frozen `version` instead.
  private _currentSeqProvider: (() => number) | null = null;
  private readonly _branchCtl = new BranchController({
    docId: (): string | null => this._docId,
    branchId: (): string | null => this._branchId,
    isActive: (): boolean => this._isLive,
    onBranchesChanged: (): void => {
      this._fireSubscribers({ kind: 'branches' });
    },
  });
  // The version of the newest picture the server holds of this document, or
  // `null` for none. Seeded from the join and moved by this instance's own
  // uploads; a picture older than the document's head is what arms the seed
  // trigger, so a placeholder taken before the content arrived is replaced
  // once it does.
  private _thumbnailVersion: number | null = null;
  private readonly _thumbnails = new ThumbnailCapture({
    // `_forcedReadOnly` and not the whole `readOnly`: the server refuses a
    // thumbnail from a reader it will not take writes from, so a capture
    // there costs a request and a warn to be told so. The load lock is the
    // other half of `readOnly` and must NOT gate this, because a document
    // still hydrating is exactly the one the seed watch is armed for, and
    // the arm happens while that lock is still on.
    isCaptureAllowed: (): boolean =>
      this._isLive && this._previewVersion === null && !this._forcedReadOnly,
    isAttached: (): boolean => this._isLive,
    currentVersion: (): number | null => this.currentSeq,
    onCaptured: (version?: number): void => {
      this._thumbnailVersion = version ?? this.currentSeq ?? 0;
    },
  });
  private readonly _checkpoints = new CheckpointScheduler({
    docId: (): string | null => this._docId,
    isAttached: (): boolean => this._isLive,
    isAutoAllowed: (): boolean =>
      this._isLive && this._previewVersion === null,
    currentSeq: (): number | null => this.currentSeq,
    sealUndoStep: (): void => {
      this._undoGroup.seal();
    },
    hasUnsavedOps: (): boolean => this.savingCount > 0,
    whenLocalOpsSaved: (): Promise<boolean> => whenSaved(this),
    captureFrame: () => this._thumbnails.captureFrame(),
    uploadFrame: (frame, version): void => {
      // The debounced capture usually lands first, at the same version.
      if (this._thumbnailVersion === version) return;
      void this._thumbnails.uploadFrame(frame, version);
    },
  });
  // Drive push hook. `null` on the offline / test path; `pushToDrive`
  // then throws with a clear message rather than silently dropping.
  private _drivePusher:
    | ((input: PushToDriveInput) => Promise<PushToDriveResult>)
    | null = null;
  // Drive divergence-resolution hook. Mirrors `_drivePusher`: `null` on
  // the offline / test path, in which case `resolveDrive` throws with a
  // clear message. Wired by `client.ts` to open the hosted resolve
  // surface and route any new mirror doc through `openSiblingDoc`.
  private _driveResolver: (() => Promise<DriveResolveResult | null>) | null =
    null;
  // Source-blob fetch hook. When supplied, `doc.sourceBlob()` routes
  // through it (the namespace's `GET .../source-blob`). When absent
  // (tests / offline), `sourceBlob` throws with a clear message rather
  // than silently dropping. Wired by `client.ts` from
  // `documents.sourceBlob`.
  private _sourceBlobFetcher: (() => Promise<DocumentSourceBlob>) | null = null;
  // Cached doc name. `null` on offline / test docs.
  private _name: string | null = null;
  // When the platform will remove this document, for one created without an
  // account; `null` for every other document.
  private _expiresAt: Date | null = null;
  // True once the reader has asked for the version-browsing surface without
  // checking anything out (the hosted history dialog's browse-in-the-app
  // outcome). The host's version bar latches on this as well as on a live
  // checkout, so browsing can start at the live head.
  private _versionBrowsing = false;
  private readonly _commandMenu = new CommandMenu({
    docId: (): string | null => this._docId,
    branchId: (): string | null => this._branchId,
    readOnly: (): boolean => this.readOnly,
    isLive: (): boolean => this._isLive,
    canUndo: (): boolean => this.canUndo(),
    canRedo: (): boolean => this.canRedo(),
    undo: (): void => {
      this.undo();
    },
    redo: (): void => {
      this.redo();
    },
    checkoutVersion: (version): Promise<void> => this._checkoutVersion(version),
    browseVersions: (): void => {
      this._setVersionBrowsing(true);
    },
    branches: (): readonly BranchSummary[] => this._branchCtl.branches,
    hasBranchProvider: (): boolean => this._branchCtl.hasProvider,
    createBranch: (input): Promise<BranchSummary> =>
      this._branchCtl.create(input),
    refreshBranches: (): Promise<void> => this._refreshBranches(),
    setName: (name): void => this._setName(name),
    onCommandsChanged: (): void => {
      this._fireSubscribers({ kind: 'commands' });
    },
  });
  // The clientOpId of every local op that has not yet been acked. The
  // open-document layer drains this on `op_ack`. Tracking is keyed by
  // clientOpId, not op-blob bytes, because clientOpId is what the
  // server echoes back; the blob is opaque to Brass.
  private readonly _outstandingByClientId: Map<string, Uint8Array> = new Map();
  // client_op_ids of the in-flight resync push (durability handshake). A
  // push can be a single op or several chunks for a large divergence, so
  // this is a set. The loop guard: while any chunk is unacked, the
  // handshake skips a fresh push so a flurry of reconnects cannot re-push
  // the same missing slice. Each id is removed by `resolveOutstandingOp`
  // when its ack lands; the guard reopens once the set drains.
  private readonly _resyncPushClientOpIds = new Set<string>();
  // Async-error sink, shared with the built-in commands. `_failOutstandingOp`
  // surfaces a terminally-rejected op here so a "could not be saved" outcome
  // reaches the app instead of being a silent forever-retry.
  private _errorReporter: ((err: Error) => void) | null = null;
  // Set when this document was opened expecting a live transport that was not
  // available. A write then changes local state and reaches no server, so the
  // first one is reported rather than dropped in silence.
  private _transportExpected = false;
  private _transportUnavailableReported = false;
  private _closed = false;
  // Set true when the Document is parked in the SDK's per-(docId, branchId)
  // cache after an app-level `close()`. The underlying LoroDoc, UndoController,
  // and WS subscription stay alive so the next `openDocumentById` for the
  // same key returns this same instance with its undo stack intact. The
  // user-facing API gates as if the Doc were closed: `mutate` throws, no
  // events fire to app-side subscribers (`_subs`
  // and the gone / work-status signal listeners are cleared on suspend so
  // a stale handle from a prior session does not receive events from the
  // next session). `_resume()`
  // flips the flag back when the SDK hands the Doc to a new open() call.
  private _suspended = false;
  // How many times this instance has been handed to an open. The park cache
  // hands the SAME Document back on a reopen, so "this document is open" is
  // not one interval per instance and a per-instance mark cannot say which
  // open it was made in. Anything that spends a once-per-open budget on a
  // Document (the import runner's one attempt) records this alongside its
  // mark and re-reads it, so a reopen is a new open rather than the old one
  // continuing.
  private _openEpoch = 0;
  // Live = neither closed nor parked. This is the public-surface gate;
  // internal ingress (remote ops, status emits) deliberately checks
  // `_closed` alone, because a parked doc keeps applying remote state.
  // Readable from the SDK's own layers (the client's open-document set
  // gates on it) rather than only from inside this class.
  /** @internal */
  get _isLive(): boolean {
    return !this._closed && !this._suspended;
  }

  private _assertOpen(): void {
    if (!this._isLive) throw new Error('Document is closed');
  }

  // `close()` releases the CRDT state, so a read after it reaches released
  // memory and fails with whatever the engine says about that. Reads are gated
  // on this rather than on `_assertOpen` because a parked Document still holds
  // its state and answers from it.
  private _assertNotClosed(): void {
    if (this._closed) throw new Error('Document is closed');
  }
  // Server-pushed lifecycle signals: `_gone` is fire-once-then-cache
  // for `doc_gone` eviction; `_workStatus` is latest-retained,
  // re-emit-per-phase for `doc_status`.
  private readonly _gone = new GoneSignal();
  private readonly _workStatus = new WorkStatusSignal();
  // Inbound work ended without delivering content, so this doc holds
  // nothing and stays locked. See `_emitStatus` for how it is derived.
  private _loadFailed = false;
  // Drive sync state, latest-retained. `null` until the open factory
  // seeds it (drive-linked docs only) and on docs with no drive link.
  private readonly _driveStatus = new DriveStatusSignal();
  // Where this document could be published when it mirrors nothing yet.
  // Seeded from the open, emptied once it becomes a mirror.
  private readonly _drivePublishTarget = new DrivePublishTargetSignal();

  // Document-scoped presence. `null` until the WS transport is wired
  // on, and on the offline / test path where there is no transport.
  presence: import('./presence.js').PresenceClient | null = null;

  // A Document owns the LoroDoc it wraps, so it is built through the factories
  // below (or `documentFromEngine`, for in-repo tooling that brings its own).
  // Owning construction is what lets this class declare an engine-neutral
  // surface: app code holds a Document, never the doc underneath it.
  private constructor(loroDoc: LoroDoc | null, options?: DocumentOptions) {
    this._undoGroup.setOwner(this, {
      blocked: (): boolean => this._undoGroupBlocked(),
      notify: (): void => this._maybeFireUndoState(),
      // A write to another stream is an edit like one here, so it arms the
      // same idle checkpoint, which is what seals the step it opened.
      memberCommitted: (): void => this._checkpoints.scheduleAuto(),
    });
    this._engine = loroDoc;
    this._rootKey = options?.rootKey ?? 'entities';
    this._engineRootKey = this._rootKey;
    this._engineOptions = {
      ...(options?.peerId !== undefined ? { peerId: options.peerId } : {}),
      ...(options?.undo !== undefined ? { undo: options.undo } : {}),
    };
    this._docId = options?.docId ?? null;
    this._branchId = options?.branchId ?? null;
    // A Document constructed with a `version` is a "frozen" cold-link
    // open: the SDK materialised the historical state directly into
    // `loroDoc` and there is no live WS channel. The Document is
    // permanently in checkout against itself; `returnToHead` /
    // `_checkoutVersion` are not meaningful on this shape.
    const frozen = options?.frozenContent;
    const initialVersion = options?.version ?? null;
    if (initialVersion !== null) {
      this._isFrozen = true;
      if (loroDoc !== null) {
        this._checkout = {
          previewDoc: loroDoc,
          previewRoot: loroDoc.getMap(this._rootKey),
          version: initialVersion,
        };
      } else {
        this._checkout = null;
        this._frozenVersion = initialVersion;
      }
    } else {
      this._isFrozen = false;
      this._checkout = null;
    }
    // `readOnly` on a live (non-version) open is a forced read-only: a
    // reader the server will not accept writes from, whether because their
    // grant is view-only or because the link they came through is. A
    // version open is already frozen, so it does not also need the flag.
    // A stored record set answers every read directly, and takes no write: a
    // record set holds no op log for an edit to become, and making one is the
    // platform's (see `open-document.ts`, where the join serves a record set
    // only to a reader). So an app reads one document surface and never
    // learns which encoding it was handed, and the write it cannot make is
    // refused by the same read-only gate every other unwritable open uses.
    this._frozenHead = frozen ?? null;
    this._frozenShown = frozen ?? null;
    this._frozenSeal = options?.frozenSeal ?? null;
    this._sealedRoots =
      frozen === undefined
        ? null
        : sealedRoots(
            () => this._frozenShown!,
            () => this._handleOwner.assertWritable(),
          );
    this._forcedReadOnly = options?.readOnly === true && initialVersion === null;
    this._readOnlyReason = options?.readOnlyReason ?? 'link';
    if (loroDoc !== null) {
      if (options?.peerId !== undefined) loroDoc.setPeerId(options.peerId);
      // Materialize the root container, so a document nothing has written to
      // still carries its root in the shape a reader opens it with.
      loroDoc.getMap(this._rootKey);
      this._undo = this._newUndoController(loroDoc, options?.undo);
    } else {
      this._undo = null;
    }
  }

  // The engine, built on first use for a Document constructed without one.
  private get _doc(): LoroDoc {
    if (this._engine === null) {
      this._engine = new LoroDoc();
      this._engine.getMap(this._rootKey);
    }
    return this._engine;
  }

  /** Whether this Document has been closed. @internal */
  get _isClosed(): boolean {
    return this._closed;
  }

  /** Whether this Document has built a CRDT engine. @internal */
  _holdsEngine(): boolean {
    return this._engine !== null;
  }

  /** The seq this Document's frozen content was sealed at, or `null` for a
   *  CRDT document or a seal the join did not name. @internal */
  get _frozenSealSeq(): number | null {
    return this._frozenSeal;
  }

  // The version this Document is showing instead of its head, or `null`.
  private get _previewVersion(): number | null {
    return this._checkout?.version ?? this._frozenVersion;
  }

  // ---- Typed container handles (the primary read/write/subscribe surface) --
  //
  // Handles scope reads, writes, and subscriptions to one container in
  // the underlying CRDT doc. The README leads with this surface; the
  // doc-wide `mutate` / `subscribe` / `toJSON` methods below stay as a
  // simpler-but-slower fallback for tiny docs and one-liner integrations.
  //
  // Identity: handles are cached per (key, kind), so
  // `doc.map('entities') === doc.map('entities')` and bindings to the
  // handle compare stable across renders.

  // Cached root handles, keyed by kind + key so `doc.map('x')` and
  // `doc.list('x')` coexist. One map, not one per kind, so a version checkout
  // rebinds and each suspend / close tears down every root handle in a single
  // traversal.
  private readonly _rootHandles = new Map<
    string,
    | { kind: 'map'; key: string; handle: MapHandle<unknown> }
    | { kind: 'list'; key: string; handle: ListHandle<unknown> }
    | { kind: 'text'; key: string; handle: RootTextHandle }
  >();

  // Names the pages this Document's writes may occupy. A page is one value,
  // so two writers appending to the same page container would resolve
  // last-writer-wins and lose one writer's records; the token is what keeps
  // their key spaces apart. Loro's peer id is already unique per open, which
  // is exactly the scope wanted.
  private get _pagingSessionToken(): string {
    return this._doc.peerIdStr;
  }

  /** Whether this document's reads are answered by a stored record set.
   *  @internal */
  _holdsRecordSet(): boolean {
    return this._sealedRoots !== null;
  }

  // Get a handle for a top-level LoroMap at `key`. The container is
  // materialized in the underlying LoroDoc immediately (Loro's
  // `getMap` is "get or create"); mutations through the handle do
  // not need to create the container themselves.
  map<T = unknown>(key: string): MapHandle<T> {
    this._assertOpen();
    assertAppRootName(key);
    return this._handles.root(`map:${key}`, 'map', () => this._rootMap<T>(key));
  }

  private _rootMap<T>(key: string): MapHandle<T> {
    const cacheKey = `map:${key}`;
    const existing = this._rootHandles.get(cacheKey);
    if (existing) return existing.handle as unknown as MapHandle<T>;
    if (this._sealedRoots !== null) {
      const handle = this._sealedRoots.map<unknown>(key);
      this._rootHandles.set(cacheKey, { kind: 'map', key, handle });
      return handle as unknown as MapHandle<T>;
    }
    // Source the LoroMap from the active source (live or checkout
    // preview), same as `toJSON` does. Handles bound to a Document
    // in checkout see the historical state via the preview doc.
    const source =
      this._checkout !== null ? this._checkout.previewDoc : this._doc;
    const loroMap = source.getMap(key);
    // The page-count provider lets a handle over a large record store's
    // `instances` map present its page containers transparently as a
    // flat record map. It resolves the ACTIVE source at call time (not
    // the one captured at handle creation): a checkout rebinds the
    // handle's anchor to the preview doc, and the page state must come
    // from that same doc or a read takes the wrong path for the state it is
    // looking at (and a closure pinned to a preview doc would read a freed
    // LoroDoc after returnToHead).
    //
    // EVERY root map gets the providers, because a `meta` key of its own is
    // what names a paged root: a root with no such key reads as unpaged, which
    // is the answer `meta` and `header` want anyway. Naming one root here
    // instead would make paging a property of a reserved key rather than of a
    // collection, so a map an app owns could never be paged however large it
    // grew.
    const activeSource = (): LoroDoc =>
      this._checkout !== null ? this._checkout.previewDoc : this._doc;
    const handle = createRootMapHandle<unknown>(loroMap, this._handleOwner, {
      isPaged: (): boolean => readRootPaged(activeSource(), key),
      page: (): void => {
        pageRoot(this._doc, key, this._handleOwner.commitMutate);
      },
      sessionToken: (): string => this._pagingSessionToken,
      stateVersion: (): StateVersion => activeSource().frontiers(),
    }, key);
    this._rootHandles.set(cacheKey, { kind: 'map', key, handle });
    return handle as unknown as MapHandle<T>;
  }

  // Get a handle for a top-level LoroMovableList at `key`.
  list<T = unknown>(key: string): ListHandle<T> {
    this._assertOpen();
    assertAppRootName(key);
    return this._handles.root(`list:${key}`, 'list', () => this._rootList<T>(key));
  }

  private _rootList<T>(key: string): ListHandle<T> {
    const cacheKey = `list:${key}`;
    const existing = this._rootHandles.get(cacheKey);
    if (existing) return existing.handle as unknown as ListHandle<T>;
    if (this._sealedRoots !== null) {
      const handle = this._sealedRoots.list<unknown>(key);
      this._rootHandles.set(cacheKey, { kind: 'list', key, handle });
      return handle as unknown as ListHandle<T>;
    }
    const source =
      this._checkout !== null ? this._checkout.previewDoc : this._doc;
    const loroList = source.getMovableList(key);
    const handle = createRootListHandle<unknown>(loroList, this._handleOwner);
    this._rootHandles.set(cacheKey, { kind: 'list', key, handle });
    return handle as unknown as ListHandle<T>;
  }

  // Get an ordered-map handle binding a keyed map at `mapKey` to a sibling
  // order list at `orderKey`: adds append to the order list, deletes prune
  // it, both in one commit, so an app cannot leave the two out of step.
  // The record store every imported document carries is reached as
  // `doc.orderedMap('instances', 'instance_order')`; the primitive itself
  // is format-neutral (two root containers, no record-store knowledge).
  // Built over the same `map(mapKey)` / `list(orderKey)` handles, so the
  // paged-store presentation and subscriptions carry through.
  private readonly _orderedMapHandles = new Map<
    string,
    OrderedMapHandle<unknown>
  >();
  /**
   * A handle on the top-level text container at `key`, which `roots()` reports
   * as kind `'text'`.
   *
   * Cached per key, so `doc.text('x') === doc.text('x')` holds as it does for
   * `doc.map`, and a subscriber registered through one keeps firing across a
   * version checkout.
   */
  text(key: string): TextHandle {
    this._assertOpen();
    assertAppRootName(key);
    return this._handles.root(`text:${key}`, 'text', () => this._rootText(key));
  }

  private _rootText(key: string): TextHandle {
    const cacheKey = `text:${key}`;
    const existing = this._rootHandles.get(cacheKey);
    if (existing) return existing.handle as TextHandle;
    if (this._sealedRoots !== null) return this._sealedRoots.text(key);
    const owner = this._handleOwner;
    const activeSource = (): LoroDoc =>
      this._checkout !== null ? this._checkout.previewDoc : this._doc;
    // Reads and writes resolve the active source per call, so a checkout
    // needs no rebinding for them. A SUBSCRIPTION cannot work that way: it
    // anchors a listener to one container, and a checkout preview is a
    // different LoroDoc, so the anchor has to be moved. That is what makes
    // this handle cached and registered like a map or a list, rather than a
    // fresh object per call: the app holds the object the rebind reaches.
    let anchor: LoroText = activeSource().getText(key);
    const subscribers = new Set<TextSubscriber>();
    let detach: (() => void) | null = null;
    // The string this handle's own `update` has just written, armed only
    // across the synchronous window in which `commit` fires the Loro
    // subscriber. Materializing a text container is the one cost here that
    // grows with a document's accumulated edit history rather than with its
    // length, and `update` has already paid it once to diff against, so a
    // fanout that materialized again would double the per-keystroke cost of
    // exactly the field the README teaches. Anything else, a remote op or a
    // checkout, finds it null and materializes.
    let justWrote: string | null = null;
    const fanout = (origin?: ChangeOrigin): void => {
      // Read for the local write alone. A change from any other source
      // describes a container this handle did not write, so its value comes
      // from the container even while a local write is arming one.
      const value =
        (origin?.source === 'local' ? justWrote : null) ?? anchor.toString();
      // Fired off a snapshot: a subscriber may unsubscribe (or register
      // another) while it runs, and the set it is iterating is the one that
      // changes underneath it.
      const current = Array.from(subscribers);
      for (const cb of current) cb(value, origin);
    };
    const attach = (): void => {
      if (detach !== null || subscribers.size === 0) return;
      detach = anchor.subscribe((event) => {
        fanout({ source: owner.originOf(event) });
      });
    };
    const handle: RootTextHandle = {
      read: (): string => {
        owner.assertReadable();
        return activeSource().getText(key).toString();
      },
      update: (next: string): void => {
        owner.assertWritable();
        owner.ensureLocalUpdatesSubscribed();
        activeSource().getText(key).update(next);
        // Armed after the write, so the container already holds `next` for
        // every subscriber the commit reaches, and cleared however the
        // commit returns: outside this window the fanout has no way to know
        // the value is still current, and reads it. Armed only for a string
        // the container holds verbatim, so a subscriber is never handed a
        // value the document and its peers disagree with.
        justWrote = storedVerbatim(next) ? next : null;
        try {
          owner.commitMutate();
        } finally {
          justWrote = null;
        }
      },
      subscribe: (cb: TextSubscriber): (() => void) => {
        owner.assertReadable();
        subscribers.add(cb);
        attach();
        // No origin: a registration fire describes no authored transition,
        // matching what a map subscriber's first fire carries.
        cb(anchor.toString(), undefined);
        return (): void => {
          subscribers.delete(cb);
          if (subscribers.size === 0 && detach !== null) {
            detach();
            detach = null;
          }
        };
      },
      _rebind: (next: LoroText): void => {
        if (detach !== null) {
          detach();
          detach = null;
        }
        anchor = next;
        attach();
      },
      // A checkout or a return to head swaps the container rather than
      // writing into it, so the catch-up fire carries no origin.
      _resync: (): void => {
        fanout(undefined);
      },
      // Detach the container subscription and forget the callbacks behind it,
      // as a map or a list handle does: the Document drops its handle cache
      // here, so an app still holding this one subscribes onto a handle
      // nothing else reaches, and every callback registered before the park
      // would come back with it.
      _teardown: (): void => {
        if (detach !== null) {
          detach();
          detach = null;
        }
        subscribers.clear();
      },
    };
    this._rootHandles.set(cacheKey, { kind: 'text', key, handle });
    return handle;
  }

  orderedMap<T = unknown>(
    mapKey: string,
    orderKey: string,
  ): OrderedMapHandle<T> {
    this._assertOpen();
    return this._handles.root(`ordered:${mapKey}\u0000${orderKey}`, 'map', () =>
      this._rootOrderedMap<T>(mapKey, orderKey),
    );
  }

  private _rootOrderedMap<T>(mapKey: string, orderKey: string): OrderedMapHandle<T> {
    const cacheKey = `${mapKey}\u0000${orderKey}`;
    let h = this._orderedMapHandles.get(cacheKey);
    if (!h && this._sealedRoots !== null) {
      // Taken from the store rather than composed from this document's own
      // map + list handles: the composition exists to keep a map and its
      // order list in step through writes, and a stored record set has none.
      h = this._sealedRoots.orderedMap<unknown>(mapKey, orderKey);
      this._orderedMapHandles.set(cacheKey, h);
    }
    if (!h) {
      h = createOrderedMapHandle<unknown>(
        this._rootMap(mapKey),
        this._rootList<string>(orderKey),
        this._handleOwner,
      );
      this._orderedMapHandles.set(cacheKey, h);
    }
    return h as unknown as OrderedMapHandle<T>;
  }

  // Stable handle-owner closure: handles call back into this to
  // participate in the standard commit + origin machinery. The bind
  // happens once on first access; later mutations through any handle
  // route through the same closure so the local-op hook, undo stack,
  // and subscribe local-echo filter all fire correctly.
  private _handleOwnerCache: HandleOwner | null = null;
  private get _handleOwner(): HandleOwner {
    if (this._handleOwnerCache) return this._handleOwnerCache;
    this._handleOwnerCache = {
      assertReadable: (): void => {
        this._assertNotClosed();
      },
      assertWritable: (): void => {
        this._assertOpen();
        const reason = this._readOnlyBecause;
        if (reason !== null) throw new Error(READ_ONLY_MESSAGES[reason]);
      },
      ensureLocalUpdatesSubscribed: (): void => {
        this._ensureLocalUpdatesSubscribed();
      },
      commitMutate: (): void => {
        this._doc.setNextCommitOrigin(this._mutateCommitOrigin);
        this._doc.commit();
      },
      runMutate: (options: MutateOptions | undefined, fn: () => void): void => {
        this._runInMutate(options?.undoable !== false, fn);
      },
      originOf: (event: unknown): ChangeSource => changeSourceOf(event),
      reportSubscriberThrow: (err: unknown): void => {
        this._reportSubscriberThrow(err);
      },
    };
    return this._handleOwnerCache;
  }

  // Server-minted `doc_id`. Always a string for a Document returned
  // from `Brass.openDocumentById` / `Brass.createDocument`; `null`
  // only on the direct-construction (test / offline) path.
  get id(): string | null {
    return this._docId;
  }

  /**
   * The branch this Document is open on, fixed for its lifetime (switching
   * branches opens a new Document). `null` only on the offline / test path.
   * The SDK reads it to scope WS / presence topics and thumbnail /
   * checkpoint writes to the branch.
   * @internal
   */
  get branchId(): string | null {
    return this._branchId;
  }

  // True when this reader cannot write to the document right now:
  // `mutate` throws and edit affordances should be disabled. It covers a
  // view-only grant, a view-only share link, a historical version showing
  // (a checkout), and a document whose content is still loading or could
  // not be loaded. Reactive in every one of those: `subscribe` fires when
  // it changes, so an app binds it directly inside the subscribe handler
  // and follows a grant the server withdraws mid-session as well as a
  // checkout the reader entered.
  get readOnly(): boolean {
    return this._readOnlyBecause !== null;
  }

  /**
   * The refusal message when this reader's access, a view-only link, or this
   * app's standing keeps them from writing however the document is opened,
   * else null. `session.edit()` rejects with it rather than reopening.
   * @internal
   */
  get _editRefusal(): string | null {
    const reason = this._forcedReadOnly ? this._readOnlyReason : null;
    if (reason === 'grant' || reason === 'link' || reason === 'app') {
      return READ_ONLY_MESSAGES[reason];
    }
    return null;
  }

  /**
   * Why this reader cannot write, or null when they can.
   *
   * The one place the conditions are listed. `readOnly` asks whether there is
   * a reason and `mutate` refuses with the reason's own message, so the two
   * cannot answer differently about the same document, and a new reason
   * reaches both by being added here.
   *
   * Order decides which message a reader sees when several hold at once, and
   * it runs from the state they are in to the state they were put in: a
   * checkout and an open version bar are things this reader did and can
   * undo, so naming those first tells them what to do. A load that has not
   * finished comes last because it clears on its own.
   */
  private get _readOnlyBecause(): ReadOnlyReason | null {
    if (this._previewVersion !== null) return 'version';
    if (this._versionBrowsing) return 'browsing';
    if (this._forcedReadOnly) return this._readOnlyReason;
    if (this._reopening) return 'reopening';
    if (this._loadFailed) return 'load_failed';
    if (this._isLoadLocked()) return 'loading';
    return null;
  }

  // True when content-replacing work (hydration / extraction) is pending
  // and editing must be locked so incoming bytes do not clobber local
  // ops, and true again once that work ends without content
  // (`_loadFailed`): a doc nothing could prepare is empty, and an edit
  // there writes ops into a document the app is about to be told could not
  // be opened. A pending PUSH is outbound (it writes the doc out to the
  // drive, nothing replaces local content), so the server marks it
  // `blocking: false` and the doc stays editable while the importer
  // runs. An older server omits `blocking`; absence is treated as
  // blocking so hydration stays locked.
  private _isLoadLocked(): boolean {
    if (this._loadFailed) return true;
    const s = this._workStatus.work;
    return s?.pending === true && s.blocking !== false;
  }

  /**
   * Whether inbound work on this document ended without content. The SDK's
   * session reads it to report the open as failed rather than binding an
   * empty document as ready.
   * @internal
   */
  get _contentLoadFailed(): boolean {
    return this._loadFailed;
  }

  /** @internal The `doc_gone` reason this Document has seen, or `null`. */
  get _goneReason(): DocumentGoneReason | null {
    return this._gone.reason;
  }

  /**
   * The historical version this Document shows, or `null` for a live
   * (head) open. Reactive alongside `readOnly`. The number is the
   * server's effective version, which can round down from the
   * requested version when compaction has TTL'd the exact op.
   *
   * An app that needs to know the doc is not editable reads the public
   * `doc.readOnly` (true for a preview, a view-only link, or a load lock).
   * @internal
   */
  get previewVersion(): number | null {
    return this._previewVersion;
  }

  /** @internal Whether the host should be showing its version-browsing
   *  surface for this document. True from a browse-in-the-app outcome and
   *  independent of `version`, so browsing can start at the live head; the
   *  host clears it when the reader closes that surface. */
  get versionBrowsing(): boolean {
    return this._versionBrowsing;
  }

  /** @internal Set by the host (on close) and by the browse-in-the-app
   *  command. Fires the `commands` signal so a host rendering off
   *  subscription re-reads it. */
  _setVersionBrowsing(on: boolean): void {
    if (this._versionBrowsing === on) return;
    this._versionBrowsing = on;
    this._fireSubscribers({ kind: 'commands' });
  }

  /** @internal The version this Document currently shows: the branch's live
   *  head seq for a head open (advanced by the WS op stream), or the frozen
   *  checkout version when a historical version is being previewed. The
   *  SDK's own anchors read it (a checkpoint seals at it, a thumbnail
   *  upload pins to it); no app-facing operation takes a seq, since version
   *  history is hosted chrome the app does not drive with numbers. */
  get currentSeq(): number | null {
    const previewing = this._previewVersion;
    if (previewing !== null) return previewing;
    if (this._currentSeqProvider) return this._currentSeqProvider();
    return null;
  }

  /**
   * Open a Document from a Loro snapshot (the SDK join path). Attaches
   * the Loro subscriber lazily, AFTER import: subscribing at
   * construction costs ~8 s on a 50k snapshot.
   * @internal
   */
  static openFromSnapshot(
    snapshot: Uint8Array,
    options?: DocumentOptions,
  ): Document {
    const loroDoc = new LoroDoc();
    loroDoc.import(snapshot);
    return new Document(loroDoc, options);
  }

  /**
   * Open a Document over frozen content: the document's content as it was
   * sealed, read with no CRDT engine.
   *
   * No CRDT engine is built: every root answers from the content, and the
   * machinery a Document carries regardless (its id, its subscriber channel,
   * its close path) runs without one.
   * @internal
   */
  static openFromSealedContent(content: SealedContent, options?: DocumentOptions): Document {
    // Rooted at a map the content holds, so a document reading frozen content
    // registers no empty root of its own.
    //
    // Read-only is stated here rather than left to the caller, because it is
    // a property of the bytes: frozen content holds no op log, so there is
    // nothing an edit could be written into, and making one is the platform's
    // (`runRecordSetConversion`). Stating it at the factory is what lets the
    // refusal come from the document's own gate, which names the reader's
    // actual limit, instead of from each handle describing the encoding.
    const rootKey =
      content.rootNames().find((n) => content.kindOf(n) === 'map') ?? RECORDS_KEY;
    const doc = new Document(null, {
      ...options,
      readOnly: true,
      readOnlyReason: options?.readOnlyReason ?? 'snapshot',
      rootKey,
      frozenContent: content,
    });
    doc._engineRootKey = options?.rootKey ?? 'entities';
    return doc;
  }

  /**
   * Construct an empty Document (empty-snapshot join case, and tests).
   * @internal
   */
  static create(options?: DocumentOptions): Document {
    return new Document(new LoroDoc(), options);
  }

  /**
   * Wrap a LoroDoc the caller already holds. `documentFromEngine` is the typed
   * entry point; this seam stays `unknown` so `documents.ts` declares an
   * engine-neutral surface.
   * @internal
   */
  static _fromEngine(engine: unknown, options?: DocumentOptions): Document {
    return new Document(engine as LoroDoc, options);
  }

  // Apply a remote op blob produced by another peer (delivered via the
  // WS `doc_op` server frame). Idempotent: Loro's import
  // path dedupes by lamport, so re-applying a self-originated op is
  // a no-op in terms of state. We still avoid the import work entirely
  // when the caller can prove the op originated locally (matched by
  // `clientOpId`); that saves the WASM round-trip on every echo and
  // avoids firing the user-side `subscribe(cb)` listeners twice for
  // the same mutation (optimistic mutate already fired them).
  /** @internal */
  applyRemoteOp(opBlob: Uint8Array, opts?: { clientOpId?: string }): void {
    // A closed Document has freed its LoroDoc; a late transport closure (a
    // reconnect/resync/reload that resolved after `close()`) must not import
    // into freed WASM. Guard on `_closed` only, NOT `_suspended`: a parked
    // doc keeps its LoroDoc alive and still applies remote ops.
    if (this._closed) return;
    if (opts?.clientOpId && this._outstandingByClientId.has(opts.clientOpId)) {
      // Echo of a local op: state is already up-to-date from the
      // optimistic mutation; skip re-import to avoid double-fire on
      // subscribers.
      return;
    }
    // An op exists, so the document is now a CRDT and somebody has edited it.
    // The op is authored against that CRDT, so imported over frozen content it
    // would land on an empty LoroDoc and sit causally incomplete. The storage
    // is upgraded instead: the transport re-joins, and the join's CRDT
    // replaces the frozen content under the same handles (`_upgradeStorage`).
    // The op is in what that join serves.
    if (this._sealedRoots !== null) {
      this._requestStorageUpgrade();
      return;
    }
    importTailOp(this._doc, opBlob);
  }

  // Apply a snapshot blob over the top of an existing Document.
  // Internal: the SDK calls this when the server delivers a fresh
  // snapshot mid-session. Persistence is server-authoritative: the server
  // decides when a fresh snapshot supersedes the local history.
  /** @internal */
  _applySnapshot(snapshot: Uint8Array): void {
    // See `applyRemoteOp`: refuse the import on a closed (freed) doc so a late
    // reload/resync closure can't touch freed WASM. `_closed` only; a parked
    // doc still imports.
    if (this._closed) return;
    // Arm the seed BEFORE the import, because this is the moment the content
    // arrives and the Loro subscriber cannot be relied on to report it: it is
    // attached lazily, so a document whose content lands before the session has
    // bound its canvas has nobody subscribed and the import fires nothing.
    // CRDT bytes over frozen content are a storage upgrade, which keeps the
    // app's handles (see `_upgradeStorage`).
    if (this._sealedRoots !== null) {
      if (!this._upgradeStorage(snapshot, [])) this._reopen();
      return;
    }
    this._armSeedIfPictureIsStale();
    this._doc.import(snapshot);
    // The undo stack pre-snapshot referenced ops the new snapshot
    // supersedes. Drop both stacks so undo doesn't try to revert
    // into a state that no longer exists; the user's mental model
    // here is "we just loaded fresh state", and silently retaining
    // a now-broken redo entry would be the worst of both worlds.
    if (this._undo) this._undo.clear();
  }

  /** @internal Wire the re-join that upgrades this Document's frozen content
   *  to the CRDT the server now holds. */
  _setStorageUpgrader(upgrade: () => void): void {
    this._storageUpgrader = upgrade;
  }

  private _requestStorageUpgrade(): void {
    const upgrade = this._storageUpgrader;
    if (upgrade === null) {
      this._reopen();
      return;
    }
    upgrade();
  }

  /**
   * Swap this Document's storage from frozen content to a CRDT, in place.
   * @internal
   *
   * Every handle an app took over the frozen content keeps working, now over
   * the CRDT, and its subscribers move there as a whole-container resync (keys
   * the CRDT does not hold arrive as `deleted`, and `onSettled` fires again).
   * Read-only state is unchanged, because the reader's intent is.
   *
   * Returns false, leaving the frozen content in place, when the Document is
   * showing a version of the frozen content: the preview has no CRDT
   * counterpart to rebind to, so the caller reloads instead.
   */
  _upgradeStorage(snapshot: Uint8Array | null, tailOps: readonly Uint8Array[]): boolean {
    if (this._closed) return false;
    if (this._sealedRoots === null) return true;
    if (this._frozenVersion !== null) return false;
    const engine = new LoroDoc();
    if (snapshot !== null) engine.import(snapshot);
    for (const op of tailOps) importTailOp(engine, op);
    if (this._engineOptions.peerId !== undefined) engine.setPeerId(this._engineOptions.peerId);
    this._handles.swap(() => {
      this._rootKey = this._engineRootKey;
      engine.getMap(this._rootKey);
      this._engine = engine;
      this._undo = this._newUndoController(engine, this._engineOptions.undo);
      this._sealedRoots = null;
      this._frozenHead = null;
      this._frozenShown = null;
      this._frozenSeal = null;
      this._rootHandles.clear();
      this._orderedMapHandles.clear();
    });
    this._fireSubscribers({ kind: 'change', source: 'remote' });
    return true;
  }

  /**
   * Swap this Document's storage from a CRDT to frozen content, in place: the
   * counterpart of `_upgradeStorage`, for a frozen copy whose reload is served
   * the line as stored after the copy was opened on a CRDT.
   * @internal
   *
   * Returns false, leaving the CRDT in place, when the Document is showing a
   * version: the preview has no frozen counterpart, so the caller reloads.
   */
  _downgradeStorage(content: SealedContent, seal: number | null): boolean {
    if (this._closed || this._sealedRoots !== null || this._checkout !== null) return false;
    this._handles.swap(() => {
      this._frozenHead = content;
      this._frozenShown = content;
      this._frozenSeal = seal;
      this._sealedRoots = sealedRoots(
        () => this._frozenShown!,
        () => this._handleOwner.assertWritable(),
      );
      this._rootHandles.clear();
      this._orderedMapHandles.clear();
      // Nothing reads the engine from here on. It is dropped rather than
      // freed, because a watcher an input follower attached to it may still
      // detach.
      this._unsubLoro?.();
      this._unsubLoro = null;
      this._unsubLocal?.();
      this._unsubLocal = null;
      this._undo?.free();
      this._undo = null;
      this._engine = null;
    });
    this._fireSubscribers({ kind: 'change', source: 'remote' });
    return true;
  }

  /**
   * Replace this Document's frozen content with other frozen content, in
   * place, re-delivering every handle's subscribers. A join serves a newer
   * seal when the document was edited and frozen again in between.
   * @internal
   */
  _replaceSealedContent(content: SealedContent, seal: number | null): boolean {
    if (this._closed || this._sealedRoots === null) return false;
    if (this._frozenVersion !== null) return false;
    this._frozenHead = content;
    this._frozenShown = content;
    this._frozenSeal = seal;
    this._sealedRoots.resync();
    this._fireSubscribers({ kind: 'change', source: 'remote' });
    return true;
  }

  // Revert the most recent local step. Returns `true` if an undo
  // step was applied, `false` if the stack is empty. Remote peers'
  // edits are not in this stack: Loro's UndoManager is local-peer-
  // scoped, which is the user-visible behaviour every collaborative
  // editor lands on (you don't get to undo your collaborator's typing).
  //
  // The reverted change is itself a local commit, so it ships over
  // the WS transport like any other mutation and other peers see the
  // state revert.
  //
  // The stack is the document's, across its streams: a step is every local
  // commit between two seals in whichever streams took one, and one `undo()`
  // reverts it in each of them. A stream that refuses writes takes no part.
  undo(): boolean {
    this._assertOpen();
    try {
      return this._undoGroup.replay('undo');
    } finally {
      this._maybeFireUndoState();
    }
  }

  // Re-apply the most recently undone local commit. Returns `true`
  // if a redo step was applied, `false` if the stack is empty. The
  // redo stack invalidates the moment a new local commit lands (the
  // standard "fresh edit clears the redo branch" behaviour); remote
  // edits do not clear redo, but Loro's UndoManager rebases redo
  // entries against intervening remote state so the redone op
  // composes correctly.
  redo(): boolean {
    this._assertOpen();
    try {
      return this._undoGroup.replay('redo');
    } finally {
      this._maybeFireUndoState();
    }
  }

  // Whether `undo()` / `redo()` must no-op. A replay produces local commits
  // exactly as `mutate` does, so it obeys every gate `mutate` does. During a
  // checkout the UndoManager still tracks the live head while reads go
  // through the preview, so a replay would be a silent live edit. A copy with
  // no CRDT (frozen content) has no undo stack at all. `undo()` / `redo()`
  // also no-op inside a `mutate` callback, whose open transaction holds
  // writes the replay would commit outside the op it ships.
  private _undoBlocked(): boolean {
    return this._checkout !== null || this._undo === null || this._readOnlyBecause !== null;
  }

  // Tags each commit the step's replay makes, so the resulting change reads
  // back as `origin.source === 'undo'` / `'redo'`, not `'local'`.
  //
  // A step replays as one commit per commit it took, and those ship as ONE op
  // exported from the version before the replay, so an Undo of a long step is
  // one write for the server and one import for each peer.
  /** @internal Replay this stream's own part of the newest step that touched
   *  it (undo) or of the step it most recently undid (redo), leaving the
   *  document's other streams alone. `DocumentStream.undo` / `redo`. */
  _replayOwnUndoStep(dir: 'undo' | 'redo'): boolean {
    this._assertOpen();
    try {
      if (this._mutateDepth > 0 || this._undoBlocked()) return false;
      const tag = this._undo!.peek(dir);
      return tag !== undefined && this._replayUndoStep(dir, tag);
    } finally {
      this._maybeFireUndoState();
    }
  }

  /** @internal */
  _replayUndoStep(dir: 'undo' | 'redo', tag: number): boolean {
    this._ensureLocalUpdatesSubscribed();
    const origin = dir === 'undo' ? UNDO_COMMIT_ORIGIN : REDO_COMMIT_ORIGIN;
    const tagCommit = (): void => this._doc.setNextCommitOrigin(origin);
    const before = this._doc.oplogVersion();
    const beforeHead = JSON.stringify(this._doc.oplogFrontiers());
    this._replayingUndo = true;
    this._replayChange = null;
    try {
      return this._undo!.replayStep(dir, tag, tagCommit);
    } finally {
      this._replayingUndo = false;
      // Whatever the replay committed ships, a replay that threw part-way included.
      if (this._unsubLocal && JSON.stringify(this._doc.oplogFrontiers()) !== beforeHead) {
        this._shipLocalUpdate(this._doc.export({ mode: 'update', from: before }));
      }
      before.free();
      const source = this._replayChange;
      this._replayChange = null;
      if (source !== null) {
        this._subs.emit({ kind: 'change', source } satisfies SyntheticSubscribeEvent);
      }
      this._maybeFireUndoState();
    }
  }

  /**
   * Seal the open undo group locally, so the NEXT local commit starts a
   * fresh undo step. The doc-level path seals through checkpoints
   * (`createCheckpoint` / the auto-checkpoint debounce); this is the
   * boundary primitive a stream scope exposes directly, since streams
   * carry no checkpoint machinery of their own.
   * @internal
   */
  _sealUndoStep(): void {
    this._undoGroup.seal();
  }

  /** @internal */
  _undoController(): UndoController | null {
    return this._undo;
  }

  /** @internal */
  _undoEligible(): boolean {
    return !this._closed && !this._undoBlocked();
  }

  /** @internal */
  _undoMutating(): boolean {
    return this._mutateDepth > 0;
  }

  // A version on screen holds every stream of the document at that moment,
  // so no stream replays a step while the document shows one, even a stream
  // whose own preview has not landed yet.
  private _undoGroupBlocked(): boolean {
    return (
      this._closed ||
      this._checkout !== null ||
      this._previewVersion !== null ||
      this._versionBrowsing
    );
  }

  private _newUndoController(
    loroDoc: LoroDoc,
    options: UndoControllerOptions | undefined,
  ): UndoController {
    return new UndoController(loroDoc, options, this._undoGroup, {
      onFreshCommit: (): void => this._undoGroup.freshCommit(this),
      onStackChange: (): void => {
        if (!this._undoGroup.isOwner(this)) this._undoGroup.changed();
      },
    });
  }

  /** @internal Make this stream's undo part of its document's stack. Called
   *  when the stream opens, before it has taken a local commit. */
  _joinUndoGroup(group: UndoGroup): void {
    this._undoGroup.delete(this);
    this._undoGroup = group;
    group.add(this);
    this._undo?.useClock(group);
  }

  // Whether `undo()` would have an effect right now. Feeds the
  // commands machinery and the undo-state notifier; apps consume it
  // through `subscribeUndoState` snapshots.
  //
  // The gates `undo()` enforces, so a subscribeUndoState-bound button
  // disables rather than inviting an undo the call would refuse: during a
  // checkout the stacks still track the live head while the UI shows the
  // preview, and a stream that refuses writes has nothing it may replay.
  private canUndo(): boolean {
    if (this._closed) return false;
    return this._undoGroup.canUndo();
  }

  // Whether `redo()` would have an effect right now. As above.
  private canRedo(): boolean {
    if (this._closed) return false;
    return this._undoGroup.canRedo();
  }

  // The plain-object proxy callers mutate. The mutation runs against
  // the local LoroDoc immediately (optimistic UI), then commit + the
  // `subscribeLocalUpdates` hook publish the resulting op blob over
  // the WS transport when a `LocalOpSendHook` is installed.
  //
  // If no hook is installed (offline / migration script / unit tests),
  // mutate still works but the op is not sent anywhere. This is the
  // intentional escape hatch: `Brass.openDocumentById` wires the hook;
  // `Document.create()` and direct construction stay
  // hook-free so the class is usable without taking the WS dependency.
  // `E` defaults to `EntityProxy` (the untyped Record<string, unknown>) so an
  // app that has not described its entity shape still gets a working mutate.
  // Apps with a typed entity shape pass it as a type argument:
  //
  //   doc.mutate<MyEntity>((d) => {
  //     d.entities[id] = myTypedEntity;
  //   });
  //
  // The mutator's `entities` field has the same proxy under the hood
  // regardless of `E`; the generic exists purely to widen the type at
  // the assignment site so closed interfaces don't need an
  // `as Record<string, unknown>` cast.
  //
  // `d.entities` is the root map's handle under a plain-object surface, so
  // the two reach one collection: a record a paged store holds reads and
  // edits here exactly as it does through `doc.map(rootKey)`, and a write
  // large enough to cross the paging threshold takes the paged shape from
  // either.
  mutate<E extends object = EntityProxy>(
    fn: (d: DocumentMutator<E>) => void,
    options?: MutateOptions,
  ): void {
    this.map<E>(this._rootKey).mutate((entities) => {
      fn({ entities });
    }, options);
  }

  // Install / replace the local-op send hook; `null` detaches it.
  //
  // The hook is invoked synchronously from Loro's
  // `subscribeLocalUpdates` callback, which fires immediately after
  // `commit()` returns. The hook must be safe to call multiple times
  // per `mutate()` call (a single mutation can produce multiple update
  // batches if Loro splits them); each call gets its own clientOpId so
  // the outstanding-op map stays correct.
  /** @internal */
  setLocalOpHook(hook: LocalOpSendHook | null): void {
    this._localOpHook = hook;
    // Detach the underlying Loro subscriber when the hook is removed
    // so a hook-free Document does not pay the per-commit callback
    // cost. `_ensureLocalUpdatesSubscribed` re-attaches lazily.
    if (!hook && this._unsubLocal) {
      this._unsubLocal();
      this._unsubLocal = null;
    }
  }

  // Install / replace the transport's live-head-seq provider; `null`
  // detaches it.
  /** @internal */
  setCurrentSeqProvider(provider: (() => number) | null): void {
    this._currentSeqProvider = provider;
  }

  // Install the historical-materialise fetcher used by
  // `_checkoutVersion`. A Document without one rejects the checkout
  // with a clear error.
  /** @internal */
  setCheckoutFetcher(fetcher: CheckoutFetcher | null): void {
    this._checkoutFetcher = fetcher;
  }

  /** @internal Whether a historical-materialise fetcher is installed, so a
   * stream can tell whether it can preview (a guest line has none). */
  _hasCheckoutFetcher(): boolean {
    return this._checkoutFetcher !== null;
  }

  /** @internal Whether this Document is currently showing a historical
   * preview rather than its live head. */
  _isCheckedOut(): boolean {
    return this._previewVersion !== null;
  }

  /** @internal Whether this Document is pinned to the version it was opened
   * at, with no live channel behind it. Stepping and returning to the head
   * both throw on that shape, so the SDK's version bar offers neither. */
  get _isVersionPinned(): boolean {
    return this._isFrozen;
  }

  // Switch the Document to a historical version, in place. @internal
  // (the hosted `history` command drives this). After the promise
  // resolves, `doc.readOnly` is `true`,
  // `doc.previewVersion` is the server's effective version (which may round
  // down from the requested one when compaction has TTL'd the exact
  // op), and `mutate` throws. `subscribe` fires once after the swap so
  // the app's render loop redraws, and the app returns to live through
  // the public `returnToHead()`.
  //
  // The live WS stream keeps applying remote ops to the underlying
  // live Document in the background. `returnToHead()` clears the
  // checkout in O(1); the live state is already current.
  async _checkoutVersion(version: number): Promise<void> {
    this._assertOpen();
    if (this._isFrozen) {
      throw new Error(
        '_checkoutVersion: this Document was opened at a fixed version ' +
          'and has no live channel.',
      );
    }
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`_checkoutVersion: invalid version ${version}`);
    }
    if (this._docId === null) {
      throw new Error('_checkoutVersion: Document has no server identity');
    }
    if (this._branchId === null) {
      throw new Error('_checkoutVersion: Document has no branch');
    }
    if (!this._checkoutFetcher) {
      throw new Error(
        '_checkoutVersion: no fetcher attached. Opened via the SDK factory?',
      );
    }
    const generation = ++this._checkoutGeneration;
    const { content, tailOpBlobs, effectiveVersion, streamSeqs } =
      await this._checkoutFetcher(this._docId, version, this._branchId);
    if (this._closed || this._suspended) return;
    // A `returnToHead` or a newer `_checkoutVersion` fired while this fetch
    // was in flight. Honour the latest intent: drop this stale result rather
    // than clobbering the live head (or a newer checkout) the user asked for.
    if (generation !== this._checkoutGeneration) return;
    this._checkoutStreamSeqs = streamSeqs ?? {};
    // Handles over frozen content read frozen content, so the version is
    // swapped in as frozen content whatever encoding the server stores it in.
    if (this._sealedRoots !== null) {
      this._frozenShown = frozenPreview(content, tailOpBlobs);
      this._frozenVersion = effectiveVersion;
      this._sealedRoots.resync();
      this._fireSubscribers({ kind: 'history', version: effectiveVersion });
      await this._checkoutOpenStreams(generation);
      return;
    }
    // Materialise the preview into a fresh LoroDoc. The previous
    // checkout's preview LoroDoc, if any, is freed.
    const previewDoc = engineFrom(content);
    for (const blob of tailOpBlobs) importTailOp(previewDoc, blob);
    const previewRoot = previewDoc.getMap(this._rootKey);
    const old = this._checkout;
    // Snapshot the handles' keys before the active-source pointer moves (see
    // `_snapshotRootHandleKeys`). Nothing between here and `_rebindRootHandles`
    // may return early, or the snapshot would outlive its swap and be diffed
    // against an unrelated later one.
    this._snapshotRootHandleKeys();
    this._checkout = {
      previewDoc,
      previewRoot,
      version: effectiveVersion,
    };
    // Re-point the handles the app already holds at the preview doc and
    // redraw them: the active source changed from the live doc to the
    // preview, and an app renders off its `doc.map(key).subscribe(...)` /
    // `doc.orderedMap(...)` handle (the primary read surface). Rebinding
    // re-fires those subscribers with the historical container so the model
    // updates in place, the same way a remote op or undo would. `doc.map` /
    // `doc.list` reads follow the anchor, so they read the preview too.
    this._rebindRootHandles(previewDoc);
    // Free the previous preview only AFTER the rebind. `_rebindRootHandles`
    // runs each active subscriber's `detach()`, which unsubscribes against the
    // container captured at attach time (the OLD preview's); freeing first
    // would run that detach against a freed LoroDoc. This is the same
    // teardown-before-free order `close()` documents.
    if (old && old.previewDoc !== this._engine) {
      try {
        old.previewDoc.free();
      } catch {
        // ignore; already freed
      }
    }
    this._fireSubscribers({ kind: 'history', version: effectiveVersion });
    this._maybeFireUndoState();
    // Preview every opened stream at the same point in time, so a
    // partitioned document's history shows a consistent historical state
    // across streams rather than a historical default over live streams.
    await this._checkoutOpenStreams(generation);
  }

  // Re-materialize each opened non-default stream at its seq recorded by the
  // active preview's checkpoint. A stream with no recorded seq at this
  // version (opened after the checkpoint, or before any checkpoint recorded
  // one) has no historical state it can show, so it is held read-only for the
  // duration rather than left live and writable under a historical default. Best-effort per stream: a stream whose inner
  // has no checkout fetcher (a guest line, which has no token to fetch
  // at-version) stays live. Failures are swallowed so one stream cannot
  // break the doc-level preview.
  private async _checkoutOpenStreams(generation: number): Promise<void> {
    const seqs = this._checkoutStreamSeqs ?? {};
    for (const [name, openPromise] of this._streamOpens) {
      try {
        const stream = await openPromise;
        // Every stream costs an await, so the reader can have stepped
        // somewhere else, or back to the live head, since the previous one.
        // The document's own swap is guarded the same way, and this loop
        // running on past it is what leaves a partitioned document showing
        // two moments at once: the document at the version the reader asked
        // for, and whichever streams a superseded run still reached at its
        // own.
        if (generation !== this._checkoutGeneration) return;
        const lineId = this._streamManifest?.get(name)?.line_id;
        const seq = lineId !== undefined ? seqs[lineId] : undefined;
        await stream._previewAt(seq, true);
      } catch {
        // A stream that failed to open or preview is left as-is.
      }
    }
  }

  /**
   * Return to the live head. After this resolves, `readOnly` is
   * `false`, `version` is `null`, `toJSON()` reads the live state,
   * and `mutate` is accepted again. The live state has been kept
   * current by the WS transport while the checkout was active, so
   * there is no fetch involved. `subscribe` fires once.
   *
   * Kept as a method (not `_`-prefixed) only so the version-preview banner
   * (`mountToolbar` / `mountHeader` / `mountVersionPreview`), which lives in
   * the same package, calls it by name.
   * @internal
   */
  returnToHead(): void {
    this._assertOpen();
    if (this._isFrozen) {
      throw new Error(
        'returnToHead: this Document was opened at a fixed version ' +
          'and has no live channel to return to.',
      );
    }
    // Bump first, unconditionally: a checkout fetch may be in flight with
    // `_checkout` still null, and this is the signal that supersedes it when
    // it resolves.
    const generation = (this._checkoutGeneration += 1);
    if (this._sealedRoots !== null && this._frozenVersion !== null) {
      this._frozenShown = this._frozenHead;
      this._frozenVersion = null;
      this._sealedRoots.resync();
      this._fireSubscribers({ kind: 'return-to-head' });
      this._returnOpenStreams(generation);
      return;
    }
    if (this._checkout === null) return;
    const old = this._checkout;
    // Symmetric with `_checkoutVersion`: snapshot before the active-source
    // pointer moves, and return early nowhere between here and the rebind.
    this._snapshotRootHandleKeys();
    this._checkout = null;
    // Re-point the app's handles back at the live doc and redraw them,
    // symmetrically with the checkout path, so the model returns to the live
    // state in place.
    this._rebindRootHandles(this._doc);
    // Free the preview only after the rebind: `_rebindRootHandles` detaches
    // each subscriber against the preview container it was attached to, so
    // freeing first would be a use-after-free (see `_checkoutVersion`).
    if (old.previewDoc !== this._engine) {
      try {
        old.previewDoc.free();
      } catch {
        // ignore
      }
    }
    this._fireSubscribers({ kind: 'return-to-head' });
    this._maybeFireUndoState();
    this._returnOpenStreams(generation);
  }

  // Return every opened stream to its live head too, symmetric with the
  // checkout path. Fire-and-forget (returnToHead is synchronous and has no
  // fetch): a stream not previewing is a no-op.
  private _returnOpenStreams(generation: number): void {
    this._checkoutStreamSeqs = null;
    for (const openPromise of this._streamOpens.values()) {
      void openPromise
        .then((stream) => {
          // Each stream is reached a turn or more later, so a checkout the
          // reader started in the meantime owns the document by now and this
          // return would drag its streams back to the live head under it.
          if (generation !== this._checkoutGeneration) return;
          return stream._previewAt(undefined);
        })
        .catch(() => {
          // A stream that failed to open has nothing to return.
        });
    }
  }

  // Capture every root map handle's key set for the resync's removed-key diff,
  // while the handles still describe the outgoing source. This is a phase of
  // its own, ahead of `_rebindRootHandles`, because a handle resolves its
  // container from its anchor but its paging state from this Document's active
  // source: both must still name the outgoing source when the keys are read,
  // and the caller moves the active-source pointer between the two calls.
  // Callers must not return early in that window; a snapshot left unconsumed
  // would be diffed against a later, unrelated swap.
  // Detach every cached root handle's live subscriptions. Reached only on a
  // CRDT document: the teardown, the key snapshot and the rebind below are
  // `handles.ts`'s own internal protocol, spoken by the handles it produces,
  // and a stored record set's roots hold no container subscription to detach,
  // no anchor to re-point and no prior keys to diff against a swap.
  private _teardownRootHandles(): void {
    for (const entry of this._rootHandles.values()) {
      if (entry.kind === 'text') entry.handle._teardown();
      else teardownRootHandle(entry.handle);
    }
  }

  private _snapshotRootHandleKeys(): void {
    if (this._sealedRoots !== null) return;
    for (const entry of this._rootHandles.values()) {
      if (entry.kind === 'map') snapshotRootMapKeys(entry.handle);
    }
  }

  // Re-point every cached root handle at the corresponding container in
  // `source` (the live doc or a checkout preview) and resync its subscribers.
  // The app holds these same handle objects, so this is what makes a version
  // checkout / return redraw the model without the app re-acquiring handles.
  // `getMap` / `getList` are get-or-create, so a container absent in the
  // preview resolves to an empty one and its subscribers redraw to empty.
  private _rebindRootHandles(source: LoroDoc): void {
    if (this._sealedRoots !== null) return;
    // Two passes, not one per handle: rebind every anchor to the new source
    // first, then resync. A composed handle can read a sibling root while
    // firing (the ordered map reads its order list during its map redraw), so
    // every anchor must already point at the new source before any handle
    // fires, or the redraw reads a half-swapped map/order pair.
    for (const entry of this._rootHandles.values()) {
      if (entry.kind === 'map') {
        rebindRootMapAnchor(entry.handle, source.getMap(entry.key));
      } else if (entry.kind === 'list') {
        rebindRootListAnchor(entry.handle, source.getMovableList(entry.key));
      } else {
        entry.handle._rebind(source.getText(entry.key));
      }
    }
    for (const entry of this._rootHandles.values()) {
      if (entry.kind === 'text') entry.handle._resync();
      else resyncRootHandle(entry.handle);
    }
  }

  /**
   * Fork a new branch from a historical version and switch to it. Drives
   * the hosted version-preview bar's "Branch from here".
   * @internal
   */
  _forkFromVersion(fromVersion: number, name?: string): Promise<void> {
    return this._commandMenu.forkFromVersion(fromVersion, name);
  }

  // ---------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------

  // Internal: the current branch's display name when the doc is on a
  // NON-default branch, else null. The SDK's own chrome (the toolbar
  // branch chip, the page title) reads this to tell the user they are on
  // a branch. @internal
  _currentBranchName(): string | null {
    const branchId = this._branchId;
    const defaultBranchId = this._branchCtl.defaultBranchId;
    if (!branchId || !defaultBranchId || branchId === defaultBranchId) {
      return null;
    }
    return (
      this._branchCtl.branches.find((b) => b.branch_id === branchId)?.name ??
      null
    );
  }

  // Internal: the doc's default-branch id once the list has loaded, else
  // null. The session's URL sync reads this to keep `?branch=` off the
  // URL for the default branch. Not app-facing.
  /** @internal */
  _defaultBranchId(): string | null {
    return this._branchCtl.defaultBranchId;
  }

  // Internal: set the branches list. Fires `doc.subscribe` if the
  // value changed.
  /** @internal */
  _setBranches(
    branches: readonly BranchSummary[],
    defaultBranchId: string | null,
  ): void {
    this._branchCtl.set(branches, defaultBranchId);
  }

  // Install the branch provider (HTTP capability); `null` detaches it.
  // Wired by the SDK factory; the hosted branch chrome reaches the wire
  // through this controller.
  /** @internal */
  setBranchProvider(provider: BranchProvider | null): void {
    this._branchCtl.setProvider(provider);
  }

  // Internal: re-fetch the branches list. Called by the factory on open
  // (to populate the name the chip renders) and by the hosted branch
  // dialog after a mutation. Not app-facing.
  /** @internal */
  async _refreshBranches(): Promise<void> {
    return this._branchCtl.refresh();
  }

  // ---------------------------------------------------------------------
  // Thumbnail auto-capture
  // ---------------------------------------------------------------------

  // Register a canvas the SDK screenshots as the document's
  // thumbnail. Capture is debounced after each local edit; remote
  // edits and read-only / checkout state do not trigger a capture
  // (a viewer or a passive collaborator never re-uploads someone
  // else's frame). Pass the canvas element directly, or a getter
  // for apps that build / rebuild it lazily.
  //
  // Returns an unregister handle. Re-registering replaces; the
  // previous canvas is forgotten.
  useCanvas(source: CanvasSource): () => void {
    // Arm the lazy Loro subscriber so local-commit events reach the
    // capture collaborator's `schedule()`. Idempotent.
    this._ensureLoroSubscribed();
    return this._thumbnails.useCanvas(source);
  }

  // Install the thumbnail upload hook; `null` detaches.
  /** @internal */
  setThumbnailUploader(uploader: ThumbnailUploader | null): void {
    this._thumbnails.setUploader(uploader);
  }

  // Tell the document which version the server's picture of it depicts, from
  // the join, and start a seed watch when that picture is behind the content.
  /** @internal */
  _setThumbnailVersion(version: number | null): void {
    this._thumbnailVersion = version;
    this._armSeedIfPictureIsStale();
  }

  // A picture at or above the head depicts what the document currently holds.
  private _armSeedIfPictureIsStale(): void {
    const head = this.currentSeq ?? 0;
    if (this._thumbnailVersion !== null && this._thumbnailVersion >= head) {
      return;
    }
    this._thumbnails.armSeed();
  }

  // Install the checkpoint-create hook; `null` detaches.
  /** @internal */
  setCheckpointCreator(creator: CheckpointCreator | null): void {
    this._checkpoints.setCreator(creator);
  }

  // Install the drive-push hook; `null` detaches.
  /** @internal */
  setDrivePusher(
    pusher:
      | ((input: PushToDriveInput) => Promise<PushToDriveResult>)
      | null,
  ): void {
    this._drivePusher = pusher;
  }

  // Install the drive-resolve hook; `null` detaches. Mirrors
  // `setDrivePusher`.
  /** @internal */
  setDriveResolver(
    resolver: (() => Promise<DriveResolveResult | null>) | null,
  ): void {
    this._driveResolver = resolver;
  }

  // Install the source-blob fetch hook. Mirrors `setDrivePusher`.
  /** @internal */
  setSourceBlobFetcher(
    fetcher: (() => Promise<DocumentSourceBlob>) | null,
  ): void {
    this._sourceBlobFetcher = fetcher;
  }

  // Publish this document's current state back to its drive source,
  // driving the hosted toolbar's publish control.
  //
  // The platform publishes the doc's current state, overwriting the
  // source (unknown drive fields preserved), and marks its own write so
  // the inbound change-event drops it (no echo loop). It does not merge
  // concurrent drive-side edits. Throws on auth / link / write
  // failures; resolves with the new external ref and the published
  // entity count.
  /** @internal */
  async pushToDrive(
    input?: PushToDriveInput,
  ): Promise<PushToDriveResult> {
    this._assertOpen();
    if (this._docId === null) {
      throw new Error('pushToDrive: Document has no server identity');
    }
    if (this._drivePusher === null) {
      throw new Error(
        'pushToDrive: no pusher attached. Opened via the SDK factory?',
      );
    }
    return await this._drivePusher(input ?? {});
  }

  // Resolve a `behind` / `diverged` drive-linked doc by opening the
  // hosted resolution surface, which offers pull (take the source) / keep
  // both alongside the publish-over that `pushToDrive` does. Driven by the
  // hosted toolbar.
  //
  // Taking the drive's version keeps this document's id: the open copy moves
  // onto that version when it lands (`onGone('moved')`, which a session
  // re-opens). A `newDocId` in the result is opened through the same
  // `openSiblingDoc` path the history fork uses. Resolves with the outcome,
  // or `null` when the user dismissed the dialog.
  // Throws when there is no doc identity or no resolver is attached.
  /** @internal */
  async resolveDrive(): Promise<DriveResolveResult | null> {
    this._assertOpen();
    if (this._docId === null) {
      throw new Error('resolveDrive: Document has no server identity');
    }
    if (this._driveResolver === null) {
      throw new Error(
        'resolveDrive: no resolver attached. Opened via the SDK factory?',
      );
    }
    return await this._driveResolver();
  }

  // Fetch the file a document was uploaded as: a short-lived presigned GET
  // plus the file's name / content type / size. The document's content is
  // what its importer returned for this file, sealed by the platform.
  //
  // Rejects with a `BrassError` when the document holds no such file, or
  // the caller cannot reach it (both 404).
  async sourceBlob(): Promise<DocumentSourceBlob> {
    this._assertOpen();
    if (this._docId === null) {
      throw new Error('sourceBlob: Document has no server identity');
    }
    if (this._sourceBlobFetcher === null) {
      throw new Error(
        'sourceBlob: no fetcher attached. Opened via the SDK factory?',
      );
    }
    return await this._sourceBlobFetcher();
  }

  // ---------------------------------------------------------------------
  // Streams
  // ---------------------------------------------------------------------

  // Stream wiring, installed by the SDK open factory; `null` on
  // offline / test docs (stream methods then throw with a clear
  // message). The manifest cache maps stream name -> info; opens are
  // cached per name so `doc.stream('hvac')` is one join + subscribe
  // however many times it is called.
  private _streamRuntime: StreamRuntime | null = null;
  private _streamManifest: Map<string, DocumentStreamInfo> | null = null;
  private readonly _streamOpens = new Map<string, Promise<DocumentStream>>();
  // The subset of `_streamOpens` that has resolved, so a park reaches them
  // without waiting on a microtask. Kept in step with the map above.
  private readonly _openStreams = new Map<string, DocumentStream>();
  private _ownStream: DocumentStream | null = null;
  // Which stream this Document's own handles read. An open names a stream
  // and the usual one has a default, so `default` is a name here rather
  // than a case: opening at `geometry` makes `doc.map(...)` read geometry
  // and `doc.stream('geometry')` resolve to this Document.
  private _openedStreamName: string = DEFAULT_STREAM_NAME;

  // Install the stream runtime; `null` detaches. Mirrors `setDrivePusher`.
  /** @internal */
  setStreamRuntime(runtime: StreamRuntime | null): void {
    this._streamRuntime = runtime;
  }

  /** @internal Name the stream this Document was opened at. Set by the SDK
   *  open factory; defaults to `default`. */
  setOpenedStreamName(name: string): void {
    this._openedStreamName = name;
  }

  /** The stream this Document's own handles read. */
  get openedStream(): string {
    return this._openedStreamName;
  }

  // Open one stream of this document, by name. Only the streams an app
  // touches are downloaded, imported, and subscribed, so a partitioned
  // document opens at the cost of what is used, not its total size:
  //
  //   const hvac = await doc.stream('hvac');
  //   const records = hvac.orderedMap('instances', 'instance_order');
  //
  // The name this Document was opened at (`'default'` unless the open said
  // otherwise) resolves to its own state, the same containers
  // `doc.map(...)` reads, with no network. That is what lets code iterate
  // stream names over partitioned and unpartitioned documents with one
  // path. Repeat calls return the same open (one join + subscribe per
  // stream per Document).
  //
  // Opening READS. A name the document does not hold rejects rather than
  // being created, so code that only reads cannot mint a stream by
  // probing for one; `getOrCreateStream` is the call that writes.
  stream(name: string): Promise<DocumentStream> {
    // Sync method returning a Promise: reject rather than throw, so a
    // caller chaining `.catch()` without `await` still sees the failure.
    if (!this._isLive) {
      return Promise.reject(new Error('Document is closed'));
    }
    // The stream this Document already IS. No network: its state is the
    // state these handles read.
    if (name === this._openedStreamName) {
      this._ownStream ??= new DocumentStream(name, this, false);
      return Promise.resolve(this._ownStream);
    }
    const cached = this._streamOpens.get(name);
    if (cached) return cached;
    const runtime = this._streamRuntime;
    if (runtime === null) {
      return Promise.reject(
        new Error('stream: no runtime attached. Opened via the SDK factory?'),
      );
    }
    const open = (async (): Promise<DocumentStream> => {
      const info = await this._resolveStreamInfo(runtime, name);
      if (!info) {
        throw new Error(
          `This document has no stream named "${name}". ` +
            `doc.getOrCreateStream(${JSON.stringify(name)}) makes one.`,
        );
      }
      // Every stream the platform writes is a document line and reports
      // `'crdt'`, whether it is stored as a CRDT or frozen. Any other value
      // names a kind this version does not know, so it is refused rather
      // than joined as a line.
      if (info.format !== 'crdt') {
        throw new Error(
          `Stream "${name}" has format "${info.format}", which this ` +
            'SDK version cannot open.',
        );
      }
      const inner = await runtime.openLine(info.line_id);
      inner._joinUndoGroup(this._undoGroup);
      const stream = new DocumentStream(name, inner, true);
      try {
        // Opened while a version preview is active: bring the new stream to
        // the same point in time rather than showing it live under a
        // historical default.
        if (this._previewVersion !== null) {
          await stream._previewAt(this._checkoutStreamSeqs?.[info.line_id], true);
        }
      } catch (err) {
        // The line is joined and subscribed by now, and a rejected open is
        // dropped from the cache so the next call opens a second one. Nothing
        // else holds this Document, and nothing else would ever close it: the
        // parent closes the streams it has, and a stream whose open failed is
        // not one of them. So the failure disposes what it is abandoning,
        // rather than leaving a line applying remote ops for the life of the
        // page.
        stream._close();
        throw err;
      }
      return stream;
    })();
    this._streamOpens.set(name, open);
    // Hold the RESOLVED stream too. A park has to reach the streams
    // synchronously (an app's `close()` returns before any microtask runs, and
    // a remote op landing in between would still call the app back), and a
    // promise cannot be read that way. An open still in flight when the park
    // happens resolves into a parked document, so it is parked on arrival.
    void open.then(
      (stream) => {
        if (this._streamOpens.get(name) !== open) return;
        this._openStreams.set(name, stream);
        // `savingCount` counts this stream from here on, so an indicator bound
        // to the document has to hear the stream's writes land.
        stream._inner._observeSavingCount(() => {
          this._fireSubscribers({ kind: 'saving-count' });
        });
        stream._inner._observeConnectionNotice((kind) => {
          this._showConnectionNotice(kind);
        });
        if (this._suspended) stream._suspend();
      },
      () => {
        // A failed open (network, deleted stream) must not poison the cache:
        // drop it so the next call retries.
        if (this._streamOpens.get(name) === open) this._streamOpens.delete(name);
      },
    );
    return open;
  }

  // Open the document's stream of that name, making it when the document
  // does not hold it yet. This is the call that WRITES: `stream` only
  // reads, so no read path can bring a stream into being.
  //
  // Two collaborators reaching for the same name converge on one stream
  // rather than one of them failing, so an app reaches for the stream it
  // expects on every open without checking first.
  async getOrCreateStream(name: string): Promise<DocumentStream> {
    this._assertOpen();
    // The stream this Document already IS needs no create: it exists by the
    // time the document is open. Asking the server would spend a
    // branch-write budget on a reach whose answer is already in hand, which
    // matters because an app loops its declared stream names on every open.
    if (name === this._openedStreamName) return this.stream(name);
    const runtime = this._streamRuntime;
    if (runtime === null) {
      throw new Error(
        'getOrCreateStream: no runtime attached. Opened via the SDK factory?',
      );
    }
    let info: DocumentStreamInfo;
    try {
      info = await runtime.create(name);
    } catch (err) {
      // Losing the create means someone else made this stream between our
      // read and our write, which is the same outcome we wanted, so resolve
      // theirs. Recognising the loss by re-reading rather than by matching a
      // status code keeps the app out of the race entirely: a rejection that
      // is NOT the race (no permission, doc gone) finds no stream and
      // rethrows untouched.
      const existing = await this._resolveStreamInfo(runtime, name);
      if (!existing) throw err;
      info = existing;
    }
    (this._streamManifest ??= new Map()).set(info.name, info);
    return this.stream(info.name);
  }

  // Every stream the document holds, `default` included (it is an ordinary
  // manifest entry). Fetches fresh so a stream a collaborator just created
  // is visible.
  async listStreams(): Promise<DocumentStreamInfo[]> {
    this._assertOpen();
    const runtime = this._streamRuntime;
    if (runtime === null) {
      throw new Error(
        'listStreams: no runtime attached. Opened via the SDK factory?',
      );
    }
    const streams = await runtime.list();
    this._streamManifest = new Map(streams.map((s) => [s.name, s]));
    return streams;
  }

  private async _resolveStreamInfo(
    runtime: StreamRuntime,
    name: string,
  ): Promise<DocumentStreamInfo | undefined> {
    const cached = this._streamManifest?.get(name);
    if (cached) return cached;
    const streams = await runtime.list();
    this._streamManifest = new Map(streams.map((s) => [s.name, s]));
    return this._streamManifest.get(name);
  }

  // Close every opened stream's own transport + state. Streams opened
  // while this Document was live do not outlive it.
  private _closeStreams(): void {
    // A stream that has already opened closes IN THIS CALL, for the reason the
    // park reaches them through this map: `close()` returns to the app before
    // any microtask runs, so a stream closed on a `.then` spends the rest of
    // that turn taking writes and calling the app back while `doc.mutate` on
    // the same document already refuses. A write in that window reaches a
    // transport about to be torn down and is never persisted.
    for (const stream of this._openStreams.values()) {
      stream._inner._observeSavingCount(null);
      stream._inner._observeConnectionNotice(null);
      stream._close();
    }
    // An open still in flight has no Document to close yet, so it closes on
    // arrival. A stream reached both ways is closed twice, which is a no-op.
    for (const open of this._streamOpens.values()) {
      void open.then((s) => s._close()).catch(() => {
        // A failed open has nothing to close.
      });
    }
    this._streamOpens.clear();
    this._openStreams.clear();
    this._streamManifest = null;
  }

  // Park / unpark the streams opened off this document, alongside the
  // document's own park.
  //
  // A non-default stream is its own Document, which nothing else suspends: it
  // keeps its transport, so an app holding `await doc.stream(name)` across
  // `doc.close()` would go on receiving remote-op callbacks and could still
  // write through the stream, while `doc.mutate` correctly throws. That is the
  // cross-session callback a park exists to stop, plus a write path around the
  // closed check. The default stream's inner IS this document, which owns its
  // own lifecycle, so `_ownsInner` gates this exactly as it gates the close.
  private _setStreamsSuspended(suspended: boolean): void {
    for (const stream of this._openStreams.values()) {
      if (suspended) stream._suspend();
      else stream._resume();
    }
  }

  // Mark the end of a user action: seals the undo step at once, and records a
  // version-history marker covering this call (calls made while a write is
  // in flight share the next one, written at the latest state). Call it
  // after every action and do not await it in the action's handler.
  // Resolves once the marker covering the call is written. While `readOnly`
  // is true it writes nothing and resolves at once (as `undo` / `redo` do
  // nothing there).
  createCheckpoint(): Promise<void> {
    if (this._isLive && this.readOnly) return Promise.resolve();
    const written = this._checkpoints.create().then(() => undefined);
    // Apps call this without awaiting it; a rejection still reaches a caller
    // that awaits.
    written.catch(() => {});
    return written;
  }

  // Configure the implicit auto-checkpoint debounce. Default is 60s
  // after the last local edit; pass `0` to disable. Apps in test
  // contexts (deterministic clocks) or apps with a different "natural
  // pause" rhythm (a slow turn-based tool, a CAD modeler with multi-
  // second operations) tune this. Returning the prior value lets a
  // test or scoped override restore.
  setAutoCheckpointIntervalMs(intervalMs: number): number {
    return this._checkpoints.setAutoIntervalMs(intervalMs);
  }


  // ---------------------------------------------------------------------
  // File-menu commands (per-doc)
  // ---------------------------------------------------------------------

  // The doc's display name. `null` on offline / test docs.
  get name(): string | null {
    return this._name;
  }

  // Internal: set the cached name. Fires a `'commands'` subscribe
  // event so apps re-render the menu trigger without an app-side
  // refresh.
  /** @internal */
  _setName(name: string | null): void {
    if (this._name === name) return;
    this._name = name;
    this._fireSubscribers({ kind: 'commands' });
  }

  /** When Brass will remove this document, or `null` when it is kept. Set
   *  for a document created while signed out; a sign-in claims it and the
   *  claimed document reads `null`. */
  get expiresAt(): Date | null {
    return this._expiresAt;
  }

  /** @internal */
  _setExpiresAt(expiresAt: Date | null): void {
    const same =
      (this._expiresAt === null && expiresAt === null) ||
      (this._expiresAt !== null &&
        expiresAt !== null &&
        this._expiresAt.getTime() === expiresAt.getTime());
    if (same) return;
    this._expiresAt = expiresAt;
    this._fireSubscribers({ kind: 'commands' });
  }

  /** @internal */
  setHostedUiProvider(provider: HostedUiProvider | null): void {
    this._commandMenu.setHostedUiProvider(provider);
  }

  // The per-doc file menu, as data. Each Document carries its own list
  // with its own `running` state; multi-doc apps render one menu per
  // pane. The app filters by `surface` ('menu' | 'toolbar') to place
  // each command into its own chrome.
  get commands(): readonly Command[] {
    return this._commandMenu.commands;
  }

  // Invoke a command by id. A convenience for keyboard shortcuts
  // (`Ctrl-Z` -> `doc.run('undo')`). No-op for an unknown id.
  async run(commandId: string): Promise<void> {
    return this._commandMenu.run(commandId);
  }

  // Optional error sink for the doc's built-in commands. `null` falls
  // back to `console.error`.
  /** @internal */
  setErrorReporter(reporter: ((err: Error) => void) | null): void {
    this._errorReporter = reporter;
    this._commandMenu.setErrorReporter(reporter);
  }

  // Called by the factory when a document is opened with no live transport,
  // which outside tests means `wsBaseUrl` was left unset. Marking it is what
  // separates that from the snapshot reads and test stubs that legitimately
  // have no transport and must stay quiet.
  /** @internal */
  markTransportUnavailable(): void {
    this._transportExpected = true;
  }

  // A write on such a document reaches nothing: local state changes, the
  // reader sees their edit, and no server ever hears about it, so the edit is
  // gone on the next open with no failure anywhere. This is what makes that
  // observable. Once per document, because the condition holds for as long as
  // the document is open and repeating it per keystroke buries it.
  private _reportTransportUnavailable(): void {
    if (!this._transportExpected) return;
    if (this._transportUnavailableReported) return;
    this._transportUnavailableReported = true;
    // Lock the document as well as reporting it. The write that reached this
    // point stays local, exactly as `unsaved` describes for a refused one, so
    // the same gate closes: an app that disables on `readOnly` stops offering
    // an editor that cannot save, and a later `mutate` throws a sentence
    // naming the reason instead of succeeding into nothing. The lock lands
    // after this write's own gate has passed, so the first one still runs
    // locally and only what follows it is refused.
    this._markReadOnly('no_connection');
    this._reportError(
      new Error(
        'This document has no live connection, so edits stay on this device and ' +
          'reach no one else. Pass wsBaseUrl to Brass.init alongside the other ' +
          'base URLs: naming any one of them leaves wsBaseUrl unset.',
      ),
    );
  }

  private _reportError(err: Error): void {
    if (this._errorReporter) this._errorReporter(err);
    else console.error('[Brass]', err);
  }

  // The console keeps the original stack for the developer; the app's
  // `onError` gets a sentence it can show the reader.
  private _reportSubscriberThrow(err: unknown): void {
    console.error('[Brass] subscriber threw:', err);
    if (this._errorReporter) this._errorReporter(appCallbackError(err));
  }

  /** @internal Report a failure from the SDK's own chrome (the version
   * bar's intents) through the same sink the built-in commands use, so a
   * refused checkout reaches the app's `onError` rather than being dropped
   * on the way back to a surface that only shows the reader a state. */
  _reportChromeError(err: Error): void {
    this._reportError(err);
  }

  // Fire all `subscribe` listeners with a synthetic event. Used for
  // metadata-only changes (checkout, return-to-head, branch switch,
  // branches list update, saving count change, commands change)
  // that don't originate from a Loro commit but still need the app
  // to re-read state. Apps typically ignore the event arg and just
  // call `toJSON()` in the handler; the discriminant is there for
  // the rare consumer that wants to branch on the reason.
  private _fireSubscribers(event: SyntheticSubscribeEvent): void {
    // Every change to the outstanding-op map reports itself here, which
    // makes this the one place the unload guard has to hear about un-acked
    // work (`close()` releases the doc outright).
    if (event.kind === 'saving-count') {
      // Own ops rather than `savingCount`: a stream's inner Document registers
      // itself, so the registry's total already carries one entry per stream.
      trackUnsavedWork(this, this._outstandingByClientId.size);
      this._savingCountObserver?.();
      if (this._workStatus.notice !== null && this.savingCount === 0) {
        this._workStatus.setNotice(null);
      }
    }
    this._ensureLoroSubscribed();
    this._subs.emit(event);
  }

  // Told when this Document's outstanding-op count moves, so a parent
  // Document's `savingCount` covers the streams it has open and its
  // subscribers fire when a stream's writes land. One observer, because a
  // stream's inner Document is opened by, and belongs to, exactly one parent.
  private _savingCountObserver: (() => void) | null = null;

  /** @internal */
  _observeSavingCount(observer: (() => void) | null): void {
    this._savingCountObserver = observer;
  }

  // Saving indicator: number of locally-issued ops not yet acked by the
  // server, across this document's own state and every stream it has open. A
  // partitioned document keeps its bulk on its streams, so a count that named
  // the default stream alone reports "All changes saved" over a stream still
  // writing. Reactive: `subscribe` fires when this count changes (an op is
  // sent or an `op_ack` lands, on any of them). Apps bind directly inside the
  // subscribe handler:
  //
  //   doc.subscribe(() => {
  //     savingEl.textContent =
  //       doc.savingCount === 0 ? 'All changes saved'
  //                             : `Saving ${doc.savingCount} change${doc.savingCount === 1 ? '' : 's'}...`;
  //   });
  //
  // Only this count aggregates. `readOnly` and `atCapacity` gate `doc.mutate`,
  // which writes this document's own state, so folding another stream's
  // refusal into them would close an editor over a stream taking writes;
  // `stream.readOnly` / `stream.atCapacity` answer for one stream.
  // Supplied by the doc transport, which holds the sync state this reports.
  // Absent until a transport is wired (a read-only or detached Document),
  // where the honest answer is that nothing is outstanding.
  private _diagnosticsProvider: (() => DocSyncDiagnostics) | null = null;

  /** @internal */
  _setDiagnosticsProvider(provider: () => DocSyncDiagnostics): void {
    this._diagnosticsProvider = provider;
  }

  /**
   * How this document's sync is going, as the client sees it: how much is
   * outstanding, how long it has been, over which transport, across how many
   * reconnects, and under which correlator, which is what separates a
   * connection that is answering nothing from one that is merely behind.
   *
   * @internal Read on demand by Brass's own surfaces. An app reads
   * `savingCount` to know a save is outstanding, and the SDK resolves a stuck
   * one itself.
   */
  diagnostics(): DocSyncDiagnostics {
    const own: DocSyncDiagnostics = this._diagnosticsProvider?.() ?? {
      unackedOps: 0,
      oldestUnackedMs: 0,
      oldestClientOpId: null,
      reconnects: 0,
      lastAckAgeMs: null,
      inFlightBytes: 0,
      httpOpsInFlight: 0,
      healRounds: 0,
      hidden: false,
    };
    // Cover the streams this document opened, the way `savingCount` does: a
    // reader watching a save waits on the document, and which line an op was
    // written to is not something they can act on. The work counters add
    // up and the waiting ones take the longest wait, so the answer is about
    // the oldest edit anywhere in the document.
    //
    // The connection counters are the parent's alone rather than a fold,
    // because every line rides one socket, so reconnects and page
    // visibility are one fact about the client and not one per line.
    for (const stream of this._openStreams.values()) {
      const line = stream._inner.diagnostics();
      own.unackedOps += line.unackedOps;
      own.inFlightBytes += line.inFlightBytes;
      own.httpOpsInFlight += line.httpOpsInFlight;
      own.healRounds = Math.max(own.healRounds, line.healRounds);
      // Take the stream's op when it waited longer, and also when this
      // document has none of its own: a strict comparison against a zero
      // wait leaves the fold reporting outstanding work while naming no op
      // to go looking for, which is the field the rest hangs off.
      if (
        line.oldestClientOpId !== null &&
        (own.oldestClientOpId === null ||
          line.oldestUnackedMs > own.oldestUnackedMs)
      ) {
        own.oldestUnackedMs = line.oldestUnackedMs;
        own.oldestClientOpId = line.oldestClientOpId;
      }
    }
    return own;
  }

  get savingCount(): number {
    let total = this._ownSavingCount;
    // `_openStreams` holds the streams that opened their own line. The stream
    // this Document IS wraps `this`, and is not in it, so nothing is counted
    // twice.
    for (const stream of this._openStreams.values()) {
      total += stream._inner.savingCount;
    }
    return total;
  }

  // The ops issued against THIS line, which is what a stream reports for
  // itself: `doc.stream('default')` wraps this Document, so a default stream
  // reading the aggregate would report a sibling stream's writes as its own
  // and stand at "saving" while its own line has nothing outstanding.
  /** @internal */
  get _ownSavingCount(): number {
    return this._outstandingByClientId.size;
  }

  // Internal: forget an outstanding op once the server has acked it.
  // Returns true if the clientOpId was tracked (lets the caller detect
  // a stale ack).
  /** @internal */
  resolveOutstandingOp(clientOpId: string, seq?: number): boolean {
    const wasTracked = this._outstandingByClientId.delete(clientOpId);
    this._provisionalInputs.acked(clientOpId, seq);
    // Release this chunk from the resync-push loop guard once its op is
    // acked: the pushed op is now in the log, so the next handshake's
    // tail covers it and a fresh push is welcome (it would be a genuine
    // new hole, not a re-push of this one). The guard fully reopens only
    // once every chunk of the push has drained.
    this._resyncPushClientOpIds.delete(clientOpId);
    if (wasTracked) this._fireSubscribers({ kind: 'saving-count' });
    // An ack is proof the branch is taking writes again, which is the only
    // thing that can clear the capacity latch. A full branch refuses every
    // op, so no ack can arrive while the refusal stands; that is what makes
    // this evidence rather than a guess, and what keeps it from clearing a
    // state the next write would re-enter.
    if (this._atCapacity) {
      this._atCapacity = false;
      this._fireSubscribers({ kind: 'capacity' });
    }
    return wasTracked;
  }

  // Internal: turn this Document read-only because the server refused a
  // write on the reader's authority rather than on the op. It lands on
  // `readOnly` because that is the gate an app already renders, so a grant
  // withdrawn mid-session closes the editor with no new signal to learn.
  // One-way: the socket resolves write authority when it subscribes, so a
  // grant restored afterwards is refused by the server too until the
  // connection recycles, and a reopen is what picks the wider grant up.
  /** @internal */
  _markReadOnly(reason: ForcedReadOnlyReason): void {
    if (this._forcedReadOnly) return;
    this._forcedReadOnly = true;
    this._readOnlyReason = reason;
    this._fireSubscribers({ kind: 'commands' });
    this._maybeFireUndoState();
  }

  /**
   * Return this copy to what the platform holds, discarding anything it
   * refused. A refused change stays drawn on the copy that made it and
   * nowhere else, and no local operation removes it (a CRDT merges rather
   * than replaces, and an undo inverts an operation instead of discarding
   * it), so the only state holding exactly what the platform has is one
   * built from it.
   *
   * The session closes this document and opens the same id again, so a
   * `session.subscribe` handler rebinds the way it does on any document
   * switch.
   *
   * @internal The SDK drives this itself on the one refusal that reaches it,
   * telling the reader first, because an app that renders nothing for it is
   * exactly the case that must not leave someone on a diverged copy.
   */
  _reopen(): void {
    this._markGone('moved');
  }

  /** @internal The app registered its importer, so inputs whose open stopped
   *  waiting for it run again. */
  _importerRegistered(): void {
    this._inputFollowers.importerRegistered();
  }

  /**
   * @internal Typed on `ReadOnlyDocument`. A frozen copy loads the document as
   * it stands now, in place: the handles stay the same and their subscribers
   * are told what changed. A live read-only copy already holds the document as
   * it stands, so there is nothing to load. An editable copy is reopened
   * (`_reopen`).
   */
  reload(): Promise<void> {
    this._assertOpen();
    const reloader = this._frozenReloader;
    if (reloader === null) {
      if (!this.readOnly) this._reopen();
      return Promise.resolve();
    }
    // One reload at a time: a call while one runs shares it, since both ask
    // for the document as it stands once it lands.
    if (this._reloading !== null) return this._reloading;
    const run = (async () => {
      try {
        // Cleared before the join, so a change landing during it is reported
        // against the load it may or may not have reached.
        this._changed = false;
        this._stopChangeNotice?.();
        this._stopChangeNotice = null;
        await reloader();
      } finally {
        this._reloading = null;
        if (!this._closed && (this._changedListeners.size > 0 || this._statusWatches > 0)) {
          this._watchForChange();
        }
      }
    })();
    this._reloading = run;
    return run;
  }

  /**
   * Opens this document again in another mode, on the same branch. With no
   * options the new copy is editable; `{ readOnly: true }` follows other
   * people's edits with nothing on it that writes; `{ frozen: true }` keeps
   * what it loaded until `reload()`. Resolves with this document when it is
   * already in that mode, and otherwise with the new copy, closing this one.
   *
   * Rejects with a `BrassError` (status 403), without a request, when the
   * reader may not edit and the reopen asks for an editable copy. Leaving an
   * editable copy first waits for its changes to save, and rejects, keeping
   * this copy open, when they do not.
   */
  reopen(options: { frozen: true; readOnly?: true }): Promise<ReadOnlyDocument>;
  reopen(options: { readOnly: true; frozen?: false }): Promise<ReadOnlyDocument>;
  reopen(options?: { readOnly?: false; frozen?: false }): Promise<OpenedDocument>;
  reopen(options: OpenModeOptions): Promise<OpenedDocument | ReadOnlyDocument>;
  async reopen(options?: {
    readOnly?: boolean;
    frozen?: boolean;
  }): Promise<OpenedDocument | ReadOnlyDocument> {
    this._assertOpen();
    if (options?.frozen === true && options.readOnly === false) {
      throw new TypeError('reopen: a frozen copy is read-only, so `readOnly: false` cannot apply');
    }
    const mode: ReopenMode =
      options?.frozen === true ? 'frozen' : options?.readOnly === true ? 'read' : 'edit';
    const pending = this._pendingReopen;
    if (pending !== null) {
      if (pending.mode === mode) return pending.promise;
      // The later mode wins: the earlier call rejects and the copy it opens is
      // reopened in this mode, so every copy opened is either returned or closed.
      pending.superseded = true;
      return this._trackReopen(mode, async () => {
        const earlier = await pending.result.catch(() => null);
        if (earlier !== null) {
          return earlier.reopen(
            mode === 'frozen' ? { frozen: true } : { readOnly: mode === 'read' },
          ) as Promise<OpenedDocument>;
        }
        const reopener = this._reopenerFor(mode);
        if (reopener === null) return this as unknown as OpenedDocument;
        return this._runReopen(mode, reopener);
      });
    }
    const reopener = this._reopenerFor(mode);
    if (reopener === null) return this as unknown as OpenedDocument;
    return this._trackReopen(mode, () => this._runReopen(mode, reopener));
  }

  // The layer that reopens this copy in `mode`, or `null` when it is already
  // in that mode. Throws when it cannot be reopened so.
  private _reopenerFor(mode: ReopenMode): ((mode: ReopenMode) => Promise<OpenedDocument>) | null {
    // A copy showing a historical version is not at the head in any mode, so
    // every reopen loads the head.
    // A copy locked over a refused change shows something the platform does
    // not, so even a reopen to read builds a new one.
    const diverged = this._forcedReadOnly && this._readOnlyReason === 'unsaved';
    if (mode === this._openMode && this._previewVersion === null && !diverged) {
      return null;
    }
    if (mode === 'edit') {
      const refusal = this._editRefusal;
      if (refusal !== null) throw new BrassError(refusal, { status: 403 });
    }
    const reopener = this._reopener;
    if (reopener === null) {
      throw new BrassError('This document cannot be reopened', { status: 0 });
    }
    return reopener;
  }

  private async _runReopen(
    mode: ReopenMode,
    reopener: (mode: ReopenMode) => Promise<OpenedDocument>,
  ): Promise<OpenedDocument> {
    if (this._openMode === 'edit') {
      // A reopen called from inside a `mutate` callback runs before that
      // mutation commits, so the wait starts once it has.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!(await whenSaved(this))) {
        throw new BrassError('Changes to this document have not finished saving', {
          status: 0,
        });
      }
    }
    return reopener(mode);
  }

  // Records `run` as the reopen in flight, which a second call to the same
  // mode shares and a call to another mode supersedes. `reopening` holds until
  // the last overlapping reopen settles.
  private _trackReopen(
    mode: ReopenMode,
    run: () => Promise<OpenedDocument>,
  ): Promise<OpenedDocument> {
    this._setReopening(true);
    const entry = { mode, superseded: false } as PendingReopen;
    this._pendingReopen = entry;
    entry.result = run().finally(() => {
      if (this._pendingReopen !== entry) return;
      this._pendingReopen = null;
      this._setReopening(false);
    });
    entry.promise = entry.result.then((next) => {
      if (entry.superseded) {
        throw new BrassError('The reopen was replaced by a later reopen', { status: 0 });
      }
      return next;
    });
    return entry.promise;
  }

  private _setReopening(reopening: boolean): void {
    if (this._reopening === reopening) return;
    this._reopening = reopening;
    if (!this._isLive) return;
    this._fireSubscribers({ kind: 'commands' });
    this._maybeFireUndoState();
  }

  /** @internal Which of the three open modes this copy is in. */
  get _openMode(): ReopenMode {
    if (this._frozenReloader !== null) return 'frozen';
    return this._forcedReadOnly ? 'read' : 'edit';
  }

  /** @internal Install what `reopen` calls. */
  _setReopener(reopener: ((mode: ReopenMode) => Promise<OpenedDocument>) | null): void {
    this._reopener = reopener;
  }

  /** @internal What `reopen` calls, so a layer that takes over this copy can
   *  fall back to the one it replaced. */
  get _reopenerFn(): ((mode: ReopenMode) => Promise<OpenedDocument>) | null {
    return this._reopener;
  }

  // Internal: forget an outstanding op the server TERMINALLY rejected (an
  // `op_rejected` frame: the op can never be accepted, e.g. it exceeded the
  // server's op-blob cap), as opposed to `resolveOutstandingOp`'s success. The
  // transport clears its resend timer; this drops the tracker entry so
  // `savingCount` stops counting a dead op, and surfaces the failure so the
  // app can react (the optimistic local commit stays applied but never
  // persists, so the app's cue is to reload). Returns true if it was tracked.
  /** @internal */
  _failOutstandingOp(
    clientOpId: string,
    message: string,
    // Whether the app hears about this one. A refusal that describes the
    // DOCUMENT answers every op in flight at once, so reporting per op tells
    // the reader the same thing as many times as they happened to have
    // unacked writes, which on a bulk write is dozens. The caller reports it
    // once instead; the op still leaves the tracker either way, because
    // `savingCount` has to fall whether or not anyone is told.
    opts: { report?: boolean } = {},
  ): boolean {
    const wasTracked = this._outstandingByClientId.delete(clientOpId);
    this._resyncPushClientOpIds.delete(clientOpId);
    this._provisionalInputs.failed(clientOpId);
    if (wasTracked) {
      this._fireSubscribers({ kind: 'saving-count' });
      if (opts.report !== false) this._reportError(new Error(message));
    }
    return wasTracked;
  }

  // Internal: whether this op is one the durability handshake pushed, rather
  // than one the app wrote. The transport reads it to tell a refusal the heal
  // itself provoked from one that arrived on its own, which is what keeps a
  // refused heal chunk from re-arming the heal that sent it.
  /** @internal */
  _isResyncPushOp(clientOpId: string): boolean {
    return this._resyncPushClientOpIds.has(clientOpId);
  }

  private _atCapacity = false;

  /**
   * Whether the document has stopped accepting new changes because it has
   * reached the largest size the platform can keep.
   *
   * Read from the server's refusal of a write rather than predicted locally,
   * so it turns true at the first edit that does not land, and back to false
   * on the first edit that does. Both directions are evidence: a full branch
   * refuses every op, so an ack cannot arrive while the refusal stands.
   *
   * Edits keep applying to the local copy while it is true, which is what
   * lets the app show the reader what they did alongside the fact that it is
   * not saved; the copy is discarded on reload.
   *
   * An app reads this to stop offering work that would only be refused (a
   * bulk import, a generate pass) and to say so once, instead of surfacing one
   * error per rejected op.
   */
  get atCapacity(): boolean {
    return this._atCapacity;
  }

  // Internal: record the capacity verdict from a server refusal. Idempotent.
  // Cleared again by `resolveOutstandingOp`, so a branch whose compaction
  // seals it back under the ceiling reaches the open reader through the next
  // write that lands rather than only through a reload.
  /**
   * Returns whether this call is the one that flipped it, which is what lets
   * the transport report the refusal exactly once. Every op in flight draws
   * the same refusal, and a bulk write has as many of those as it has unacked
   * writes, so the flip is the only moment worth telling the app about.
   *
   * @internal
   */
  _markAtCapacity(): boolean {
    if (this._atCapacity) return false;
    this._atCapacity = true;
    this._fireSubscribers({ kind: 'capacity' });
    return true;
  }

  private _ensureLocalUpdatesSubscribed(): void {
    if (this._unsubLocal) return;
    // Frozen content takes no write, so there is no local update to send.
    if (this._sealedRoots !== null) return;
    if (!this._localOpHook) {
      this._reportTransportUnavailable();
      return;
    }
    // Loro's `subscribeLocalUpdates` fires after every local commit
    // with the op-blob bytes for that commit. Importing a remote op
    // does NOT trigger this callback, so we don't risk feeding the
    // same op back to the server in a loop.
    this._unsubLocal = this._doc.subscribeLocalUpdates((bytes: Uint8Array) => {
      // A replay's commits ship together once it ends (`_replayUndo`).
      if (this._replayingUndo) return;
      this._shipLocalUpdate(bytes);
    });
  }

  private _shipLocalUpdate(bytes: Uint8Array): void {
    if (!this._localOpHook) return;
    // Copy: Loro reuses its internal buffer across callback calls in
    // some builds. Hand the consumer a stable view so the eventual
    // WS send sees the correct bytes regardless of when the send
    // actually flushes (the WS client may queue the frame).
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const chunks = this.splitLocalUpdate(copy);
    if (chunks === null) {
      this._shipLocalOp(copy);
      return;
    }
    // In order: each chunk continues the one before it, so a peer applying
    // them out of sequence holds the tail unapplied until the gap closes.
    for (const chunk of chunks) this._shipLocalOp(chunk);
  }

  // Hand one op blob to the transport and count it as unsaved, or keep it
  // local when the server has evicted this document.
  //
  // A gone document still takes edits by design: it stays open so the app can
  // render its own "no longer available" state, and the person may keep
  // interacting until they navigate. Those edits have nowhere to land. The
  // transport dropped its retry machinery on `doc_gone`, and the frame would
  // ship onto a subscription the server evicted and come back as a `forbidden`
  // that describes nothing the app did. Counting them is the part that shows:
  // each one adds to `savingCount` for a save that cannot happen, so the doc
  // reports "no longer available" and "Saving 3 changes..." together and
  // re-arms the leave-site prompt `_markGone` just released.
  //
  // Returns the minted `client_op_id`, or null when the op stayed local.
  private _shipLocalOp(copy: Uint8Array): string | null {
    const hook = this._localOpHook;
    if (!hook) return null;
    if (this._gone.reason !== null) return null;
    const clientOpId = hook(copy);
    this._outstandingByClientId.set(clientOpId, copy);
    this._shipCapture?.push(clientOpId);
    // The local mutate has already fired `subscribe` (the Loro
    // event), but `savingCount` just incremented; fire one more
    // synthetic event so a subscribe handler bound on `savingCount`
    // sees the change.
    this._fireSubscribers({ kind: 'saving-count' });
    return clientOpId;
  }

  // Lazy-attach the underlying LoroDoc subscriber. **Do not** wire this
  // in the constructor or before the initial snapshot import: with a
  // subscriber attached, snapshot-import of a 50k doc takes ~8.5 s
  // because Loro walks the full event tree to deliver per-container
  // deltas. Lazy-attach drops 50k cold-load to ~280 ms.
  private _ensureLoroSubscribed(): void {
    // Never re-attach after close: `close()` nulls `_unsubLoro` and then
    // frees the underlying LoroDoc, so subscribing here would call into freed
    // WASM. Not every `_fireSubscribers` caller is transport-driven or
    // guarded: `_setName` runs from an open-time `refreshName(...).then(...)` with no
    // liveness re-check, and a default-branch `close()` frees the doc
    // immediately (no park), so a name fetch resolving after close reaches
    // here on a freed doc. The `_unsubLoro` short-circuit alone does not cover
    // it: close set it to null.
    if (this._closed) return;
    if (this._unsubLoro) return;
    // Frozen roots deliver their own subscribers; there is no engine to hear.
    if (this._sealedRoots !== null) return;
    this._unsubLoro = this._doc.subscribe((event) => {
      // One channel: every event reaches every subscriber, whatever
      // produced it. The app reconciles by value and reads the cause off
      // the event only when it has a non-render reason to.
      //
      // What reaches a subscriber is this SDK's own `{ kind, source }`, not
      // the engine's event object. An app that receives the engine's shape
      // can read its internals (container ids, peer ids, the raw diff) and
      // build on them, which pins the storage engine through a surface that
      // never promised it. The cause survives as `source`, the same
      // engine-neutral vocabulary the handle surface reports.
      if (this._replayingUndo) {
        this._replayChange = changeSourceOf(event);
      } else {
        this._subs.emit({
          kind: 'change',
          source: changeSourceOf(event),
        } satisfies SyntheticSubscribeEvent);
      }
      const isLocalCommit = (event as { by?: unknown }).by === 'local';
      this._maybeFireUndoState();
      // A local commit (mutate / undo / redo) schedules a debounced
      // thumbnail capture, when the app has registered a canvas via
      // `useCanvas`. The debounce is for the peer that drew the change, so
      // it is local-only: a passive collaborator re-uploading a screenshot
      // of someone else's edit is what a per-op capture would be.
      if (isLocalCommit) {
        this._thumbnails.schedule();
        // Same reasoning for the implicit auto-checkpoint: only the
        // peer that made the edit seals the marker. Without this an
        // N-way session would write N redundant CHECKPOINT# rows per
        // idle period.
        this._checkpoints.scheduleAuto();
      } else {
        // Content arriving with no local commit behind it is what an import
        // looks like from here, and it moves the head past whatever picture
        // the document has. This DOES reach a reader who drew none of it,
        // which the debounce above deliberately does not: an import runs on
        // whichever client claimed it, so gating the seed on local authorship
        // would leave the documents that most need a picture without one.
        // Every such reader captures the same document at the same version,
        // and the targeted snapshot each upload enqueues is idempotent on
        // that version, so the concurrent seeds resolve themselves.
        this._armSeedIfPictureIsStale();
      }
    });
  }

  // Subscribe to document events. Returns an unsubscribe handle.
  // Lazy-attaches the underlying Loro subscriber on first call so
  // construction stays cheap.
  //
  // `cb` fires for EVERY change, whatever produced it: a local `mutate()`,
  // a remote op, `undo`, `redo`, a history move, and the SDK's own metadata
  // events (saving-count, branches, commands). One channel; the app re-reads
  // / reconciles in the handler and branches on `event.kind` only when it
  // needs the cause. A content change arrives as
  // `{ kind: 'change', source }`, carrying the same engine-neutral `source`
  // the handle surface reports.
  subscribe(cb: DocumentSubscriber): DocumentUnsubscribe {
    this._assertOpen();
    this._ensureLoroSubscribed();
    return this._subs.on(cb);
  }

  // Subscribe to changes in undo/redo enabled state. Fires once
  // synchronously on registration with the current values, then
  // again whenever either value flips (after a local mutate, an
  // undo / redo, or a remote import that landed an op of this
  // peer's). The push covers local mutates, which the regular
  // `subscribe(cb)` suppresses as local echo, so a button bound
  // here stays current while the user types, regardless of what
  // produced the change.
  //
  // Returns an unsubscribe handle. The callback is invoked with
  // `{ canUndo, canRedo }`; only fires when at least one value
  // differs from the prior fire.
  //
  // Wire it once in your editor bind step:
  //
  //   const stop = doc.subscribeUndoState(({ canUndo, canRedo }) => {
  //     undoBtn.disabled = !canUndo;
  //     redoBtn.disabled = !canRedo;
  //   });
  //
  // Lifecycle: throws on a closed Document; cleared on close /
  // suspend like every other app-side subscriber.
  subscribeUndoState(cb: UndoStateSubscriber): DocumentUnsubscribe {
    this._assertOpen();
    // A copy that cannot write never has anything of its own to undo (the
    // reason it cannot write does not lift while it is open), so it does not
    // listen to its own engine. A stream of the document can still take
    // writes, and reports them through the undo group.
    if (!this._forcedReadOnly) this._ensureLoroSubscribed();
    this._undoStateSubs.add(cb);
    // Fire immediately with current state so the consumer does
    // not need separate initial-paint code. Capture the values
    // BEFORE registering as the baseline, so the first underlying
    // event fires the subscriber only when the value actually
    // changes from this initial fire.
    const state: UndoState = {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    };
    this._lastCanUndo = state.canUndo;
    this._lastCanRedo = state.canRedo;
    try {
      cb(state);
    } catch {
      // A throwing initial callback must not strand the registration;
      // returning the unsub handle lets the app recover.
    }
    return () => {
      this._undoStateSubs.delete(cb);
    };
  }

  // Internal: fire `_undoStateSubs` if canUndo / canRedo flipped.
  // Called from `_ensureLoroSubscribed`'s event dispatch.
  private _maybeFireUndoState(): void {
    // A stream's undo state is its document's: whatever moved here (a write
    // landing, the stream turning read-only) re-reads the document's.
    if (!this._undoGroup.isOwner(this)) this._undoGroup.changed();
    if (this._undoStateSubs.size === 0) return;
    // A step can replay as several commits, and each fires a Loro event
    // before the stacks settle; `_replayUndo` fires once at the end.
    if (this._replayingUndo) return;
    const canUndo = this.canUndo();
    const canRedo = this.canRedo();
    if (canUndo === this._lastCanUndo && canRedo === this._lastCanRedo) {
      return;
    }
    this._lastCanUndo = canUndo;
    this._lastCanRedo = canRedo;
    const state: UndoState = { canUndo, canRedo };
    for (const cb of this._undoStateSubs) {
      try {
        cb(state);
      } catch {
        // A throwing subscriber must not affect the others.
      }
    }
  }

  // Register a callback that fires exactly once when the server
  // tells this Document its underlying doc has been evicted (today:
  // soft-delete via the hosted Delete tab or the underlying
  // `DELETE /documents/:docId` API; future: revoked membership,
  // organization deletion cascade). Late-attached listeners fire
  // synchronously on registration if the gone event already happened.
  //
  // The Document is NOT auto-closed; callers may want to render a
  // "the document was deleted" overlay before closing. Disable any
  // pending mutations in the listener and call `close()` when ready.
  // Mutations after `_markGone` still mutate the local CRDT, and stay
  // local: `_shipLocalOp` keeps them off the transport and out of
  // `savingCount`, so this one notice is what the app hears about the
  // eviction rather than a refusal per later edit.
  onGone(cb: DocumentGoneListener): DocumentGoneUnsubscribe {
    // Guard like `subscribe` / `subscribeUndoState`: `_suspend` clears these
    // signals' listeners so a stale handle from a parked session does not
    // receive the next session's events. Without this throw a listener wired
    // onto a closed/suspended handle would attach and survive into the resumed
    // open (which reuses the same cached Document), the exact cross-session
    // leak `_suspend` sets out to prevent.
    this._assertOpen();
    return this._gone.on(cb);
  }

  /** What the importer reported about the file this document was read
   *  from, as the open found it. `null` on a document no import produced and
   *  on a clean import. */
  get importReport(): ImportReport | null {
    return this._importReport;
  }

  /** @internal Seeded from the join. */
  _setImportReport(report: ImportReport | null): void {
    this._importReport = report;
  }

  /** @internal On a frozen open: whether the document has moved since this
   *  copy last loaded. False on every other open, which applies changes as
   *  they come. */
  get changed(): false {
    return this._changed as false;
  }

  /** @internal On a frozen open, fires when the copy learns the document
   *  moved since it last loaded (a content edit, an import landing or
   *  failing, the document being deleted): once per load, and again after a
   *  `reload()` once the document moves past what that load brought. Never
   *  fires on any other open. The document is watched only while a listener is
   *  registered and until the copy is closed. */
  onChanged(cb: () => void): () => void {
    this._assertOpen();
    this._changedListeners.add(cb);
    if (this._changed) {
      queueMicrotask(() => {
        if (!this._closed && this._changed && this._changedListeners.has(cb)) cb();
      });
    } else {
      this._watchForChange();
    }
    return () => {
      this._changedListeners.delete(cb);
      this._unwatchIfIdle();
    };
  }

  private _unwatchIfIdle(): void {
    if (this._changedListeners.size === 0 && this._statusWatches === 0) {
      this._stopChangeNotice?.();
      this._stopChangeNotice = null;
    }
  }

  private _watchForChange(): void {
    if (this._stopChangeNotice === null && this._changeNotice !== null) {
      this._stopChangeNotice = this._changeNotice(() => this._markChanged());
    }
  }

  /**
   * Calls the handlers with the input files of `key`. `loaded` gets every
   * file on each subscribe, then each new version, on any copy. `changed`
   * gets the files changed since this document last read them, on a copy
   * that can edit, each recorded as read off the Undo stack once its handler
   * resolves. `removed` gets each file that left. Calls for one file never
   * overlap. Subscriptions to one key share one set of calls, and each
   * subscription's handlers are called for every input; a `changed` input is
   * recorded as read once all of them resolve. Returns an unsubscribe.
   */
  subscribeInputDocuments(
    key: string,
    handlers: InputDocumentHandlers,
    options?: InputDocumentOptions,
  ): () => void {
    this._assertOpen();
    if (handlers === null || typeof handlers !== 'object') {
      throw new TypeError('subscribeInputDocuments: pass an object of handlers');
    }
    if (!isInputKey(key)) throw new TypeError(`subscribeInputDocuments: "${String(key)}" is not a valid key`);
    const named = handlers as Record<string, unknown>;
    if (!['loaded', 'changed', 'removed', 'status', 'settled'].some((name) => typeof named[name] === 'function')) {
      throw new TypeError('subscribeInputDocuments: handlers must include loaded, changed, removed, status or settled');
    }
    const hub = this._inputStatus();
    return this._inputFollowers.subscribe(
      {
        subscribeStatus: (k, cb) => hub.subscribeKey(k, cb),
        canWrite: () => !this._closed && !this.readOnly,
        markRead: (status, options) => this.markRead(status, options),
        open: this._inputsRuntime?.open ?? null,
      },
      key,
      handlers,
      options,
    );
  }

  /**
   * @internal Calls `cb` with the status of `key` once it is read, and again
   * whenever it changes: an input file was added, modified or removed, the
   * key's references changed, or this document's read marks moved (an Undo
   * of `markRead` included, which reports at once). Returns an unsubscribe.
   */
  subscribeInputStatus(key: string, cb: (status: InputStatus) => void): () => void {
    this._assertOpen();
    if (typeof cb !== 'function') throw new TypeError('subscribeInputStatus: pass a callback');
    if (!isInputKey(key)) throw new TypeError(`subscribeInputStatus: "${String(key)}" is not a valid key`);
    return this._inputStatus().subscribeKey(key, cb);
  }

  /** @internal Wired by the SDK's open factory. */
  _setInputsRuntime(runtime: InputsStatusRuntime | null): void {
    this._inputsRuntime = runtime;
  }

  /** @internal The platform moved `key`'s status to `rev`; both null after a
   *  resubscribe, which may have missed a nudge for any key. */
  _inputStatusNudged(key: string | null, rev: number | null): void {
    this._inputStatusHub?.nudged(key, rev);
  }

  private _inputStatus(): InputStatusHub {
    if (this._inputStatusHub !== null) return this._inputStatusHub;
    const runtime = this._inputsRuntime;
    if (runtime === null) {
      throw new Error('subscribeInputStatus: Document has no server identity. Opened via the SDK factory?');
    }
    this._inputStatusHub = new InputStatusHub({
      runtime,
      lineId: () => this._branchId,
      localRoots: () => this._inputsLocalRoots(),
      watchLocalRoots: (cb) => this._watchInputsRoots(cb),
    });
    return this._inputStatusHub;
  }

  // The reserved roots' plain values. A root nobody has written is read as
  // empty without asking the engine for it, since asking creates it.
  private _inputsLocalRoots(): InputsLocalRoots | null {
    if (this._sealedRoots !== null || this._closed) return null;
    const engine = this._doc;
    const present = engine.getShallowValue() as Record<string, unknown>;
    return {
      refs: INPUTS_REFS_ROOT in present ? engine.getMap(INPUTS_REFS_ROOT).toJSON() : {},
      read: INPUTS_READ_ROOT in present ? engine.getMap(INPUTS_READ_ROOT).toJSON() : {},
    };
  }

  private _watchInputsRoots(cb: () => void): () => void {
    if (this._sealedRoots !== null || this._closed) return () => {};
    const targets = new Set([`cid:root-${INPUTS_REFS_ROOT}:Map`, `cid:root-${INPUTS_READ_ROOT}:Map`]);
    return this._doc.subscribe((batch) => {
      if (batch.events.some((event) => targets.has(String(event.target)))) cb();
    });
  }

  /** @internal How a frozen copy watches its document: starts watching,
   *  calls `fire` when the document moves, and returns the stop. */
  _setChangeNotice(start: ((fire: () => void) => () => void) | null): void {
    this._changeNotice = start;
  }

  /** @internal Stops a frozen copy's notice once it has reported a move and
   *  nobody is waiting on pending work. */
  _settleChangeNotice(): void {
    if (!this._changed) return;
    if (this._statusWatches > 0 && this._workStatus.work?.pending === true) return;
    this._stopChangeNotice?.();
    this._stopChangeNotice = null;
  }

  /** @internal Wire a frozen copy's reload: re-join, apply the result in
   *  place, and re-point the change notice at what that join brought. */
  _setFrozenReloader(reload: () => Promise<void>): void {
    this._frozenReloader = reload;
  }

  // The notice is spent on its first frame, so the watch stops here: the topic
  // carries every op of the document, and a copy that already knows it moved
  // has no use for the rest until it reloads. A copy whose work is still
  // pending keeps it while an `onStatus` listener waits, because the import
  // landing moves the document before its terminal status arrives.
  private _markChanged(): void {
    if (this._changed || this._closed) return;
    this._changed = true;
    this._settleChangeNotice();
    const listeners = [...this._changedListeners];
    for (const cb of listeners) {
      try {
        cb();
      } catch (err) {
        console.error('Brass: an onChanged listener threw', err);
      }
    }
  }

  /**
   * The work in flight on this document (a new version importing, a drive
   * sync), or `null` when there is none. Render `message` verbatim, draw a
   * bar from `progress` when present, and show a waiting state while
   * `pending`. Later phases arrive through `onStatus`.
   */
  get status(): DocumentWorkStatus | null {
    return this._workStatus.status;
  }

  // The platform's work status alone, without the SDK's own notice over it.
  // Every SDK-side decision about whether work is pending reads this, since
  // the notice describes this client's connection rather than the platform's
  // work.
  /** @internal */
  get _workStatusNow(): DocumentWorkStatus | null {
    return this._workStatus.work;
  }

  // Tell the reader their edits are waiting to save, through `status`, while
  // they wait: on a connection that has not opened (`NEVER_OPENED_NOTICE_MS`),
  // or on one that leaves an edit unanswered (`UNANSWERED_OP_NOTICE_AFTER`).
  // The doc transport decides when; the notice clears itself once nothing is
  // waiting (`_fireSubscribers`). A stream raises it on the document that
  // opened it as well, since the app renders that document's status.
  /** @internal */
  _showConnectionNotice(kind: keyof typeof SAVE_NOTICES = 'never_opened'): void {
    if (this._closed || this.savingCount === 0) return;
    this._workStatus.setNotice(SAVE_NOTICES[kind]);
    this._connectionNoticeObserver?.(kind);
  }

  private _connectionNoticeObserver: ((kind: keyof typeof SAVE_NOTICES) => void) | null = null;

  /** @internal */
  _observeConnectionNotice(observer: ((kind: keyof typeof SAVE_NOTICES) => void) | null): void {
    this._connectionNoticeObserver = observer;
  }

  /**
   * Calls `cb` with every work-status update, and once on attach when a
   * status is already known. `pending: false` marks the work finished, as a
   * success or as a failure whose `message` the app shows. Returns an
   * unsubscribe.
   *
   * Do not parse `message` or infer phases from it: its wording changes
   * without an SDK release.
   */
  onStatus(cb: DocumentStatusListener): DocumentStatusUnsubscribe {
    // See `onGone`: guard the cross-session listener leak.
    this._assertOpen();
    const stop = this._workStatus.on(cb);
    // A frozen copy hears the work that was pending when it loaded on its
    // change notice, which runs only while somebody listens. A live copy's
    // transport always delivers status.
    if (this._changeNotice === null || this._workStatus.work?.pending !== true) return stop;
    this._statusWatches += 1;
    if (!this._changed) this._watchForChange();
    let stopped = false;
    return () => {
      stop();
      if (stopped) return;
      stopped = true;
      this._statusWatches -= 1;
      this._unwatchIfIdle();
      this._settleChangeNotice();
    };
  }

  // Internal: store the latest status and fire listeners. Not
  // one-shot: every phase re-emits. A terminal status (`pending:
  // false`) is retained so a late `onStatus` subscriber still sees the
  // final state.
  /** @internal */
  _emitStatus(
    incoming: DocumentWorkStatus,
    opts?: {
      // The caller imported the document's content immediately before this
      // emit, so the work delivered what it promised whatever the terminal
      // frame says.
      contentLoaded?: boolean;
    },
  ): void {
    // A late reload/reconcile closure that resolved after `close()` must not
    // re-emit onto a torn-down doc (its undo stack is freed below in `close`).
    if (this._closed) return;
    // An import in flight holds the document against a settled status from
    // anywhere else (a late frame for the work that stored the file), because
    // an edit made before the import lands leaves the file unimportable. A
    // join reporting the import done clears `_awaitsImport`, which releases
    // it for a client waiting on another's import.
    const status =
      this._importHold !== null && this._awaitsImport && incoming.pending !== true
        ? this._importHold
        : incoming;
    const wasReadOnly = this.readOnly;
    // Terminal work that still reports itself as locking editing is inbound
    // work that ended without content: the platform clears the status when
    // hydration / extraction succeeds, so what it reports terminally is a
    // failure. Anything else means the doc is either loading or holds what
    // it has.
    this._loadFailed =
      opts?.contentLoaded !== true &&
      status.pending === false &&
      status.blocking === true;
    this._workStatus.emit(status);
    // A blocking work-status is one of the inputs to `canUndo` / `canRedo`
    // (via `_isLoadLocked`), so a status that engages or releases the load
    // lock flips the undo/redo availability with no accompanying commit.
    // Refresh the undo-state notifier here so a subscribeUndoState-bound
    // button tracks the lock, not only CRDT edits.
    this._maybeFireUndoState();
    // An app re-reads `readOnly` in its `subscribe` handler, so a status that
    // locks or releases a document it has already bound has to reach that
    // handler, or its edit controls stay as they were.
    if (this.readOnly !== wasReadOnly) this._fireSubscribers({ kind: 'commands' });
  }

  // The current drive sync state of this document, or `null` when the
  // doc is not linked to a drive source. An app reads `state` / `canPush`
  // to tell the reader they have unpublished edits, and renders the
  // server-authored `label` / `detail` as the wording; publishing itself
  // is the hosted toolbar's control. Seeded on open
  // (for a drive-linked doc) and kept live as edits, refreshes, and
  // pushes move the state.
  get driveStatus(): DocumentDriveStatus | null {
    return this._driveStatus.status;
  }

  // Subscribe to drive sync-state changes. Fires once on attach with
  // the current state when one is already known, then on every change
  // (an edit flipping the doc to `ahead`, a push re-syncing it, the
  // source moving it to `behind`). De-duped server-state-side: a
  // METADATA change that did not move the sync state does not re-fire.
  // Returns an unsubscribe.
  //
  // As with `onStatus`, the app must not parse `label` / `detail`: the
  // server owns the wording. Branch only on `state` / `canPush`.
  onDriveStatus(
    cb: DocumentDriveStatusListener,
  ): DocumentDriveStatusUnsubscribe {
    // See `onGone`: guard the cross-session listener leak.
    this._assertOpen();
    return this._driveStatus.on(cb);
  }

  // Internal: store the latest drive state and fire listeners,
  // skipping a no-op re-emit.
  /** @internal */
  _emitDriveStatus(status: DocumentDriveStatus): void {
    if (this._closed) return;
    this._driveStatus.emit(status);
    // A document that has become a mirror publishes through its link from
    // now on, so the create-an-artifact offer goes with the arrival of the
    // status that replaces it.
    this._drivePublishTarget.set(null);
  }

  // Whether this document's export runs in THIS app, which is what decides
  // whether a push carries bytes. Not on `driveStatus`: it is a fact about
  // the caller rather than about the document, and it is all an app is told
  // about the exporter, never which app it is when it is not this one.
  private _exportsHere = false;

  /** @internal */
  get _exportRunsHere(): boolean {
    return this._exportsHere;
  }

  /** @internal */
  _setExportRunsHere(runsHere: boolean): void {
    this._exportsHere = runsHere;
  }

  // Internal: where this document can be published while it mirrors nothing.
  /** @internal */
  get _publishTarget(): DrivePublishTarget | null {
    return this._drivePublishTarget.target;
  }

  /** @internal */
  _setPublishTarget(target: DrivePublishTarget | null): void {
    if (this._closed) return;
    this._drivePublishTarget.set(target);
  }

  // Internal: how the publish of a document that mirrors nothing is going.
  /** @internal */
  get _publishState(): DrivePublishState {
    return this._drivePublishTarget.state;
  }

  /** @internal */
  _emitPublishState(state: DrivePublishState): void {
    if (this._closed) return;
    this._drivePublishTarget.setState(state);
  }

  /** @internal */
  _onPublishState(cb: () => void): () => void {
    return this._drivePublishTarget.onState(cb);
  }

  // Internal: mark the doc evicted. Idempotent (multiple frames arrive
  // for the same doc when both `doc:<id>` and `presence:doc:<id>`
  // topics fan out; we collapse them so the user-side `onGone`
  // listener fires exactly once).
  /** @internal */
  _markGone(reason: DocumentGoneReason): void {
    // An evicted doc's outstanding local ops can never ack (the transport
    // cancels their resend timers on `doc_gone`), so stop counting them as
    // "saving": without this the doc renders "no longer available" and
    // "Saving N changes…" at once until `close()`.
    if (this._outstandingByClientId.size > 0) {
      this._outstandingByClientId.clear();
      this._resyncPushClientOpIds.clear();
      this._fireSubscribers({ kind: 'saving-count' });
    }
    this._provisionalInputs.clear();
    this._gone.mark(reason);
  }

  // --- References and read marks -------------------------------------------

  // How many handle `mutate` calls are running, and how many of those asked
  // to stay off the Undo stack. A commit inside any of them carries the
  // non-undoable origin, so a write the app asked to keep off the stack does
  // not reach it through a batch boundary or a nested handle.
  private _mutateDepth = 0;
  private _nonUndoableDepth = 0;
  // `dependsOn` / `markRead` writes waiting for the running mutate to finish.
  // A mutate can commit several times (`mutate-batching.ts`), and a write
  // left in the open transaction rides whichever commit comes next, so a
  // read mark could arrive before the results it acknowledges. Each runs as
  // a commit of its own after the mutate's last one.
  private _inputsQueue: InputsWrite[] = [];
  // The client op ids `_shipLocalOp` mints while a reference commit runs.
  private _shipCapture: string[] | null = null;
  private readonly _provisionalInputs = new ProvisionalInputsTracker();

  /**
   * @internal The document's `updated_at` as this copy read it when it
   * opened. `markRead` records a document at this value. `null` for a
   * document not opened from the platform.
   */
  get updatedAt(): string | null {
    return joinStampOf(this) ?? null;
  }

  /** @internal Where a key's provisional entry is posted once the op
   *  carrying its change is acknowledged. */
  _setProvisionalInputsPoster(poster: ProvisionalInputsPoster | null): void {
    this._provisionalInputs.setPoster(poster);
    // A post's answer names the key's revision after it, which reads the same
    // as a nudge: a status behind it fetches the change.
    this._provisionalInputs.onAnswer(
      poster === null ? null : (answer) => this._inputStatusNudged(answer.key, answer.rev),
    );
  }

  /** @internal Run a handle's mutate, so its commits carry the origin it asked
   *  for and the reference writes queued inside it commit after it. */
  _runInMutate(undoable: boolean, fn: () => void): void {
    // A nested mutate that changes the origin first commits what the enclosing
    // one has written so far, and commits its own writes before handing back,
    // so each write reaches the Undo stack per the mutate that made it.
    const switchesOrigin = !undoable && this._nonUndoableDepth === 0 && this._mutateDepth > 0;
    if (switchesOrigin) this._commitPendingMutate();
    this._mutateDepth += 1;
    if (!undoable) this._nonUndoableDepth += 1;
    let threw = true;
    try {
      fn();
      threw = false;
    } finally {
      if (switchesOrigin) this._commitPendingMutate();
      this._mutateDepth -= 1;
      if (!undoable) this._nonUndoableDepth -= 1;
      if (this._mutateDepth === 0) {
        const queued = this._inputsQueue;
        this._inputsQueue = [];
        // A mutate that threw left its results partly written, so the marks
        // that acknowledge them are not written either.
        if (!threw) this._flushInputs(queued);
      }
    }
  }

  private _commitPendingMutate(): void {
    if (this._doc.getPendingTxnLength() > 0) this._handleOwner.commitMutate();
  }

  private get _mutateCommitOrigin(): string {
    return this._nonUndoableDepth > 0 ? NON_UNDOABLE_COMMIT_ORIGIN : MUTATE_COMMIT_ORIGIN;
  }

  /**
   * Records the documents `key` depends on, replacing what it held. `null`
   * removes the key and its read marks. Writes only what differs from this
   * copy, so a reference another reader adds or removes at the same time
   * keeps their change. Undoable, as part of the current step, unless called
   * inside `mutate(fn, { undoable: false })`.
   */
  dependsOn(key: string, refs: readonly InputReference[] | null): void {
    this._handleOwner.assertWritable();
    if (!isInputKey(key)) throw new TypeError(`dependsOn: "${String(key)}" is not a valid key`);
    if (refs !== null && !Array.isArray(refs)) {
      throw new TypeError('dependsOn: refs must be an array of references or null');
    }
    const parsed: WireReference[] = [];
    for (const ref of refs ?? []) {
      const one = parseInputReference(ref);
      if (one === null) throw new TypeError('dependsOn: refs holds a value that is not a reference');
      if (one.extent === 'document' && this._docId !== null && one.doc_id === this._docId) {
        throw new Error('dependsOn: a document cannot reference itself');
      }
      parsed.push(one);
    }
    const refusal = this._inputsRuntime?.refusesReferences;
    if (refusal !== undefined && parsed.length > 0) throw new BrassError(refusal);
    const next = refs === null ? null : parsed;
    this._queueInputs(this._nonUndoableDepth === 0, () => {
      const refsMap = this._doc.getMap(INPUTS_REFS_ROOT);
      let changed = applyRootWrites(refsMap, inputRefsWrites(rootView(refsMap), key, next));
      if (next === null) {
        const readMap = this._doc.getMap(INPUTS_READ_ROOT);
        changed = applyRootWrites(readMap, inputReadClearWrites(rootView(readMap), key)) || changed;
      }
      return changed ? key : null;
    });
  }

  /**
   * @internal Records that this reader read files for the key `status` reports, and
   * acknowledged the removed files that status lists. With no `files`, every
   * file the status lists as added or modified is recorded at the version the
   * status reports. Otherwise each entry of `files` is recorded: an opened
   * copy at the `updatedAt` it was opened at (left out while its import is
   * pending, so it stays changed), and an entry of the status's own `files`
   * or `changed` at the version the status reports. Joins the current Undo
   * step unless `undoable` is false.
   */
  markRead(status: MarkReadStatus, options?: MarkReadOptions): void {
    this._handleOwner.assertWritable();
    const key = status?.key;
    if (!isInputKey(key)) throw new TypeError('markRead: pass the status `subscribeInputStatus` reported');
    // A list of files passed where the options go would otherwise read as no
    // files, and record every changed one.
    if (Array.isArray(options)) throw new TypeError('markRead: pass the files as `{ files }`');
    const files = options?.files;
    if (files !== undefined && !Array.isArray(files)) {
      throw new TypeError('markRead: `files` must be an array');
    }
    // The version the status reports for each file, which is what an entry
    // taken from the status is recorded at: an edit that lands after the
    // status stays changed.
    const reported = new Map<string, string>();
    for (const file of status.inputs ?? []) reported.set(file.doc_id, file.updated_at);
    const items: ReadonlyArray<MarkReadHandle | MarkReadEntry> =
      files ?? status.changed.filter((c) => c.change !== 'removed');
    const reads: Array<{ docId: string; stamp: number }> = [];
    for (const item of items) {
      let docId: string | null;
      let version: string | null;
      if ('doc_id' in item) {
        // A removed file is acknowledged from `status.changed` below.
        if ((item as { change?: string }).change === 'removed') continue;
        docId = item.doc_id;
        version = reported.get(docId) ?? null;
        if (version === null) {
          throw new TypeError(`markRead: the status reports no version for ${docId}`);
        }
      } else {
        if (item.status?.pending === true) continue;
        docId = item.id;
        version = item.updatedAt;
      }
      const stamp = typeof version === 'string' ? inputStampFromUpdatedAt(version) : null;
      if (!isInputDocId(docId) || stamp === null) {
        throw new TypeError('markRead: each file must be a document opened from Brass or an entry of the status');
      }
      reads.push({ docId, stamp });
    }
    const removed = status.changed
      .filter((c) => c.change === 'removed')
      .filter((c) => isInputDocId(c.doc_id))
      .map((c) => ({ docId: c.doc_id, leftAt: c.updated_at ?? null }));
    this._queueInputs(options?.undoable !== false, () => {
      const readMap = this._doc.getMap(INPUTS_READ_ROOT);
      const view = rootView(readMap);
      let changed = false;
      const write = (docId: string, mark: InputReadMark): void => {
        const writes = inputReadMarkWrites(view, key, docId, mark);
        for (const k of writes.delete) delete view[k];
        Object.assign(view, writes.set);
        changed = applyRootWrites(readMap, writes) || changed;
      };
      for (const { docId, stamp } of reads) {
        write(docId, inputReadMarkFor(latestReadMark(view, key, docId), stamp));
      }
      for (const { docId, leftAt } of removed) {
        write(docId, inputRemovalMark(latestReadMark(view, key, docId), leftAt));
      }
      return changed ? key : null;
    });
  }

  private _queueInputs(undoable: boolean, apply: () => string | null): void {
    const entry: InputsWrite = { undoable, apply };
    if (this._mutateDepth > 0) {
      this._inputsQueue.push(entry);
      return;
    }
    this._flushInputs([entry]);
  }

  // Commit queued reference writes in call order, one commit per run of
  // writes that share an origin, and wait to post each key they changed.
  private _flushInputs(entries: readonly InputsWrite[]): void {
    if (entries.length === 0 || this._readOnlyBecause !== null) return;
    this._ensureLocalUpdatesSubscribed();
    let i = 0;
    while (i < entries.length) {
      const undoable = entries[i]!.undoable;
      const keys = new Set<string>();
      for (; i < entries.length && entries[i]!.undoable === undoable; i += 1) {
        const key = entries[i]!.apply();
        if (key !== null) keys.add(key);
      }
      if (keys.size === 0) continue;
      this._shipCapture = [];
      let shipped: string[];
      try {
        this._doc.setNextCommitOrigin(undoable ? MUTATE_COMMIT_ORIGIN : NON_UNDOABLE_COMMIT_ORIGIN);
        this._doc.commit();
      } finally {
        shipped = this._shipCapture;
        this._shipCapture = null;
      }
      if (shipped.length === 0) continue;
      const state = decodeInputsRoots(
        this._doc.getMap(INPUTS_REFS_ROOT).toJSON(),
        this._doc.getMap(INPUTS_READ_ROOT).toJSON(),
      );
      for (const key of keys) {
        this._provisionalInputs.register(
          key,
          this._branchId,
          state.get(key) ?? { refs: [], read: {} },
          shipped,
        );
      }
    }
  }

  /**
   * The top-level collections of the stream this document is open at, keyed
   * as it keys them, each naming the kind of handle that reads it.
   *
   * A partitioned document keeps its collections per stream, so this is the
   * open stream's answer rather than every stream's. `listStreams` names the
   * rest, and `stream.roots()` asks one of them the same question.
   *
   * `map` / `list` are get-or-create, and taking the wrong kind for a key
   * materializes a second container beside the real one, so read this before
   * taking a handle on a key you are unsure of. A collection holding nothing
   * is not listed, which is what keeps a handle taken but never written from
   * appearing as one.
   *
   * The cost is the number of collections rather than the size of the
   * document. In checkout, it describes the version being previewed.
   */
  roots(): Record<string, RootKind> {
    this._assertNotClosed();
    if (this._sealedRoots !== null) return this._sealedRoots.roots();
    const source =
      this._checkout !== null ? this._checkout.previewDoc : this._doc;
    const found: [string, RootKind][] = [];
    for (const [key, containerId] of Object.entries(source.getShallowValue())) {
      const kind = rootKindOf(containerId);
      if (kind === null || isReservedRootName(key)) continue;
      // Reading the container's own count, rather than its value, is what
      // keeps this off the projection: an empty collection is skipped without
      // anything being decoded.
      const container = source.getContainerById(containerId);
      if (container === undefined || rootIsEmpty(container)) continue;
      if (holdsOnlyMarkers(key, container)) continue;
      found.push([key, kind]);
    }
    // Loro reports roots in registration order, which is an accident of who
    // wrote what first. Inserting in key order makes a reader's iteration
    // stable across opens.
    found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return Object.fromEntries(found);
  }

  // Plain-JS projection of the current state, leaving out a root that holds
  // nothing. A CRDT cannot store an empty collection, and the root a Document
  // registers on open is empty until written, so a projection that kept empty
  // roots would change shape when the storage swaps in place under a reader.
  // Every other root stays whatever its kind: the sealed-copy builder reads
  // this projection to refuse a kind the frozen form cannot carry.
  toJSON(): Record<string, unknown> {
    this._assertNotClosed();
    // When in checkout, read from the preview LoroDoc so the app
    // renders the historical state. Returning to head clears
    // `_checkout` and reads go back to the live `_doc`.
    const json =
      this._sealedRoots !== null
        ? this._sealedRoots.toJSON()
        : engineJSON(this._checkout !== null ? this._checkout.previewDoc : this._doc);
    for (const [key, value] of Object.entries(json)) {
      if (projectsEmpty(value)) delete json[key];
    }
    return json;
  }

  /**
   * Snapshot bytes; inverse of `openFromSnapshot`, for round-trip tests.
   * @internal
   */
  _exportSnapshot(): Uint8Array {
    return this._doc.export({ mode: 'snapshot' });
  }

  // Durability handshake (see `wireDocTransport`'s `doc_init` handler).
  //
  // Run the handshake and push the missing slice if there is one. Shared
  // by the `doc_init` (reconnect) path and the `doc_ops_dropped`
  // (prompt-notification) path, so the loop guard lives here rather than
  // in either caller. No-op when the durable frontier already covers the
  // local doc, while a prior resync push is still unacked, or when the
  // missing slice is too large to ship as one op (see the cap below).
  //
  // The return value says whether the caller may stop asking. `covered`
  // means the durable frontier holds everything local does, so the
  // handshake is finished; every other outcome leaves the doc diverged and
  // is the caller's cue to run the handshake again once the push settles.
  /** @internal */
  maybeResyncPush(
    persistedSnapshotVersionVector: Uint8Array,
    durableTailBlobs: Uint8Array[],
    deliveringBlobs: readonly Uint8Array[] = [],
  ): ResyncPushOutcome {
    // `computeResyncPush` reads `this._doc.version()` / `export()`; refuse on a
    // closed (freed) doc so a late `doc_ops_dropped` / periodic-reverify
    // closure can't touch freed WASM.
    if (this._closed) return 'closed';
    // Loop guard: skip while any chunk of a prior push is still unacked,
    // so a flurry of reconnects cannot re-push the same missing slice.
    for (const id of this._resyncPushClientOpIds) {
      if (this._outstandingByClientId.has(id)) return 'in-flight';
    }
    const chunks = this.computeResyncPush(
      persistedSnapshotVersionVector,
      durableTailBlobs,
      deliveringBlobs,
    );
    if (chunks === 'covered') return 'covered';
    if (chunks === 'undecodable') return 'undecodable';
    for (const chunk of chunks) {
      const id = this.injectLocalUpdate(chunk);
      if (id !== null) this._resyncPushClientOpIds.add(id);
    }
    return 'pushed';
  }

  // Given the server's persisted snapshot version vector and the op
  // blobs the server is also serving on the join tail, decide whether
  // this client holds CRDT knowledge the durable server state lacks,
  // and if so return the update blob that fills exactly those holes.
  //
  // What the server holds is the snapshot (every author's ops from zero to
  // its version vector) plus each tail op it served, range by range: a tail
  // op is durable in the log even though no snapshot has absorbed it. Holding
  // the tail as ranges rather than folding it into one counter per author is
  // what sees a hole: a log that lost an author's op and stored that author's
  // later ones can apply none of them, so the op that fills the hole is
  // exactly what has to go back. Leaving the tail out altogether would flag
  // the whole tail as missing and push it back on every join, which grows the
  // log and loops. `decodeImportBlobMeta` reads each blob's range from its
  // header without a full import, so this stays cheap.
  //
  // Returns the chunks to resync-push, `'covered'` when the durable state
  // already holds everything local does, or `'undecodable'` for a malformed
  // vector / tail blob, which degrades the handshake to a no-op and warns
  // rather than throwing out of the frame handler that drives the live
  // transport. `'undecodable'` is distinct from `'covered'` because it says
  // nothing about whether the doc has diverged, so a caller healing a known
  // divergence must keep asking.
  //
  // The common case is one chunk: when each author is missing only its
  // newest ops, an `update` export carries exactly those, and a realistic
  // gap is far under the per-frame cap. A hole below ops the server holds
  // ships as its own `updates-in-range` span, one range per author per blob,
  // so a blob never re-sends what the server holds. When the missing slice exceeds the cap (a BIM-sized edit set:
  // a geometry import or bulk parametric change discarded then healed, or
  // a large offline divergence on reconnect), it is split into multiple
  // chunks via `updates-in-range` spans, each under the cap, so even a
  // large divergence heals instead of being skipped. Import is idempotent
  // and order-independent (Loro buffers a chunk whose dependency is in a
  // sibling chunk until it arrives), so the chunks need no ordering.
  /**
   * Whether the durable snapshot holds changes by an author this doc has never
   * heard from.
   *
   * Every author a client can hear from reaches it as ops, so a peer present
   * in the durable frontier and absent from the local doc after the tail has
   * applied is one whose changes exist only inside the snapshot. That is the
   * platform having rewritten how the document stores what it stores
   * (compaction's patch fold is the one thing that does this), which a client
   * cannot merge with and cannot undo across: its undo stack inverts the
   * operations it made, and the values those operations wrote now live
   * somewhere else.
   *
   * The answer drives a re-import, which is the existing recovery for exactly
   * this shape (`_applySnapshot` drops both stacks, so undo reports itself
   * unavailable instead of silently reverting nothing).
   *
   * @internal
   */
  _snapshotHasUnseenAuthor(persistedSnapshotVersionVector: Uint8Array): boolean {
    if (this._closed || this._sealedRoots !== null) return false;
    let durable: VersionVector;
    try {
      durable = VersionVector.decode(persistedSnapshotVersionVector);
    } catch {
      // Undecodable says nothing, and the durability handshake already warns
      // about it on the same frame.
      return false;
    }
    const local = this._doc.version().toJSON();
    for (const [peer, counter] of durable.toJSON()) {
      if (counter > 0 && !local.has(peer)) return true;
    }
    return false;
  }

  /** @internal */
  computeResyncPush(
    persistedSnapshotVersionVector: Uint8Array,
    durableTailBlobs: Uint8Array[],
    deliveringBlobs: readonly Uint8Array[] = [],
  ): Uint8Array[] | 'covered' | 'undecodable' {
    // Frozen content holds no local ops, so the durable frontier covers it.
    if (this._sealedRoots !== null) return 'covered';
    let held: HeldRanges;
    try {
      // An op the transport has only just sent is on its way rather than
      // missing; counting it as held keeps the handshake from writing a
      // second copy of it beside the transport's own send.
      held = durableHoldings(persistedSnapshotVersionVector, [
        ...durableTailBlobs,
        ...deliveringBlobs,
      ]);
    } catch (err) {
      console.warn(
        '[Brass] durability handshake skipped: could not decode the persisted version vector or a tail op blob',
        err,
      );
      return 'undecodable';
    }
    const local = this._doc.version();
    const missing = rangesMissingFrom(local, held);
    if (missing.length === 0) return 'covered';
    // Common case: each author is missing only its newest ops, which is an
    // `update` export from a version vector, and the slice fits in one frame.
    const tails = new Map(missing.map((r) => [r.peer, r]));
    const localMap = local.toJSON();
    if (
      tails.size === missing.length &&
      missing.every((r) => r.to === localMap.get(r.peer))
    ) {
      const from = new Map(localMap);
      for (const r of missing) from.set(r.peer, r.from);
      const full = this._doc.export({
        mode: 'update',
        from: VersionVector.parseJSON(from),
      });
      if (full.byteLength <= RESYNC_PUSH_MAX_BYTES) return [full];
    }
    return oneRangePerAuthor(missing).flatMap((group) =>
      this.chunkRanges(group, true),
    );
  }

  // Recursively export the given ranges as one `updates-in-range` blob,
  // splitting by op count until each blob is under the per-chunk cap.
  //
  // `dropOversizedSingle` decides what happens to an irreducible op (one that
  // alone exceeds the cap and the hard ceiling). A resync drops it with a
  // warning so the loop never wedges on an un-sendable frame while the rest
  // of the slice heals. A local commit keeps it: it is an edit the app just
  // made and nothing else will carry it, so it goes to the write path, which
  // reports the refusal to the app rather than losing it silently.
  private chunkRanges(
    ranges: { peer: PeerID; from: number; to: number }[],
    dropOversizedSingle: boolean,
  ): Uint8Array[] {
    const total = ranges.reduce((n, r) => n + (r.to - r.from), 0);
    if (total === 0) return [];
    const blob = this._doc.export({
      mode: 'updates-in-range',
      spans: ranges.map((r) => ({
        id: { peer: r.peer, counter: r.from },
        len: r.to - r.from,
      })),
    });
    if (blob.byteLength <= RESYNC_PUSH_MAX_BYTES) return [blob];
    if (total === 1) {
      // A single op that cannot be split further.
      if (blob.byteLength <= RESYNC_PUSH_HARD_MAX_BYTES) return [blob];
      if (!dropOversizedSingle) return [blob];
      console.warn(
        `[Brass] durability resync skipped one op of ${blob.byteLength} bytes, over the ${RESYNC_PUSH_HARD_MAX_BYTES}-byte single-frame ceiling. The rest of the slice still heals; this op heals on a future snapshot-based recovery.`,
      );
      return [];
    }
    const [first, second] = splitRangesByLength(ranges, total);
    return [
      ...this.chunkRanges(first, dropOversizedSingle),
      ...this.chunkRanges(second, dropOversizedSingle),
    ];
  }

  // A local commit re-exported as several op blobs, or null to ship it whole.
  //
  // `mutate` bounds what one commit carries by committing as it goes, but a
  // commit Loro makes for itself takes no such budget: `redo` replays a whole
  // undo step, so a bulk write that correctly split into many ops comes back
  // as one op the size of the entire write. Past `MAX_OP_BLOB_CHARS` that op
  // is refused outright and the redone edit never persists, and below it, it
  // still lands as one very large write against the document.
  //
  // The ops already exist, so the only lever left is which spans they ship in.
  // The blob names the counter range it covers, and re-exporting a sub-range
  // is what the durability resync already does, so the chunks are ordinary ops
  // a peer applies in sequence.
  //
  // Splitting is abandoned unless EVERY chunk comes in under the cap. A commit
  // holding one value nothing can split (a mesh, a large embedded body) would
  // otherwise ship as a small chunk that lands and an irreducible one that the
  // write path refuses, which puts a record on the server missing the field
  // that made it large and leaves the two copies permanently apart. Whole, its
  // refusal covers the whole edit and the app is told once.
  private splitLocalUpdate(blob: Uint8Array): Uint8Array[] | null {
    if (blob.byteLength <= RESYNC_PUSH_MAX_BYTES) return null;
    let ranges: { peer: PeerID; from: number; to: number }[];
    try {
      const meta = decodeImportBlobMeta(blob, false);
      const start = meta.partialStartVersionVector.toJSON();
      ranges = [];
      for (const [peer, to] of meta.partialEndVersionVector.toJSON()) {
        const from = start.get(peer) ?? 0;
        if (to > from) ranges.push({ peer, from, to });
      }
    } catch {
      // An undecodable blob is one this cannot describe in spans. Shipping it
      // whole is what happens without this path at all.
      return null;
    }
    const total = rangeOpCount(ranges);
    if (total < 2) return null;
    // The blob's own size names how many pieces to ask for, so the split does
    // not rediscover that by halving.
    const parts = Math.min(total, Math.ceil(blob.byteLength / RESYNC_PUSH_MAX_BYTES));
    const chunks = splitRangesEvenly(ranges, parts).flatMap((piece) =>
      this.chunkRanges(piece, false),
    );
    if (chunks.length < 2) return null;
    if (chunks.some((c) => c.byteLength > RESYNC_PUSH_MAX_BYTES)) return null;
    return chunks;
  }

  // Feed an op blob into the local-op send path as if it were a fresh
  // local commit: ship it through the transport's send hook (which mints
  // a client_op_id, sends the frame, and arms the retry tracker) and
  // record it in the outstanding-op map so `savingCount` reflects it and
  // its `op_ack` resolves it. Used by the resync push, whose blob is an
  // export rather than a Loro-emitted local update, so it does not arrive
  // through `subscribeLocalUpdates`. Returns the minted client_op_id, or
  // null when no send hook is wired (offline / test path).
  /** @internal */
  injectLocalUpdate(blob: Uint8Array): string | null {
    this._ensureLocalUpdatesSubscribed();
    const copy = new Uint8Array(blob.byteLength);
    copy.set(blob);
    return this._shipLocalOp(copy);
  }

  // Internal: park the Document in the SDK cache. Clears app-side
  // listeners so a stale handle from this session does not receive
  // events from the next session, but keeps the LoroDoc,
  // UndoController, outstanding-op map, and the underlying WS subscribe
  // alive. `mutate()` and `subscribe()` throw while suspended; the next
  // `openDocumentById` for the same (docId, branchId) calls `_resume()`
  // and the user gets a fresh session over the same state. App code
  // calls `close()`, not this method.
  /** @internal */
  _suspend(): void {
    if (this._closed || this._suspended) return;
    this._suspended = true;
    this._setStreamsSuspended(true);
    // Calls still waiting for a marker get one now rather than after the
    // spacing, and a pending auto-checkpoint is cancelled rather than left to
    // fire against a parked Document.
    this._checkpoints.detach();
    this._subs.clear();
    this._undoStateSubs.clear();
    this._gone.clearListeners();
    this._workStatus.clearListeners();
    this._driveStatus.clearListeners();
    this._drivePublishTarget.clearListeners();
    this._inputFollowers.stopAll();
    this._inputStatusHub?.dispose();
    this._inputStatusHub = null;
    // Presence subscribes its OWN WS topic and keeps it alive across a park
    // (resume does not re-create the controller), so drop its app-side
    // change listeners here the same way as the sets above: a parked doc
    // must not fire the app's `presence.on('change')` callback on remote
    // cursor frames for a doc the app has closed. `leave()` would be wrong,
    // it terminally unsubscribes and the resume path never rebuilds it.
    this.presence?._suspendListeners();
    // Tear down the app-side handle subscriptions, THEN drop the caches.
    // A handle subscribes DIRECTLY to its Loro container (`handles.ts`
    // `_attachChange`), not through `_unsubLoro`, and a parked doc keeps
    // applying remote ops to those live containers (the WS stays attached),
    // so a subscription an app registered before `close()` would keep firing
    // the app's callback on a doc it has closed. Detaching first stops that;
    // fresh handles are minted on resume + next access.
    // The handles over the ones torn down go with them, so a resumed open is
    // handed fresh handles like any other.
    if (this._sealedRoots === null) {
      this._teardownRootHandles();
      this._handles.clear();
    }
    this._rootHandles.clear();
    // Drop the ordered-map cache too. Each wrapper holds the specific root
    // map / list handles it was built from; leaving it while the root caches
    // are cleared would strand those delegates outside `_rebindRootHandles`,
    // so a later version checkout would not rebind them and the ordered map
    // would keep reading live-head state during a historical preview.
    this._orderedMapHandles.clear();
  }

  // Internal: pair of `_suspend`. The SDK calls this when handing a
  // cached Document to a new openDocumentById call. App code does
  // not invoke this directly.
  /** @internal */
  _resume(): void {
    this._suspended = false;
    this._openEpoch += 1;
    this._setStreamsSuspended(false);
    // Pair of the `_suspend` presence gate: reopen the presence controller's
    // outbound path and re-advertise this client's cursor on the resumed open.
    // `_suspend` only closed the gate; without this the parked doc's presence
    // would stay silent for the life of the resumed session.
    this.presence?._resumeListeners();
  }

  // Internal: whether the Document is currently parked. The SDK's
  // open-document layer reads this to gate transport-level work
  // (an op-stream frame arriving for a non-parked, non-closed doc
  // routes normally; for a parked doc the WS is still attached and
  // the frame applies to state but does not run app-side callbacks).
  /** @internal */
  get _isSuspended(): boolean {
    return this._suspended;
  }

  /** @internal Which open this Document is currently in (see `_openEpoch`).
   *  Read by anything holding a per-open mark on a Document, since a park hit
   *  hands the same instance to the next open. */
  get _openGeneration(): number {
    return this._openEpoch;
  }

  /** @internal Whether the latest join reported the document as its stored
   *  file with no import run yet. Set by the open layer on every join, so an
   *  importer can hold the document before its claim goes out. */
  _awaitsImport = false;

  /** @internal The status an importer holds the document under, or null. */
  _importHold: DocumentWorkStatus | null = null;

  /** @internal Why this client stopped waiting to import the document, or
   *  null. */
  _importAbandoned: string | null = null;

  close(): void {
    if (this._closed) return;
    // Before anything is torn down: the final marker reads the seq and the
    // unacked-op count this close is about to drop.
    this._checkpoints.detach();
    this._stopChangeNotice?.();
    this._stopChangeNotice = null;
    this._changedListeners.clear();
    this._closeStreams();
    this._closed = true;
    this._suspended = false;
    if (this._unsubLoro) {
      this._unsubLoro();
      this._unsubLoro = null;
    }
    if (this._unsubLocal) {
      this._unsubLocal();
      this._unsubLocal = null;
    }
    if (this._undo) {
      this._undo.free();
      this._undo = null;
    }
    if (!this._undoGroup.isOwner(this)) {
      this._undoGroup.delete(this);
      this._undoGroup.changed();
    }
    this._thumbnails.destroy();
    this._checkpoints.cancelAuto();
    this._localOpHook = null;
    this._currentSeqProvider = null;
    this._outstandingByClientId.clear();
    this._resyncPushClientOpIds.clear();
    releaseUnsavedWork(this);
    this._subs.clear();
    this._undoStateSubs.clear();
    // Drop the signal listeners too, mirroring `_suspend()`. Their frames
    // can no longer fire once the transport is torn down, but clearing
    // them keeps `close()` from retaining an app's callbacks (and the
    // closures they hold) for the Document's remaining lifetime.
    this._gone.clearListeners();
    this._workStatus.clearListeners();
    this._driveStatus.clearListeners();
    this._drivePublishTarget.clearListeners();
    this._inputFollowers.stopAll();
    this._inputStatusHub?.dispose();
    this._inputStatusHub = null;
    // Detach handle subscriptions before freeing the doc (below): a handle's
    // per-container Loro subscription outlives the cache reference, and
    // `_doc.free()` must not run with subscriptions still attached.
    if (this._sealedRoots === null) this._teardownRootHandles();
    this._rootHandles.clear();
    this._orderedMapHandles.clear();
    // Free a live historical-checkout preview: it is a distinct LoroDoc
    // (allocated by `_checkoutVersion`), so closing while previewing without a
    // prior `returnToHead()` would otherwise leak its WASM heap. The guard
    // mirrors `_checkoutVersion` / `returnToHead`: the frozen cold-link case
    // has `previewDoc === _doc`, where `_doc.free()` below already covers it
    // and an unguarded free would double-free.
    if (this._checkout && this._checkout.previewDoc !== this._engine) {
      try {
        this._checkout.previewDoc.free();
      } catch {
        // ignore; already freed
      }
    }
    this._checkout = null;
    // Loro's WASM has a `free()` to drop the heap-allocated doc state.
    // Calling it after `close()` invalidates the doc, which is what we
    // want; future mutate/subscribe calls throw above.
    this._engine?.free();
  }
}
