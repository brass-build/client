// The document types an open that cannot write returns, so writing through
// one is a type error rather than a thrown `mutate`.

import type {
  ListHandle,
  MapHandle,
  OrderedMapHandle,
  TextHandle,
} from './handle-types.js';
import type { OpenDocumentByIdOptions, OpenedDocument } from './open-document.js';
import type { DocumentUnsubscribe } from './documents.js';
import type { DocumentStream } from './document-streams.js';

/** A map on a `ReadOnlyDocument`: the reads of `MapHandle`, and no writes. */
export type ReadOnlyMapHandle<T = unknown> = Omit<MapHandle<T>, 'mutate' | 'map' | 'list'> & {
  map<U = unknown>(entryKey: string): ReadOnlyMapHandle<U>;
  list<U = unknown>(entryKey: string): ReadOnlyListHandle<U>;
};

/** A list on a `ReadOnlyDocument`: the reads of `ListHandle`, and no writes. */
export type ReadOnlyListHandle<T = unknown> = Omit<ListHandle<T>, 'mutate'>;

/** An ordered map on a `ReadOnlyDocument`, with no writes. */
export type ReadOnlyOrderedMapHandle<T = unknown> = Omit<
  OrderedMapHandle<T>,
  'mutate' | 'insert' | 'move' | 'ordered'
>;

/** A text on a `ReadOnlyDocument`, with no writes. */
export type ReadOnlyTextHandle = Omit<TextHandle, 'update'>;

/** Members of a document that write to it. */
type WritingMembers =
  | 'mutate'
  | 'undo'
  | 'redo'
  | 'createCheckpoint'
  | 'setAutoCheckpointIntervalMs'
  | 'getOrCreateStream'
  | 'stream'
  | 'useCanvas'
  | 'map'
  | 'list'
  | 'text'
  | 'orderedMap'
  | 'dependsOn'
  | 'markRead';

/** Members that report writing, which a copy that cannot write never does. */
type WriterStateMembers = 'savingCount' | 'subscribeUndoState';

/** Members of a stream that write to it. */
type WritingStreamMembers =
  | 'mutate'
  | 'undo'
  | 'redo'
  | 'sealUndoStep'
  | 'map'
  | 'list'
  | 'text'
  | 'orderedMap'
  | 'dependsOn'
  | 'markRead';

/** Members whose meaning the update mode decides. */
type UpdateModeMembers = 'changed' | 'onChanged' | 'reload';

/** One stream of a `ReadOnlyDocument`. */
export type ReadOnlyStream = Omit<
  DocumentStream,
  WritingStreamMembers | 'savingCount' | UpdateModeMembers
> & {
  /** On a frozen copy, called when this stream moves past what it last
   *  loaded, at once if it already has. Each stream is its own line, so each
   *  is watched on its own. */
  onChanged(cb: () => void): DocumentUnsubscribe;
  reload(): Promise<void>;
  map<T = unknown>(key: string): ReadOnlyMapHandle<T>;
  list<T = unknown>(key: string): ReadOnlyListHandle<T>;
  text(key: string): ReadOnlyTextHandle;
  orderedMap<T = unknown>(mapKey: string, orderKey: string): ReadOnlyOrderedMapHandle<T>;
};

/**
 * A document opened with `readOnly: true` or `frozen: true`, with nothing on
 * it that writes. A document the signed-in person may only view opens
 * read-only whatever was asked, which `doc.readOnly` reports and a refused
 * `mutate` throws on.
 *
 * A live copy follows every change as it is made. A frozen copy keeps what it
 * loaded: `onChanged` reports the document moving past it, and `reload()`
 * loads the document as it stands, under the same handles, whose subscribers
 * are told what changed.
 */
export type ReadOnlyDocument = Omit<
  OpenedDocument,
  WritingMembers | WriterStateMembers | UpdateModeMembers
> & {
  readonly readOnly: true;
  /** On a frozen copy, called when the document moves past what this copy
   *  last loaded (a content edit, an import landing or failing, the document
   *  being deleted), at once if it already has. Called once per load. A live
   *  copy never calls it. */
  onChanged(cb: () => void): DocumentUnsubscribe;
  /** On a frozen copy, loads the document as it stands now. A live copy
   *  already holds it, so this resolves at once. */
  reload(): Promise<void>;
  map<T = unknown>(key: string): ReadOnlyMapHandle<T>;
  list<T = unknown>(key: string): ReadOnlyListHandle<T>;
  text(key: string): ReadOnlyTextHandle;
  orderedMap<T = unknown>(mapKey: string, orderKey: string): ReadOnlyOrderedMapHandle<T>;
  stream(name: string): Promise<ReadOnlyStream>;
};

/** The modes an open or a reopen can ask for. A frozen copy is read-only, so
 *  `frozen: true` takes no `readOnly: false`. */
export type OpenModeOptions =
  | { frozen?: false; readOnly?: boolean }
  | { frozen: boolean; readOnly?: true };

/** `Brass.openDocumentById`, typed by what the open asks for. */
export interface OpenDocumentById {
  (
    docId: string,
    options: OpenDocumentByIdOptions & { frozen: true; readOnly?: true },
  ): Promise<ReadOnlyDocument>;
  (docId: string, options: OpenDocumentByIdOptions & { readOnly: true }): Promise<ReadOnlyDocument>;
  (docId: string, options?: OpenDocumentByIdOptions & { frozen?: false }): Promise<OpenedDocument>;
  (
    docId: string,
    options: Omit<OpenDocumentByIdOptions, 'frozen' | 'readOnly'> & OpenModeOptions,
  ): Promise<OpenedDocument | ReadOnlyDocument>;
}
