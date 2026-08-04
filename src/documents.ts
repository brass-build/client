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

import {
  LoroDoc,
  LoroMap,
  type PeerID,
  VersionVector,
  decodeImportBlobMeta,
} from 'loro-crdt';

import { MutateBatcher } from './mutate-batching.js';
import {
  UndoController,
  type UndoControllerOptions,
} from './undo.js';
import {
  createOrderedMapHandle,
  createRootListHandle,
  createRootMapHandle,
  rebindRootListAnchor,
  rebindRootMapAnchor,
  resyncRootHandle,
  teardownRootHandle,
  wrapLoroMapProxy,
  type ChangeSource,
  type HandleOwner,
  type ListHandle,
  type MapHandle,
  type OrderedMapHandle,
} from './handles.js';
import {
  CURRENT_PAGING_SCHEME,
  isPagedByPageCount,
  META_KEY,
  PAGE_COUNT_KEY,
  PAGING_SCHEME_KEY,
  RECORDS_KEY,
} from './record-paging.js';
import type {
  BranchSummary,
  DocumentCheckpoint,
  DocumentSourceBlob,
  DocumentStreamInfo,
  PushToDriveInput,
  PushToDriveResult,
} from './documents-namespace.js';
import type { DriveResolveResult } from './hosted-ui.js';
import {
  GoneSignal,
  WorkStatusSignal,
  DriveStatusSignal,
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
import {
  BranchController,
  type BranchProvider,
} from './document-branches.js';
import {
  CommandMenu,
  type Command,
  type CommandGroup,
  type CommandSurface,
  type HostedUiProvider,
} from './document-commands.js';
import { DocumentStream, type StreamRuntime } from './document-streams.js';
import { createEmitter } from './emitter.js';

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
// shape backed by a LoroMap / LoroList container tree. `Record<string,
// unknown>` because Loro's value type is dynamic; typed apps pass their
// shape to `DocumentMutator<E>` / `doc.mutate<E>` instead.
export type EntityProxy = Record<string, unknown>;

export type DocumentSubscriber = (event: unknown) => void;
export type DocumentUnsubscribe = () => void;

// Discriminated event the SDK fires through `doc.subscribe` for
// non-CRDT changes (checkout, return-to-head, saving count). Apps can
// ignore the event arg and re-read in the handler, or narrow on
// `event.kind`. CRDT-origin events keep their Loro shape (also
// delivered through the same `subscribe`).
export type SyntheticSubscribeEvent =
  | { kind: 'checkout'; version: number }
  | { kind: 'return-to-head' }
  // A bare re-read tick: the document's branch state settled or changed
  // (the list loaded on open, or a switch/create landed). Carries no
  // payload; the SDK's own chrome (the toolbar branch chip, the page
  // title) re-reads the current branch name, and an app never needs the
  // branch model, management is hosted.
  | { kind: 'branches' }
  | { kind: 'saving-count' }
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
function changeSourceOf(event: unknown): ChangeSource {
  const by = (event as { by?: unknown }).by;
  if (by === 'import') return 'remote';
  if (by === 'checkout') return 'checkout';
  // by === 'local': disambiguate via the commit-origin tag.
  const origin = (event as { origin?: unknown }).origin;
  if (origin === UNDO_COMMIT_ORIGIN) return 'undo';
  if (origin === REDO_COMMIT_ORIGIN) return 'redo';
  return 'local';
}

// Per-chunk cap on a resync-push blob (durability handshake). Each push
// ships as one op frame, and the transport carries 128 KB; the blob is
// base64-encoded (~1.33x) inside a JSON envelope, so the raw blob must
// stay well under that. 64 KB base64s to ~85 KB. A larger missing slice
// is split into multiple chunks (see `computeResyncPush`), each capped.
const RESYNC_PUSH_MAX_BYTES = 64 * 1024;

// Hard ceiling for a single irreducible op (one Loro op, unsplittable).
// Sized so the base64 frame still clears the 128 KB limit (90 KB base64s
// to ~120 KB plus envelope). An op this large cannot occur on a doc
// whose normal edits send at all (same frame limit), so this only guards
// a pathological op; it is skipped with a warning rather than retried
// forever, while the doc's other chunks still heal.
const RESYNC_PUSH_HARD_MAX_BYTES = 90 * 1024;

// Element-wise max of two Loro version vectors. `VersionVector` exposes
// no public join, so round-trip through its `Map<PeerID, number>` JSON
// form. Counters are exclusive ends, so the larger is more advanced.
// Used by the durability handshake to fold the durable tail into the
// snapshot's version vector.
function mergeVersionVectors(
  a: VersionVector,
  b: VersionVector,
): VersionVector {
  const merged = a.toJSON();
  for (const [peer, counter] of b.toJSON()) {
    const current = merged.get(peer);
    if (current === undefined || counter > current) merged.set(peer, counter);
  }
  return VersionVector.parseJSON(merged);
}

// Split half-open per-peer counter ranges into two halves by total op
// count, splitting at most one range across the boundary. `total` must
// be >= 2 so both halves are non-empty (the caller handles total === 1
// as the irreducible single-op case). Order is preserved.
function splitRangesByLength(
  ranges: { peer: PeerID; from: number; to: number }[],
  total: number,
): [
  { peer: PeerID; from: number; to: number }[],
  { peer: PeerID; from: number; to: number }[],
] {
  const half = Math.floor(total / 2);
  const first: { peer: PeerID; from: number; to: number }[] = [];
  const second: { peer: PeerID; from: number; to: number }[] = [];
  let acc = 0;
  for (const r of ranges) {
    const len = r.to - r.from;
    if (acc >= half) {
      second.push(r);
    } else if (acc + len <= half) {
      first.push(r);
      acc += len;
    } else {
      const splitAt = r.from + (half - acc);
      first.push({ peer: r.peer, from: r.from, to: splitAt });
      second.push({ peer: r.peer, from: splitAt, to: r.to });
      acc = half;
    }
  }
  return [first, second];
}

// The record store's page count off a doc's `meta` map, or 0 when
// unpaged. `handles.ts` reads it to resolve which page a key hashes to
// AND to decide whether the store is paged at all (on every root-map
// read / edit). Read by PATH, not `getMap(META_KEY)`: `getMap` is
// get-or-create and would materialize an empty `meta` root on every
// unpaged document, polluting its wire shape; `getByPath` is a pure read
// returning undefined when `meta` does not exist.
function readStorePageCount(source: LoroDoc): number {
  const pc = source.getByPath(`${META_KEY}/${PAGE_COUNT_KEY}`);
  // Same "is paged" predicate as the formats/core readers, so the SDK
  // handle path and the store readers cannot disagree on a malformed
  // count (e.g. a non-finite value must read as unpaged everywhere).
  return isPagedByPageCount(pc) ? (pc as number) : 0;
}

// The paging scheme a paged store was written under, off the same `meta` map
// as the page count (read by path, not `getMap`, for the same reason: a pure
// read that never materializes an empty `meta` root). A paged store predating
// the stamp reports the current scheme, so it stays editable; a store written
// under a newer scheme reports that number, and the edit path refuses it
// rather than hashing a key into the wrong page.
function readStorePagingScheme(source: LoroDoc): number {
  const s = source.getByPath(`${META_KEY}/${PAGING_SCHEME_KEY}`);
  return typeof s === 'number' && s > 0 ? s : CURRENT_PAGING_SCHEME;
}

export interface DocumentOptions {
  // Root key the Document wraps. Defaults to `"entities"` to match the
  // wire protocol's top-level shape.
  rootKey?: string;
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
  readOnly?: boolean;
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
export class Document {
  private readonly _doc: LoroDoc;
  private readonly _rootKey: string;
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
  // Forced read-only on a LIVE head open (distinct from `_isFrozen`, which
  // is a version-pinned open with no live channel). The anonymous
  // link-guest open sets this: the Document keeps a live WS subscription
  // and applies incoming remote ops, but local `mutate` is rejected, so a
  // guest sees edits stream in while being unable to write.
  private readonly _forcedReadOnly: boolean;
  private readonly _root: LoroMap;
  private readonly _entities: EntityProxy;
  // The UndoManager is constructed eagerly so the first call to
  // `doc.mutate(...)` lands in the undo stack. Lazy construction
  // (deferred to first `doc.undo()`) would miss every commit made
  // before that point, which is not the behaviour callers expect.
  // The UndoManager attaches its own `subscribeLocalUpdates` listener
  // only; it does NOT fire on snapshot import, so the
  // cold-load contract is unaffected (imports are not local commits).
  private _undo: UndoController | null;
  // One subscriber channel. Every event reaches every subscriber, whatever
  // produced it (local mutate, remote import, undo, redo, checkout); the
  // app reconciles by value and reads `origin.source` only when it has a
  // non-render reason to know the cause. A throwing subscriber is swallowed
  // so it cannot strand the others or the WS router.
  private readonly _subs = createEmitter<unknown>({ onError: () => {} });
  // Subscribers registered via `subscribeUndoState`. Fired after
  // every underlying Loro event when `canUndo()` or `canRedo()`
  // changed value vs the last fire, so UI bound to undo/redo
  // enabled state stays current without the consumer caring
  // whether the originating event was a local mutate, undo,
  // redo, or remote import.
  private readonly _undoStateSubs: Set<UndoStateSubscriber> = new Set();
  private _lastCanUndo = false;
  private _lastCanRedo = false;
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
  private _checkoutFetcher:
    | ((
        docId: string,
        version: number,
        branchId: string,
      ) => Promise<{
        snapshotBytes: Uint8Array | null;
        tailOpBlobs: Uint8Array[];
        effectiveVersion: number;
        // The per-stream seq vector at this version (from the newest
        // checkpoint at or below it): `{ line_id: seq }`. Lets a preview
        // re-materialize every opened stream at the same point in time.
        // Absent for a stream line's own timeline (no checkpoints) and
        // before any checkpoint recorded one.
        streamSeqs?: Record<string, number>;
      }>)
    | null = null;
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
  private readonly _thumbnails = new ThumbnailCapture({
    isCaptureAllowed: (): boolean =>
      this._isLive && this._checkout === null,
    isAttached: (): boolean => this._isLive,
  });
  private readonly _checkpoints = new CheckpointScheduler({
    docId: (): string | null => this._docId,
    isAttached: (): boolean => this._isLive,
    isAutoAllowed: (): boolean =>
      this._isLive && this._checkout === null,
    currentSeq: (): number | null => this.currentSeq,
    sealUndoStep: (): void => {
      if (this._undo) this._undo.sealStep();
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
  // Live = neither closed nor parked. This is the public-surface gate;
  // internal ingress (remote ops, status emits) deliberately checks
  // `_closed` alone, because a parked doc keeps applying remote state.
  private get _isLive(): boolean {
    return !this._closed && !this._suspended;
  }

  private _assertOpen(): void {
    if (!this._isLive) throw new Error('Document is closed');
  }
  // Server-pushed lifecycle signals: `_gone` is fire-once-then-cache
  // for `doc_gone` eviction; `_workStatus` is latest-retained,
  // re-emit-per-phase for `doc_status`.
  private readonly _gone = new GoneSignal();
  private readonly _workStatus = new WorkStatusSignal();
  // Drive sync state, latest-retained. `null` until the open factory
  // seeds it (drive-linked docs only) and on docs with no drive link.
  private readonly _driveStatus = new DriveStatusSignal();

  // Document-scoped presence. `null` until the WS transport is wired
  // on, and on the offline / test path where there is no transport.
  presence: import('./presence.js').PresenceClient | null = null;

  constructor(loroDoc: LoroDoc, options?: DocumentOptions) {
    this._doc = loroDoc;
    this._rootKey = options?.rootKey ?? 'entities';
    this._docId = options?.docId ?? null;
    this._branchId = options?.branchId ?? null;
    // A Document constructed with a `version` is a "frozen" cold-link
    // open: the SDK materialised the historical state directly into
    // `loroDoc` and there is no live WS channel. The Document is
    // permanently in checkout against itself; `returnToHead` /
    // `_checkoutVersion` are not meaningful on this shape.
    const initialVersion = options?.version ?? null;
    if (initialVersion !== null) {
      this._isFrozen = true;
      this._checkout = {
        previewDoc: loroDoc,
        previewRoot: loroDoc.getMap(this._rootKey),
        version: initialVersion,
      };
    } else {
      this._isFrozen = false;
      this._checkout = null;
    }
    // `readOnly` on a live (non-version) open is a forced read-only: the
    // guest link view. A version open is already frozen, so it does not
    // also need the forced flag.
    this._forcedReadOnly = options?.readOnly === true && initialVersion === null;
    this._root = loroDoc.getMap(this._rootKey);
    this._entities = wrapLoroMapProxy(this._root) as EntityProxy;
    this._undo = new UndoController(this._doc, options?.undo);
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
  >();

  // Get a handle for a top-level LoroMap at `key`. The container is
  // materialized in the underlying LoroDoc immediately (Loro's
  // `getMap` is "get or create"); mutations through the handle do
  // not need to create the container themselves.
  map<T = unknown>(key: string): MapHandle<T> {
    this._assertOpen();
    const cacheKey = `map:${key}`;
    const existing = this._rootHandles.get(cacheKey);
    if (existing) return existing.handle as unknown as MapHandle<T>;
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
    // handle's anchor to the preview doc, and the page count must come
    // from that same doc or keyed reads hash into the wrong page (and a
    // closure pinned to a preview doc would read a freed LoroDoc after
    // returnToHead).
    //
    // Only the record store's paged root (`instances`) may report a page
    // count. `readStorePageCount` reads the document-global
    // `meta.page_count`, so handing it to every root map would make the
    // sibling record-store roots (`meta`, `header`) and any app-owned
    // root map read as paged once `instances` pages, routing their
    // `get`/`has`/`mutate` through the page-hash path against a map that
    // holds no page containers (`get` returns undefined for present keys;
    // `mutate` writes a stray page container into a plain map). A non-
    // record-store key gets a null provider and stays unpaged.
    const handle = createRootMapHandle<unknown>(
      loroMap,
      this._handleOwner,
      key === RECORDS_KEY
        ? (): number =>
            readStorePageCount(
              this._checkout !== null ? this._checkout.previewDoc : this._doc,
            )
        : undefined,
      key === RECORDS_KEY
        ? (): number =>
            readStorePagingScheme(
              this._checkout !== null ? this._checkout.previewDoc : this._doc,
            )
        : undefined,
    );
    this._rootHandles.set(cacheKey, { kind: 'map', key, handle });
    return handle as unknown as MapHandle<T>;
  }

  // Get a handle for a top-level LoroList at `key`.
  list<T = unknown>(key: string): ListHandle<T> {
    this._assertOpen();
    const cacheKey = `list:${key}`;
    const existing = this._rootHandles.get(cacheKey);
    if (existing) return existing.handle as unknown as ListHandle<T>;
    const source =
      this._checkout !== null ? this._checkout.previewDoc : this._doc;
    const loroList = source.getList(key);
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
  orderedMap<T = unknown>(
    mapKey: string,
    orderKey: string,
  ): OrderedMapHandle<T> {
    this._assertOpen();
    const cacheKey = `${mapKey}\u0000${orderKey}`;
    let h = this._orderedMapHandles.get(cacheKey);
    if (!h) {
      h = createOrderedMapHandle<unknown>(
        this.map(mapKey),
        this.list<string>(orderKey),
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
      assertWritable: (): void => {
        this._assertOpen();
        if (this._checkout !== null) {
          throw new Error(
            'Document is read-only: it is showing a historical version. ' +
              'Call `doc.returnToHead()` to edit.',
          );
        }
        if (this._forcedReadOnly) {
          throw new Error(
            'Document is read-only: it was opened via a view-only share link.',
          );
        }
        if (this._isLoadLocked()) {
          throw new Error(
            'Document is still loading its content; wait for the load to ' +
              'finish before editing (see `doc.onStatus`).',
          );
        }
      },
      ensureLocalUpdatesSubscribed: (): void => {
        this._ensureLocalUpdatesSubscribed();
      },
      commitMutate: (): void => {
        this._doc.setNextCommitOrigin(MUTATE_COMMIT_ORIGIN);
        this._doc.commit();
      },
      originOf: (event: unknown): ChangeSource => changeSourceOf(event),
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

  // True when the Document is currently showing a historical version
  // (a checkout): `mutate` throws and edit affordances should be
  // disabled. Reactive: flips on `_checkoutVersion(v)` /
  // `returnToHead()`. `subscribe` fires when this changes, so apps
  // bind it directly inside the subscribe handler.
  get readOnly(): boolean {
    // A doc that is still loading its first content (a drive-linked
    // stub hydrating on first open) is read-only until the bytes
    // arrive: editing it would write ops onto an empty doc that the
    // incoming snapshot is about to replace. The SDK reloads the
    // content automatically when the work finishes (see open-document's
    // `reloadAfterHydration`); until then mutation is rejected. This is
    // also what stops an app's "seed an empty doc" path from clobbering
    // a doc that only looks empty because it has not loaded yet.
    return (
      this._forcedReadOnly || this._checkout !== null || this._isLoadLocked()
    );
  }

  // True when content-replacing work (hydration / extraction) is pending
  // and editing must be locked so incoming bytes do not clobber local
  // ops. A pending PUSH is outbound (it writes the doc out to the drive,
  // nothing replaces local content), so the server marks it
  // `blocking: false` and the doc stays editable while the importer
  // runs. An older server omits `blocking`; absence is treated as
  // blocking so hydration stays locked.
  private _isLoadLocked(): boolean {
    const s = this._workStatus.status;
    return s?.pending === true && s.blocking !== false;
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
  get version(): number | null {
    return this._checkout?.version ?? null;
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
    if (this._checkout !== null) return this._checkout.version;
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
   * Construct an empty Document (empty-snapshot join case, and tests).
   * @internal
   */
  static create(options?: DocumentOptions): Document {
    return new Document(new LoroDoc(), options);
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
    this._doc.import(opBlob);
  }

  // Apply a snapshot blob over the top of an existing Document.
  // Internal: the SDK calls this when the server delivers a fresh
  // snapshot mid-session (e.g. after a compaction cycle). Persistence
  // is server-authoritative, so there is no app-facing snapshot import.
  /** @internal */
  _applySnapshot(snapshot: Uint8Array): void {
    // See `applyRemoteOp`: refuse the import on a closed (freed) doc so a late
    // reload/resync closure can't touch freed WASM. `_closed` only; a parked
    // doc still imports.
    if (this._closed) return;
    this._doc.import(snapshot);
    // The undo stack pre-snapshot referenced ops the new snapshot
    // supersedes. Drop both stacks so undo doesn't try to revert
    // into a state that no longer exists; the user's mental model
    // here is "we just loaded fresh state", and silently retaining
    // a now-broken redo entry would be the worst of both worlds.
    if (this._undo) this._undo.clear();
  }

  // Revert the most recent local commit. Returns `true` if an undo
  // step was applied, `false` if the stack is empty. Remote peers'
  // edits are not in this stack: Loro's UndoManager is local-peer-
  // scoped, which is the user-visible behaviour every collaborative
  // editor lands on (you don't get to undo your collaborator's typing).
  //
  // The reverted change is itself a local commit, so it ships over
  // the WS transport like any other mutation and other peers see the
  // state revert.
  undo(): boolean {
    this._assertOpen();
    // During a checkout the UndoManager still tracks the live head, but reads
    // go through the preview. Undoing would commit against the live `_doc` and
    // ship over the WS transport while the previewing user sees nothing, a
    // silent live edit. Match `canUndo()` (false during a checkout) and no-op.
    if (this._checkout !== null) return false;
    // An undo produces a local commit exactly as `mutate` does, so it obeys
    // the same read-only gates: a view-only guest link (`_forcedReadOnly`)
    // and a pending content-replacing work-status (`_isLoadLocked()`), whose
    // whole purpose is to keep local ops from racing the incoming bytes.
    if (this._forcedReadOnly || this._isLoadLocked()) return false;
    this._ensureLocalUpdatesSubscribed();
    // Tag the commit the UndoManager is about to make so the resulting
    // change reads back as `origin.source === 'undo'`, not `'local'`.
    this._doc.setNextCommitOrigin(UNDO_COMMIT_ORIGIN);
    return this._undo!.undo();
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
    // No-op during a checkout, same reasoning as `undo()`.
    if (this._checkout !== null) return false;
    // Same read-only gates as `undo()` / `mutate()`.
    if (this._forcedReadOnly || this._isLoadLocked()) return false;
    this._ensureLocalUpdatesSubscribed();
    this._doc.setNextCommitOrigin(REDO_COMMIT_ORIGIN);
    return this._undo!.redo();
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
    if (this._undo) this._undo.sealStep();
  }

  // Whether `undo()` would have an effect right now. Feeds the
  // commands machinery and the undo-state notifier; apps consume it
  // through `subscribeUndoState` snapshots.
  private canUndo(): boolean {
    if (this._closed) return false;
    // During a checkout, the undo stack still tracks the live doc's
    // history, but the UI is showing the historical preview and
    // mutate is rejected. Surface that as "can't undo right now" so
    // subscribeUndoState-bound buttons disable correctly.
    if (this._checkout !== null) return false;
    // Fold the same read-only gates `undo()` enforces so a
    // subscribeUndoState-bound button disables while the doc is a view-only
    // guest link or load-locked, rather than inviting an undo the call
    // would refuse.
    if (this._forcedReadOnly || this._isLoadLocked()) return false;
    return this._undo!.canUndo();
  }

  // Whether `redo()` would have an effect right now. As above.
  private canRedo(): boolean {
    if (this._closed) return false;
    if (this._checkout !== null) return false;
    if (this._forcedReadOnly || this._isLoadLocked()) return false;
    return this._undo!.canRedo();
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
  // `E` defaults to `EntityProxy` (the untyped Record<string, unknown>)
  // for backwards-compat with existing callers. Apps with a typed
  // entity shape pass it as a type argument:
  //
  //   doc.mutate<MyEntity>((d) => {
  //     d.entities[id] = myTypedEntity;
  //   });
  //
  // The mutator's `entities` field has the same proxy under the hood
  // regardless of `E`; the generic exists purely to widen the type at
  // the assignment site so closed interfaces don't need an
  // `as Record<string, unknown>` cast.
  mutate<E extends object = EntityProxy>(
    fn: (d: DocumentMutator<E>) => void,
  ): void {
    this._assertOpen();
    if (this._checkout !== null) {
      throw new Error(
        'Document is read-only: it is showing a historical version. ' +
          'Call `doc.returnToHead()` to edit.',
      );
    }
    // A view-only share-link (guest) open is a live head held read-only:
    // remote ops still stream in, but a local edit must be refused. The
    // `_checkout` guard above only covers the version-pinned case, so this
    // is a separate branch.
    if (this._forcedReadOnly) {
      throw new Error(
        'Document is read-only: it was opened via a view-only share link.',
      );
    }
    if (this._isLoadLocked()) {
      throw new Error(
        'Document is still loading its content; wait for the load to ' +
          'finish before editing (see `doc.onStatus`).',
      );
    }
  this._ensureLocalUpdatesSubscribed();
    // A fresh proxy for the call, because the batcher rides it: the
    // long-lived `this._entities` must stay batcher-free for the reads
    // that go through it outside a mutation.
    const batcher = new MutateBatcher(() => {
      this._doc.setNextCommitOrigin(MUTATE_COMMIT_ORIGIN);
      this._doc.commit();
    });
    fn({
      entities: wrapLoroMapProxy(this._root, batcher) as unknown as Record<
        string,
        E
      >,
    });
    // Stamp the commit so `subscribe`'s default path can identify
    // and suppress the local-mutate echo. `setNextCommitOrigin`
    // applies to the very next commit, and `commit()` consumes it.
    this._doc.setNextCommitOrigin(MUTATE_COMMIT_ORIGIN);
    this._doc.commit();
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
  setCheckoutFetcher(
    fetcher:
      | ((
          docId: string,
          version: number,
          branchId: string,
        ) => Promise<{
          snapshotBytes: Uint8Array | null;
          tailOpBlobs: Uint8Array[];
          effectiveVersion: number;
          streamSeqs?: Record<string, number>;
        }>)
      | null,
  ): void {
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
    return this._checkout !== null;
  }

  // Switch the Document to a historical version, in place. @internal
  // (the hosted `history` command drives this). After the promise
  // resolves, `doc.readOnly` is `true`,
  // `doc.version` is the server's effective version (which may round
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
    const { snapshotBytes, tailOpBlobs, effectiveVersion, streamSeqs } =
      await this._checkoutFetcher(this._docId, version, this._branchId);
    if (this._closed || this._suspended) return;
    // A `returnToHead` or a newer `_checkoutVersion` fired while this fetch
    // was in flight. Honour the latest intent: drop this stale result rather
    // than clobbering the live head (or a newer checkout) the user asked for.
    if (generation !== this._checkoutGeneration) return;
    this._checkoutStreamSeqs = streamSeqs ?? {};
    // Materialise the preview into a fresh LoroDoc. The previous
    // checkout's preview LoroDoc, if any, is freed.
    const previewDoc = new LoroDoc();
    if (snapshotBytes !== null) previewDoc.import(snapshotBytes);
    for (const blob of tailOpBlobs) previewDoc.import(blob);
    const previewRoot = previewDoc.getMap(this._rootKey);
    const old = this._checkout;
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
    if (old && old.previewDoc !== this._doc) {
      try {
        old.previewDoc.free();
      } catch {
        // ignore; already freed
      }
    }
    this._fireSubscribers({ kind: 'checkout', version: effectiveVersion });
    this._maybeFireUndoState();
    // Preview every opened stream at the same point in time, so a
    // partitioned document's history shows a consistent historical state
    // across streams rather than a historical default over live streams.
    await this._checkoutOpenStreams();
  }

  // Re-materialize each opened non-default stream at its seq recorded by the
  // active preview's checkpoint. A stream with no recorded seq at this
  // version (opened after the checkpoint, or before any checkpoint recorded
  // one) returns to its own head, so it shows its earliest-known rather than
  // a mismatched live state. Best-effort per stream: a stream whose inner
  // has no checkout fetcher (a guest line, which has no token to fetch
  // at-version) stays live. Failures are swallowed so one stream cannot
  // break the doc-level preview.
  private async _checkoutOpenStreams(): Promise<void> {
    const seqs = this._checkoutStreamSeqs ?? {};
    for (const [name, openPromise] of this._streamOpens) {
      try {
        const stream = await openPromise;
        const lineId = this._streamManifest?.get(name)?.line_id;
        const seq = lineId !== undefined ? seqs[lineId] : undefined;
        await stream._previewAt(seq);
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
    this._checkoutGeneration += 1;
    if (this._checkout === null) return;
    const old = this._checkout;
    this._checkout = null;
    // Re-point the app's handles back at the live doc and redraw them,
    // symmetrically with the checkout path, so the model returns to the live
    // state in place.
    this._rebindRootHandles(this._doc);
    // Free the preview only after the rebind: `_rebindRootHandles` detaches
    // each subscriber against the preview container it was attached to, so
    // freeing first would be a use-after-free (see `_checkoutVersion`).
    if (old.previewDoc !== this._doc) {
      try {
        old.previewDoc.free();
      } catch {
        // ignore
      }
    }
    this._fireSubscribers({ kind: 'return-to-head' });
    this._maybeFireUndoState();
    // Return every opened stream to its live head too, symmetric with the
    // checkout path. Fire-and-forget (returnToHead is synchronous and has no
    // fetch): a stream not previewing is a no-op.
    this._checkoutStreamSeqs = null;
    for (const openPromise of this._streamOpens.values()) {
      void openPromise
        .then((stream) => stream._previewAt(undefined))
        .catch(() => {
          // A stream that failed to open has nothing to return.
        });
    }
  }

  // Re-point every cached root handle at the corresponding container in
  // `source` (the live doc or a checkout preview) and resync its subscribers.
  // The app holds these same handle objects, so this is what makes a version
  // checkout / return redraw the model without the app re-acquiring handles.
  // `getMap` / `getList` are get-or-create, so a container absent in the
  // preview resolves to an empty one and its subscribers redraw to empty.
  private _rebindRootHandles(source: LoroDoc): void {
    // Two passes, not one per handle: rebind every anchor to the new source
    // first, then resync. A composed handle can read a sibling root while
    // firing (the ordered map reads its order list during its map redraw), so
    // every anchor must already point at the new source before any handle
    // fires, or the redraw reads a half-swapped map/order pair.
    for (const entry of this._rootHandles.values()) {
      if (entry.kind === 'map') {
        rebindRootMapAnchor(entry.handle, source.getMap(entry.key));
      } else {
        rebindRootListAnchor(entry.handle, source.getList(entry.key));
      }
    }
    for (const entry of this._rootHandles.values()) {
      resyncRootHandle(entry.handle);
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

  // Publish this document's current state back to its drive source.
  // Lets an app code one line on save / on a commit button to make its
  // edits visible to people working outside Brass on the same source:
  //
  //   await doc.pushToDrive({ message: 'Wall move' });
  //
  // The platform publishes the doc's current state, overwriting the
  // source (unknown drive fields preserved), and marks its own write so
  // the inbound change-event drops it (no echo loop). It does not merge
  // concurrent drive-side edits. Throws on auth / link / write
  // failures; resolves with the new external ref and the published
  // entity count.
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
  // hosted resolution surface, so an app can offer pull (take the source)
  // / keep both alongside the publish-over that `pushToDrive` does:
  //
  //   if (doc.driveStatus?.state === 'diverged') await doc.resolveDrive();
  //
  // Unlike `pushToDrive`, the resolution can mint a NEW mirror doc that
  // takes over the drive link (take-source trashes this doc, keep-both
  // detaches it into a standalone fork). For a session-backed app the
  // SDK re-opens onto that new doc automatically (the resolver routes it
  // through the same `openSiblingDoc` path the history fork uses); the
  // returned `newDocId` lets a multi-doc app do its own switch. Resolves
  // with the outcome, or `null` when the user dismissed the dialog.
  // Throws when there is no doc identity or no resolver is attached.
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

  // Fetch the original file behind an opaque-blob document: a short-lived
  // presigned GET plus the file's name / content type / size. An app that
  // knows the format fetches the bytes from `url`, parses them, and writes
  // the structured content into this document through the normal handle
  // surface (`doc.map('instances').mutate(...)`):
  //
  //   const src = await doc.sourceBlob();
  //   const bytes = new Uint8Array(await (await fetch(src.url)).arrayBuffer());
  //   const records = parseMyFormat(bytes); // app's own parser
  //   doc.map('instances').mutate((m) => { for (const r of records) m[r.id] = r; });
  //
  // A source file is a set of one or more streams: `src.streams` lists
  // every stream (primary first, so a single-stream file has one entry),
  // each with its own URL, so a multi-stream format (a glTF with its
  // `.bin` buffer) fetches only the streams it needs.
  //
  // Rejects with a `BrassError` when the document is not a stored opaque
  // blob (it has no original file to hand back) or the caller cannot
  // reach it (both 404).
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
      // Only a CRDT stream opens as live collaborative state. Any other
      // value fails loudly here rather than joining a line that is not
      // one, so a format added after this SDK shipped is refused by the
      // version that cannot read it.
      if (info.format !== 'crdt') {
        throw new Error(
          `Stream "${name}" has format "${info.format}", which this ` +
            'SDK version cannot open as a live stream.',
        );
      }
      const inner = await runtime.openLine(info.line_id);
      const stream = new DocumentStream(name, inner, true);
      // Opened while a version preview is active: bring the new stream to
      // the same point in time rather than showing it live under a
      // historical default.
      if (this._checkout !== null) {
        await stream._previewAt(this._checkoutStreamSeqs?.[info.line_id]);
      }
      return stream;
    })();
    this._streamOpens.set(name, open);
    // A failed open (network, deleted stream) must not poison the cache:
    // drop it so the next call retries.
    open.catch(() => {
      if (this._streamOpens.get(name) === open) this._streamOpens.delete(name);
    });
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
    for (const open of this._streamOpens.values()) {
      void open.then((s) => s._close()).catch(() => {
        // A failed open has nothing to close.
      });
    }
    this._streamOpens.clear();
    this._streamManifest = null;
  }

  // Seal a deliberate checkpoint on this document's version-
  // history timeline. Compaction snapshots continue to appear as
  // no-action fallback markers, so an app that never calls this still
  // gets a usable history.
  //
  // Anchors to `doc.currentSeq` synchronously, so a concurrent
  // editor's op landing mid-call cannot shift the anchor. Pass an
  // explicit `version` to seal at a different point in history (the
  // server validates it's `<=` the branch's live head).
  async createCheckpoint(): Promise<DocumentCheckpoint> {
    return this._checkpoints.create();
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

  private _reportError(err: Error): void {
    if (this._errorReporter) this._errorReporter(err);
    else console.error('[Brass]', err);
  }

  // Fire all `subscribe` listeners with a synthetic event. Used for
  // metadata-only changes (checkout, return-to-head, branch switch,
  // branches list update, saving count change, commands change)
  // that don't originate from a Loro commit but still need the app
  // to re-read state. Apps typically ignore the event arg and just
  // call `toJSON()` in the handler; the discriminant is there for
  // the rare consumer that wants to branch on the reason.
  private _fireSubscribers(event: SyntheticSubscribeEvent): void {
    this._ensureLoroSubscribed();
    this._subs.emit(event);
  }

  // Saving indicator: number of locally-issued ops not yet acked by
  // the server. Reactive: `subscribe` fires when this count changes
  // (an op is sent or an `op_ack` lands). Apps bind directly inside
  // the subscribe handler:
  //
  //   doc.subscribe(() => {
  //     savingEl.textContent =
  //       doc.savingCount === 0 ? 'All changes saved'
  //                             : `Saving ${doc.savingCount} change${doc.savingCount === 1 ? '' : 's'}...`;
  //   });
  get savingCount(): number {
    return this._outstandingByClientId.size;
  }

  // Internal: forget an outstanding op once the server has acked it.
  // Returns true if the clientOpId was tracked (lets the caller detect
  // a stale ack).
  /** @internal */
  resolveOutstandingOp(clientOpId: string): boolean {
    const wasTracked = this._outstandingByClientId.delete(clientOpId);
    // Release this chunk from the resync-push loop guard once its op is
    // acked: the pushed op is now in the log, so the next handshake's
    // tail covers it and a fresh push is welcome (it would be a genuine
    // new hole, not a re-push of this one). The guard fully reopens only
    // once every chunk of the push has drained.
    this._resyncPushClientOpIds.delete(clientOpId);
    if (wasTracked) this._fireSubscribers({ kind: 'saving-count' });
    return wasTracked;
  }

  // Internal: forget an outstanding op the server TERMINALLY rejected (an
  // `op_rejected` frame: the op can never be accepted, e.g. it exceeded the
  // server's op-blob cap), as opposed to `resolveOutstandingOp`'s success. The
  // transport clears its resend timer; this drops the tracker entry so
  // `savingCount` stops counting a dead op, and surfaces the failure so the
  // app can react (the optimistic local commit stays applied but never
  // persists, so the app's cue is to reload). Returns true if it was tracked.
  /** @internal */
  _failOutstandingOp(clientOpId: string, message: string): boolean {
    const wasTracked = this._outstandingByClientId.delete(clientOpId);
    this._resyncPushClientOpIds.delete(clientOpId);
    if (wasTracked) {
      this._fireSubscribers({ kind: 'saving-count' });
      this._reportError(new Error(message));
    }
    return wasTracked;
  }

  private _ensureLocalUpdatesSubscribed(): void {
    if (this._unsubLocal) return;
    if (!this._localOpHook) return;
    // Loro's `subscribeLocalUpdates` fires after every local commit
    // with the op-blob bytes for that commit. Importing a remote op
    // does NOT trigger this callback, so we don't risk feeding the
    // same op back to the server in a loop.
    this._unsubLocal = this._doc.subscribeLocalUpdates((bytes: Uint8Array) => {
      const hook = this._localOpHook;
      if (!hook) return;
      // Copy: Loro reuses its internal buffer across callback calls in
      // some builds. Hand the consumer a stable view so the eventual
      // WS send sees the correct bytes regardless of when the send
      // actually flushes (the WS client may queue the frame).
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const clientOpId = hook(copy);
      this._outstandingByClientId.set(clientOpId, copy);
      // The local mutate has already fired `subscribe` (the Loro
      // event), but `savingCount` just incremented; fire one more
      // synthetic event so a subscribe handler bound on `savingCount`
      // sees the change.
      this._fireSubscribers({ kind: 'saving-count' });
    });
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
    this._unsubLoro = this._doc.subscribe((event) => {
      // One channel: every event reaches every subscriber, whatever
      // produced it. The app reconciles by value and reads the cause off
      // the event only when it has a non-render reason to.
      this._subs.emit(event);
      const isLocalCommit = (event as { by?: unknown }).by === 'local';
      this._maybeFireUndoState();
      // A local commit (mutate / undo / redo) schedules a debounced
      // thumbnail capture, when the app has registered a canvas via
      // `useCanvas`. Remote ops never trigger a capture: a viewer or
      // a passive collaborator must not re-upload a screenshot of
      // someone else's edit.
      if (isLocalCommit) {
        this._thumbnails.schedule();
        // Same reasoning for the implicit auto-checkpoint: only the
        // peer that made the edit seals the marker. Without this an
        // N-way session would write N redundant CHECKPOINT# rows per
        // idle period.
        this._checkpoints.scheduleAuto();
      }
    });
  }

  // Subscribe to document events. Returns an unsubscribe handle.
  // Lazy-attaches the underlying Loro subscriber on first call so
  // construction stays cheap.
  //
  // `cb` fires for EVERY change, whatever produced it: a local `mutate()`,
  // a remote `import`, `undo`, `redo`, `checkout`, and the SDK's synthetic
  // metadata events (saving-count, branches, commands). One channel; the
  // app re-reads / reconciles in the handler and branches on the event only
  // when it needs the cause. CRDT-origin events keep their Loro shape and
  // carry `by` / `origin` so the cause is recoverable; the engine-neutral
  // `origin.source` lives on the handle surface.
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
    this._ensureLoroSubscribed();
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
    if (this._undoStateSubs.size === 0) return;
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
  // Mutations after `_markGone` still mutate the local CRDT and call
  // the `LocalOpHook`, but the server will reject those op frames
  // (the SUB# row was evicted at fanout time); the SDK consumer
  // sees the rejection via the underlying transport's error channel.
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

  // The latest opaque work-status for this document, or `null` when no
  // slow server-side work is in flight. An app renders `message`
  // verbatim, draws a bar from `progress` when present, and shows a
  // waiting state while `pending`. When a freshly-opened drive-linked
  // doc is still hydrating, `open()` surfaces the initial `pending`
  // status here; subsequent phases arrive via `onStatus`.
  get status(): DocumentWorkStatus | null {
    return this._workStatus.status;
  }

  // Subscribe to opaque work-status updates. The callback fires on
  // every phase the server pushes; when `status.pending` flips to
  // `false` the work is terminal (a success the app reacts to by
  // re-opening the doc to load the now-available content, or a failure
  // whose `message` the app shows). Fires once on attach with the
  // current status when one is already known, so a late subscriber is
  // not stranded. Returns an unsubscribe.
  //
  // The app must not parse `message` or infer phases from it: the
  // server owns the wording and the lifecycle. This surface exists so
  // the app can *display* progress, not understand it.
  onStatus(cb: DocumentStatusListener): DocumentStatusUnsubscribe {
    // See `onGone`: guard the cross-session listener leak.
    this._assertOpen();
    return this._workStatus.on(cb);
  }

  // Internal: store the latest status and fire listeners. Not
  // one-shot: every phase re-emits. A terminal status (`pending:
  // false`) is retained so a late `onStatus` subscriber still sees the
  // final state.
  /** @internal */
  _emitStatus(status: DocumentWorkStatus): void {
    // A late reload/reconcile closure that resolved after `close()` must not
    // re-emit onto a torn-down doc (its undo stack is freed below in `close`).
    if (this._closed) return;
    this._workStatus.emit(status);
    // A blocking work-status is one of the inputs to `canUndo` / `canRedo`
    // (via `_isLoadLocked`), so a status that engages or releases the load
    // lock flips the undo/redo availability with no accompanying commit.
    // Refresh the undo-state notifier here so a subscribeUndoState-bound
    // button tracks the lock, not only CRDT edits.
    this._maybeFireUndoState();
  }

  // The current drive sync state of this document, or `null` when the
  // doc is not linked to a drive source. The read-side companion to
  // `doc.pushToDrive(...)`: an app reads `canPush` / `state` to decide
  // whether to surface a "Publish" affordance, and renders the
  // server-authored `label` / `detail` as the wording. Seeded on open
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
    this._gone.mark(reason);
  }

  // Plain-JS projection of the current state.
  toJSON(): Record<string, unknown> {
    // When in checkout, read from the preview LoroDoc so the app
    // renders the historical state. Returning to head clears
    // `_checkout` and reads go back to the live `_doc`.
    const source =
      this._checkout !== null ? this._checkout.previewDoc : this._doc;
    return source.toJSON() as Record<string, unknown>;
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
  /** @internal */
  maybeResyncPush(
    persistedSnapshotVersionVector: Uint8Array,
    durableTailBlobs: Uint8Array[],
  ): void {
    // `computeResyncPush` reads `this._doc.version()` / `export()`; refuse on a
    // closed (freed) doc so a late `doc_ops_dropped` / periodic-reverify
    // closure can't touch freed WASM.
    if (this._closed) return;
    // Loop guard: skip while any chunk of a prior push is still unacked,
    // so a flurry of reconnects cannot re-push the same missing slice.
    for (const id of this._resyncPushClientOpIds) {
      if (this._outstandingByClientId.has(id)) return;
    }
    const chunks = this.computeResyncPush(
      persistedSnapshotVersionVector,
      durableTailBlobs,
    );
    if (chunks === null) return;
    for (const chunk of chunks) {
      const id = this.injectLocalUpdate(chunk);
      if (id !== null) this._resyncPushClientOpIds.add(id);
    }
  }

  // Given the server's persisted snapshot version vector and the op
  // blobs the server is also serving on the join tail, decide whether
  // this client holds CRDT knowledge the durable server state lacks,
  // and if so return the update blob that fills exactly those holes.
  //
  // The durable frontier is the snapshot's version vector advanced by
  // every tail op the server delivered (those ops are durable in the
  // log even though no snapshot has absorbed them yet). Comparing the
  // local doc against the SNAPSHOT vector alone would falsely flag the
  // whole durable tail as missing and push it back on every join, which
  // then grows the log and loops; folding the tail in is what keeps the
  // handshake a no-op in the common "server already has everything"
  // case. `decodeImportBlobMeta` reads each blob's end vector from its
  // header without a full import, so this stays cheap.
  //
  // Returns the chunks to resync-push, or null when the durable state
  // already covers everything local holds (or a malformed vector / tail
  // blob, which degrades the handshake to a no-op and warns rather than
  // throwing out of the frame handler that drives the live transport).
  //
  // The common case is one chunk: an `update` export from the durable
  // frontier carries only the missing ops plus their dependencies, never
  // the whole history, and a realistic gap is far under the per-frame
  // cap. When the missing slice exceeds the cap (a BIM-sized edit set:
  // a geometry import or bulk parametric change discarded then healed, or
  // a large offline divergence on reconnect), it is split into multiple
  // chunks via `updates-in-range` spans, each under the cap, so even a
  // large divergence heals instead of being skipped. Import is idempotent
  // and order-independent (Loro buffers a chunk whose dependency is in a
  // sibling chunk until it arrives), so the chunks need no ordering.
  /** @internal */
  computeResyncPush(
    persistedSnapshotVersionVector: Uint8Array,
    durableTailBlobs: Uint8Array[],
  ): Uint8Array[] | null {
    let durable: VersionVector;
    try {
      durable = VersionVector.decode(persistedSnapshotVersionVector);
      for (const blob of durableTailBlobs) {
        const meta = decodeImportBlobMeta(blob, false);
        durable = mergeVersionVectors(durable, meta.partialEndVersionVector);
      }
    } catch (err) {
      console.warn(
        '[Brass] durability handshake skipped: could not decode the persisted version vector or a tail op blob',
        err,
      );
      return null;
    }
    const local = this._doc.version();
    const cmp = local.compare(durable);
    // `compare` returns -1/0 when local is at or behind the durable
    // frontier (nothing to push), 1 when local is strictly ahead, and
    // undefined when the two are concurrent (local holds ops the server
    // lacks AND vice versa). Push in the ahead and concurrent cases; the
    // export from `durable` carries only the local-only ops either way.
    if (cmp !== undefined && cmp <= 0) return null;
    // Common case: the whole missing slice fits in one frame. Keep this
    // path byte-identical to a plain `update` export so the no-chunking
    // case is unchanged.
    const full = this._doc.export({ mode: 'update', from: durable });
    if (full.byteLength <= RESYNC_PUSH_MAX_BYTES) return [full];
    // Large divergence: split the per-peer missing ranges into chunks.
    return this.chunkMissingSlice(local, durable);
  }

  // The per-peer ranges local holds beyond `durable`, as half-open
  // [from, to) counter ranges. `export({ mode: 'update', from })` covers
  // exactly these ops; we re-express them as `updates-in-range` spans so
  // they can be split.
  private missingRanges(
    local: VersionVector,
    durable: VersionVector,
  ): { peer: PeerID; from: number; to: number }[] {
    const durableMap = durable.toJSON();
    const ranges: { peer: PeerID; from: number; to: number }[] = [];
    for (const [peer, to] of local.toJSON()) {
      const from = durableMap.get(peer) ?? 0;
      if (to > from) ranges.push({ peer, from, to });
    }
    return ranges;
  }

  // Recursively export the given ranges as one `updates-in-range` blob,
  // splitting by op count until each blob is under the per-frame cap. An
  // irreducible single op (one that alone exceeds the cap) is emitted up
  // to the hard ceiling, or skipped with a warning beyond it so the loop
  // never wedges on an un-sendable frame.
  private chunkMissingSlice(
    local: VersionVector,
    durable: VersionVector,
  ): Uint8Array[] {
    const pack = (
      ranges: { peer: PeerID; from: number; to: number }[],
    ): Uint8Array[] => {
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
        console.warn(
          `[Brass] durability resync skipped one op of ${blob.byteLength} bytes, over the ${RESYNC_PUSH_HARD_MAX_BYTES}-byte single-frame ceiling. The rest of the slice still heals; this op heals on a future snapshot-based recovery.`,
        );
        return [];
      }
      const [first, second] = splitRangesByLength(ranges, total);
      return [...pack(first), ...pack(second)];
    };
    return pack(this.missingRanges(local, durable));
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
    const hook = this._localOpHook;
    if (!hook) return null;
    const copy = new Uint8Array(blob.byteLength);
    copy.set(blob);
    const clientOpId = hook(copy);
    this._outstandingByClientId.set(clientOpId, copy);
    this._fireSubscribers({ kind: 'saving-count' });
    return clientOpId;
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
    // A pending auto-checkpoint would otherwise fire against a parked
    // Document and silently no-op via the scheduler's guard.
    // Cancelling here keeps the timer count clean across long-lived
    // caches and avoids the no-op fetch flush.
    this._checkpoints.cancelAuto();
    this._subs.clear();
    this._undoStateSubs.clear();
    this._gone.clearListeners();
    this._workStatus.clearListeners();
    this._driveStatus.clearListeners();
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
    for (const entry of this._rootHandles.values()) {
      teardownRootHandle(entry.handle);
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

  close(): void {
    if (this._closed) return;
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
    this._thumbnails.cancel();
    this._checkpoints.cancelAuto();
    this._localOpHook = null;
    this._currentSeqProvider = null;
    this._outstandingByClientId.clear();
    this._resyncPushClientOpIds.clear();
    this._subs.clear();
    this._undoStateSubs.clear();
    // Drop the signal listeners too, mirroring `_suspend()`. Their frames
    // can no longer fire once the transport is torn down, but clearing
    // them keeps `close()` from retaining an app's callbacks (and the
    // closures they hold) for the Document's remaining lifetime.
    this._gone.clearListeners();
    this._workStatus.clearListeners();
    this._driveStatus.clearListeners();
    // Detach handle subscriptions before freeing the doc (below): a handle's
    // per-container Loro subscription outlives the cache reference, and
    // `_doc.free()` must not run with subscriptions still attached.
    for (const entry of this._rootHandles.values()) {
      teardownRootHandle(entry.handle);
    }
    this._rootHandles.clear();
    this._orderedMapHandles.clear();
    // Free a live historical-checkout preview: it is a distinct LoroDoc
    // (allocated by `_checkoutVersion`), so closing while previewing without a
    // prior `returnToHead()` would otherwise leak its WASM heap. The guard
    // mirrors `_checkoutVersion` / `returnToHead`: the frozen cold-link case
    // has `previewDoc === _doc`, where `_doc.free()` below already covers it
    // and an unguarded free would double-free.
    if (this._checkout && this._checkout.previewDoc !== this._doc) {
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
    this._doc.free();
  }
}
