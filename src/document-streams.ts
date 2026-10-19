// Per-stream scope of a Document. A document is a container of streams:
// named, independently-loadable CRDT units. `doc.stream(name)` resolves
// one and returns this wrapper; only the streams an app touches are
// downloaded, imported, and subscribed, so open cost scales with use,
// not with the whole document.
//
// Each non-default stream is backed by its own internal Document wired
// to the stream's line (its own snapshot + op channel); the wrapper
// exposes the per-stream subset of the Document surface. The `default`
// stream wraps the parent Document itself, so `doc.stream('default')`
// and the doc-level handles read the same state.

import type {
  Document,
  DocumentMutator,
  DocumentSubscriber,
  DocumentUnsubscribe,
  EntityProxy,
  RootKind,
} from './documents.js';
import type { DocumentStreamInfo } from './documents-namespace.js';
import type {
  DocumentGoneListener,
  DocumentGoneUnsubscribe,
  DocumentStatusListener,
  DocumentStatusUnsubscribe,
  DocumentWorkStatus,
} from './document-signals.js';
import type { InputStatus } from './inputs-status.js';
import type { InputDocumentHandlers, InputDocumentOptions } from './input-documents.js';
import type {
  ListHandle,
  MapHandle,
  MutateOptions,
  OrderedMapHandle,
  TextHandle,
} from './handle-types.js';
import type { InputReference } from './hosted-ui.js';
import type { MarkReadOptions, MarkReadStatus } from './references.js';

// The wiring `Document.stream()` runs on: list/create manifests over
// HTTP, and open a stream's line (join + WS subscribe) returning the
// internal Document that holds its state. Installed by the SDK open
// factory; absent on offline / test docs, where stream methods throw
// with a clear message.
export interface StreamRuntime {
  list(): Promise<DocumentStreamInfo[]>;
  create(name: string): Promise<DocumentStreamInfo>;
  openLine(lineId: string): Promise<Document>;
}

export class DocumentStream {
  // The stream's name within the document ('default' for the document's
  // own default state).
  readonly name: string;
  /** @internal The Document holding this stream's state. For a
   *  non-default stream that is its own line's Document; for `default` it
   *  is the parent itself, which is why `_ownsInner` gates the close. */
  readonly _inner: Document;
  // True when this wrapper owns its inner Document (a non-default
  // stream): closing the parent closes it. The default stream's inner IS
  // the parent, which owns its own lifecycle.
  private readonly _ownsInner: boolean;

  /** @internal */
  constructor(name: string, inner: Document, ownsInner: boolean) {
    this.name = name;
    this._inner = inner;
    this._ownsInner = ownsInner;
  }

  // Typed container handles, scoped to this stream. Same surface and
  // semantics as the doc-level `doc.map` / `doc.list` / `doc.orderedMap`.
  map<T = unknown>(key: string): MapHandle<T> {
    return this._inner.map<T>(key);
  }

  list<T = unknown>(key: string): ListHandle<T> {
    return this._inner.list<T>(key);
  }

  orderedMap<T = unknown>(mapKey: string, orderKey: string): OrderedMapHandle<T> {
    return this._inner.orderedMap<T>(mapKey, orderKey);
  }

  mutate<E extends object = EntityProxy>(
    fn: (d: DocumentMutator<E>) => void,
    options?: MutateOptions,
  ): void {
    this._inner.mutate<E>(fn, options);
  }

  /** Records the documents `key` depends on for this stream; see
   *  `Document.dependsOn`. A reference to any stream of this document is
   *  refused. */
  dependsOn(key: string, refs: readonly InputReference[] | null): void {
    this._inner.dependsOn(key, refs);
  }

  /** @internal Records what this reader read for the key `status` reports
   *  on this stream; see `Document.markRead`. */
  markRead(status: MarkReadStatus, options?: MarkReadOptions): void {
    this._inner.markRead(status, options);
  }

  roots(): Record<string, RootKind> {
    return this._inner.roots();
  }

  text(key: string): TextHandle {
    return this._inner.text(key);
  }

  toJSON(): Record<string, unknown> {
    return this._inner.toJSON();
  }

  subscribe(cb: DocumentSubscriber): DocumentUnsubscribe {
    return this._inner.subscribe(cb);
  }

  // Whether this stream's writes are landing, which is a property of its own
  // line: its snapshot carries its own capacity verdict, its ops are its own,
  // and its own grant decides whether it takes writes. `subscribe` fires when
  // `savingCount` or `atCapacity` moves, as it does on the document.

  // True when this stream refuses local writes: `mutate` throws and edit
  // affordances should be disabled.
  get readOnly(): boolean {
    return this._inner.readOnly;
  }

  /** @internal This stream's line's `updated_at` as it was opened; see
   *  `Document.updatedAt`. */
  get updatedAt(): string | null {
    return this._inner.updatedAt;
  }

  // Locally-issued ops on this stream the server has not acked yet. This
  // stream's own line: `doc.savingCount` is the one that adds the streams up,
  // and the default stream's inner IS the document, so reading that here would
  // report every other stream's writes as this one's.
  get savingCount(): number {
    return this._inner._ownSavingCount;
  }

  // True when this stream has stopped accepting changes because it reached the
  // largest size the platform can keep. The ceiling is per stream, so a
  // document can hold one full stream and keep taking writes on the rest.
  get atCapacity(): boolean {
    return this._inner.atCapacity;
  }

