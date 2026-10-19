// The SDK's side of a document's references and read marks: the root names
// it keeps from apps, the mark that acknowledges a removed input, and the
// provisional post that follows an acknowledged change. The shapes and write
// rules are the platform contract's, through the SDK's copy in `inputs.ts`.

import {
  inputReadMarkAfter,
  isInputLineId,
  parseInputReadEntryKey,
  type InputReadMark,
  type InputsKeyState,
  type ProvisionalInputsAnswer,
  type ProvisionalInputsPost,
} from './inputs.js';

/**
 * Root names the platform keeps for itself, the two input roots among them.
 * They are refused as names an app passes to `doc.map` / `doc.list` /
 * `doc.text`, and every app-visible enumeration of a document's roots leaves
 * them out.
 */
const RESERVED_ROOT_PREFIX = '__brass_';

export function isReservedRootName(name: string): boolean {
  return name.startsWith(RESERVED_ROOT_PREFIX);
}

/**
 * @internal
 * Posts a provisional body. Resolves the platform's answer, or null without
 * one. `superseded` turns true once a later post for the same key has been
 * sent (or the document closed), which ends any retry of this one.
 */
export type ProvisionalInputsPoster = (
  post: ProvisionalInputsPost,
  opts?: { superseded?: () => boolean },
) => Promise<ProvisionalInputsAnswer | null>;

interface PendingPost {
  key: string;
  lineId: string;
  state: InputsKeyState;
  awaiting: Set<string>;
  seq: number;
}

/**
 * @internal
 * Posts each key's provisional entry once every op carrying its latest change
 * is acknowledged with a seq. A later change to a key replaces the post an
 * earlier one was waiting to make, and a refused op cancels the post it
 * carried. A post's outcome never reaches the document: the platform
 * projects the key from the document itself either way.
 */
export class ProvisionalInputsTracker {
  private _poster: ProvisionalInputsPoster | null = null;
  private _onAnswer: ((answer: ProvisionalInputsAnswer) => void) | null = null;
  // One commit can change several keys, so one op can carry several posts.
  private readonly _byOp = new Map<string, Set<PendingPost>>();
  private readonly _byKey = new Map<string, PendingPost>();
  // The post each key last sent, which a retry of an earlier one defers to.
  private readonly _sent = new Map<string, ProvisionalInputsPost>();

  setPoster(poster: ProvisionalInputsPoster | null): void {
    this._poster = poster;
  }

  /** Hears each answer a post receives: the key's row revision after it. */
  onAnswer(listener: ((answer: ProvisionalInputsAnswer) => void) | null): void {
    this._onAnswer = listener;
  }

  /** Wait for the ops a commit shipped, then post `state` for `key`. */
  register(key: string, lineId: string | null, state: InputsKeyState, clientOpIds: readonly string[]): void {
    if (this._poster === null || !isInputLineId(lineId) || clientOpIds.length === 0) return;
    this._drop(this._byKey.get(key));
    const pending: PendingPost = { key, lineId, state, awaiting: new Set(clientOpIds), seq: 0 };
    this._byKey.set(key, pending);
    for (const id of clientOpIds) {
      const posts = this._byOp.get(id) ?? new Set<PendingPost>();
      posts.add(pending);
      this._byOp.set(id, posts);
    }
  }

  acked(clientOpId: string, seq: number | undefined): void {
    const posts = this._byOp.get(clientOpId);
    if (posts === undefined) return;
    this._byOp.delete(clientOpId);
    for (const pending of posts) this._ackedFor(pending, clientOpId, seq);
  }

  private _ackedFor(pending: PendingPost, clientOpId: string, seq: number | undefined): void {
    if (seq === undefined) {
      this._drop(pending);
      return;
    }
    pending.awaiting.delete(clientOpId);
    pending.seq = Math.max(pending.seq, seq);
    if (pending.awaiting.size > 0) return;
    this._drop(pending);
    const poster = this._poster;
    if (poster === null || pending.seq < 1) return;
    const post: ProvisionalInputsPost = {
      key: pending.key,
      body: {
        branch_id: pending.lineId,
        op_seq: pending.seq,
        refs: pending.state.refs,
        read: pending.state.read,
      },
    };
    this._sent.set(post.key, post);
    const superseded = (): boolean => this._sent.get(post.key) !== post;
    try {
      void poster(post, { superseded })
        .then((answer) => {
          if (!superseded()) this._sent.delete(post.key);
          if (answer !== null && answer.key === post.key) this._onAnswer?.(answer);
        })
        .catch(() => undefined);
    } catch {
      // The post is best-effort; the document already holds the change.
    }
  }

  failed(clientOpId: string): void {
    for (const pending of this._byOp.get(clientOpId) ?? []) this._drop(pending);
  }

  clear(): void {
    this._byOp.clear();
    this._byKey.clear();
    this._sent.clear();
  }

  private _drop(pending: PendingPost | undefined): void {
    if (pending === undefined) return;
    for (const id of pending.awaiting) {
      const posts = this._byOp.get(id);
      posts?.delete(pending);
      if (posts?.size === 0) this._byOp.delete(id);
    }
    pending.awaiting.clear();
    if (this._byKey.get(pending.key) === pending) this._byKey.delete(pending.key);
  }
}

/** @internal The latest mark this copy holds for `docId` under `key`, or null. */
export function latestReadMark(
  readRoot: Readonly<Record<string, unknown>>,
  key: string,
  docId: string,
): InputReadMark | null {
  let latest: InputReadMark | null = null;
  for (const [entryKey, value] of Object.entries(readRoot)) {
    if (value !== true) continue;
    const parsed = parseInputReadEntryKey(entryKey);
    if (parsed?.key !== key || parsed.docId !== docId) continue;
    if (latest === null || inputReadMarkAfter(parsed.mark, latest)) latest = parsed.mark;
  }
  return latest;
}

/** The part of an input status `markRead` reads. */
export interface MarkReadStatus {
  readonly key: string;
  readonly changed: ReadonlyArray<{
    readonly doc_id: string;
    readonly change: string;
    readonly updated_at?: string;
  }>;
  /** Each input at the version the status reports. An input `markRead`
   *  records from the status is recorded at this version. */
  readonly inputs?: ReadonlyArray<{ readonly doc_id: string; readonly updated_at: string }>;
}

/** A document `markRead` records as read: a copy this app opened, recorded at
 *  the `updatedAt` it was opened at. */
export interface MarkReadHandle {
  readonly id: string | null;
  readonly updatedAt: string | null;
  readonly status: { readonly pending: boolean } | null;
}

/** A file `markRead` records as read from the status that reported it: an
 *  entry of its `files` or `changed`, recorded at the version the status
 *  reports. */
export interface MarkReadEntry {
  readonly doc_id: string;
}

/** What `markRead` records, and whether it joins the Undo step. */
export interface MarkReadOptions {
  /** The files to record. Defaults to every file the status lists as added
   *  or modified. */
  readonly files?: ReadonlyArray<MarkReadHandle | MarkReadEntry>;
  /** `false` keeps the marks off the Undo stack. Defaults to `true`. */
  readonly undoable?: boolean;
}

/** @internal One queued reference write: applies itself and names the key it
 *  changed, or null when it changed nothing. */
export interface InputsWrite {
  undoable: boolean;
  apply: () => string | null;
}
