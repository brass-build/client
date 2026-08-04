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
} from './documents.js';
import type { DocumentStreamInfo } from './documents-namespace.js';
import type { ListHandle, MapHandle, OrderedMapHandle } from './handles.js';

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
  ): void {
    this._inner.mutate<E>(fn);
  }

  toJSON(): Record<string, unknown> {
    return this._inner.toJSON();
  }

  subscribe(cb: DocumentSubscriber): DocumentUnsubscribe {
    return this._inner.subscribe(cb);
  }

  // Per-stream undo/redo: each stream keeps its own local-edit stack
  // (its edits are its own CRDT commits). The doc-level `doc.undo()`
  // covers only the default stream.
  undo(): boolean {
    return this._inner.undo();
  }

  redo(): boolean {
    return this._inner.redo();
  }

  // Seal the stream's open undo group, so the next local edit starts a
  // fresh undo step. Local and synchronous (no server call). Call it
  // when a user operation completes: commits group into one step until
  // sealed (the same same-stroke collapsing the doc-level undo has), so
  // an app that never seals gets one giant step per session. The
  // cross-stream operation recipe in `docs/streams.md` is built on this.
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
   * to its live head when `seq` is undefined. Driven by the parent
   * Document's version preview so a partitioned document previews
   * consistently across streams. A no-op when the inner has no checkout
   * fetcher (a guest line, which holds no token to fetch at-version), so
   * such a stream stays live. */
  async _previewAt(seq: number | undefined): Promise<void> {
    const inner = this._inner;
    if (seq !== undefined && inner._hasCheckoutFetcher()) {
      await inner._checkoutVersion(seq);
    } else if (inner._isCheckedOut()) {
      inner.returnToHead();
    }
  }

  /** @internal Close the stream's own transport + state. Called by the
   * parent Document's close; a no-op for the default stream, whose inner
   * is the parent itself. */
  _close(): void {
    if (this._ownsInner) this._inner.close();
  }
}