  /**
   * The work in flight on this stream, or `null` when there is none. Render
   * `message` verbatim.
   */
  get status(): DocumentWorkStatus | null {
    return this._inner.status;
  }

  /**
   * Calls `cb` with every work-status update for this stream, and once on
   * attach when a status is already known. Returns an unsubscribe.
   */
  onStatus(cb: DocumentStatusListener): DocumentStatusUnsubscribe {
    return this._inner.onStatus(cb);
  }

  // Fires once when the server reports this stream's state evicted. A late
  // listener fires on registration if the eviction already happened.
  onGone(cb: DocumentGoneListener): DocumentGoneUnsubscribe {
    return this._inner.onGone(cb);
  }

  /** @internal On a frozen copy: whether this stream has moved since it was
   *  read. Each stream is its own line, so each is watched on its own. */
  get changed(): false {
    return this._inner.changed;
  }

  /** @internal */
  onChanged(cb: () => void): () => void {
    return this._inner.onChanged(cb);
  }

  /** @internal Typed on `ReadOnlyStream`: loads this stream as it stands now
   *  on a frozen copy. */
  reload(): Promise<void> {
    return this._inner.reload();
  }

  /** The input files of a key this stream records references under;
   *  see `Document.subscribeInputDocuments`. A stream's keys are its own,
   *  apart from the document's and every other stream's. */
  subscribeInputDocuments(
    key: string,
    handlers: InputDocumentHandlers,
    options?: InputDocumentOptions,
  ): () => void {
    return this._inner.subscribeInputDocuments(key, handlers, options);
  }

  /** @internal The status of a key this stream records references under. */
  subscribeInputStatus(key: string, cb: (status: InputStatus) => void): () => void {
    return this._inner.subscribeInputStatus(key, cb);
  }

  /**
   * Reverts this stream's part of the newest undo step that touched it,
   * leaving the document's other streams as they are.
   * @deprecated Call `doc.undo()`, which reverts the newest step in every
   * stream it touched.
   */
  undo(): boolean {
    return this._inner._replayOwnUndoStep('undo');
  }

  /**
   * Re-applies this stream's part of the step it most recently undid.
   * @deprecated Call `doc.redo()`.
   */
  redo(): boolean {
    return this._inner._replayOwnUndoStep('redo');
  }

  /**
   * Ends the document's open undo step, so the next local edit in any stream
   * starts a new one.
   * @deprecated Call `doc.createCheckpoint()` at the end of each user action,
   * which also ends the step.
   */
  sealUndoStep(): void {
    this._inner._sealUndoStep();
  }

  /** @internal The stream's live head seq (advanced by its own op channel),
   *  or `null` before the transport resolves it. Internal for the same
   *  reason the document's is, and a stream has even less use for one: it
   *  carries no checkpoint machinery to anchor. */
  get currentSeq(): number | null {
    return this._inner.currentSeq;
  }

  /** @internal Preview this stream at a historical line seq, or return it
   * to its live head. Driven by the parent Document's version preview so a
   * partitioned document previews consistently across streams.
   * `parentPreviewing` says which of the two a `seq`-less call means: the
   * parent stepping into a version that records nothing for this line, or the
   * parent returning to its head. A no-op when the inner has no checkout
   * fetcher (a guest line, which holds no token to fetch at-version), so such
   * a stream stays live; a guest line refuses writes anyway. */
  async _previewAt(seq: number | undefined, parentPreviewing = false): Promise<void> {
    const inner = this._inner;
    if (seq !== undefined && inner._hasCheckoutFetcher()) {
      await inner._checkoutVersion(seq);
      return;
    }
    if (seq === undefined && parentPreviewing) {
      // The preview's checkpoint records no seq for this line, because the
      // stream did not exist when it was taken. There is no historical state
      // this stream can honestly show, and returning it to its head shows two
      // moments at once: the document's past beside this stream's present.
      // Worse, it would leave the stream taking writes while the document
      // reports read-only, and those writes land on the live head and outlive
      // the preview. Hold it read-only for as long as the parent is browsing.
      inner._setVersionBrowsing(true);
      return;
    }
    inner._setVersionBrowsing(false);
    // Returned whether or not a preview has LANDED on this line, because a
    // checkout of it can be in flight and unapplied, and the return is what
    // supersedes that fetch (it bumps the line's own generation before it
    // looks at anything). Asking whether the line is checked out first is
    // what lets an in-flight one land after the reader has already gone back
    // to the head, leaving the stream showing a moment the document left.
    // Throws on a line with no live head of its own, which the callers
    // treat the same as any other per-stream failure.
    inner.returnToHead();
  }

  /** @internal Close the stream's own transport + state. Called by the
   * parent Document's close; a no-op for the default stream, whose inner
   * is the parent itself. */
  _close(): void {
    if (this._ownsInner) this._inner.close();
  }

  /** @internal Park the stream's own state alongside the parent's park, so a
   * stream an app holds across `doc.close()` stops calling it back and refuses
   * writes the way the parent does. A no-op for the default stream, whose
   * inner is the parent and is already parking. */
  _suspend(): void {
    if (this._ownsInner) this._inner._suspend();
  }

  /** @internal Pair of `_suspend`, run when the parent resumes. */
  _resume(): void {
    if (this._ownsInner) this._inner._resume();
  }
}
