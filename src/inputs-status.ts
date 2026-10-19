// The status a document reports for the keys it records references under:
// fetched from the platform, kept current by the nudges its topic carries,
// and laid over what the document's own reserved roots hold, so a local
// change to the references or the read marks (an edit, an Undo, a Redo)
// shows at once rather than after the platform has projected it.

import {
  applyInputStatusDelta,
  decodeInputsRoots,
  inputReadMarkAfter,
  inputReferenceId,
  inputStampFromUpdatedAt,
  parseInputStatusDelta,
  parseInputStatusPage,
  INPUT_STATUS_CURSOR_PARAM,
  INPUT_STATUS_LINE_PARAM,
  INPUT_STATUS_SINCE_PARAM,
  type InputFileChange,
  type InputReadMark,
  type InputReferenceWire as WireReference,
  type InputsKeyState,
  type InputStatusWire as WireStatus,
  type InputStatusChangeWire as WireChange,
} from './inputs.js';
import type { InputReference } from './hosted-ui.js';

export type { InputFileChange, InputReference };

/** One input document as it is now. */
export interface InputStatusDocument {
  doc_id: string;
  name: string;
  /** The document's family, absent on a document that has none. */
  family?: string;
  updated_at: string;
  /** The key's references that include this input, nearest first. */
  from: InputReference[];
  /** @internal Present while the app that imports the file has not. */
  awaits_import?: true;
}

/** @internal One input the document has not read at its current version. */
export interface InputStatusChange {
  doc_id: string;
  change: InputFileChange;
  /** The key's references that include the file, nearest first. Empty for a
   *  removed file no reference includes any more. */
  from: InputReference[];
  /** On a removed file, the version it left the key at. */
  updated_at?: string;
}

/** One key's status, as `subscribeInputDocuments` hands it to `status`. */
export interface InputStatus {
  key: string;
  /** The references recorded under the key. Pass them back to
   *  `Brass.chooseInputs` as `selected`. */
  refs: InputReference[];
  /** The inputs this reader can open. */
  inputs: InputStatusDocument[];
  /** @internal */
  changed: InputStatusChange[];
  /** Inputs this document has read before that this reader can no longer
   *  open. */
  hidden_count: number;
  /** True when the document's keys together reach more inputs than a
   *  document tracks, so some inputs are left out. */
  truncated: boolean;
  /** False while the list of inputs may not be complete. Through
   *  `subscribeInputDocuments`, also false until every handler call has
   *  finished and the set has stopped changing. A result
   *  computed over every input belongs on a status that reads true. */
  settled: boolean;
}

/**
 * How a document reaches the status routes. Each answers the body the server
 * sent, or null for a 404.
 */
export interface InputsStatusRuntime {
  readKey(key: string, query: Record<string, string>): Promise<unknown>;
  /** Set when the document cannot record references: what `dependsOn`
   *  throws when it is given any. */
  refusesReferences?: string;
  /** Opens an input file, as `Brass.openDocumentById` does. */
  open?: (docId: string, options?: import('./open-document.js').OpenDocumentByIdOptions) =>
    Promise<import('./open-document.js').OpenedDocument>;
}

/**
 * @internal The runtime of a document created while signed out: every key reads as one
 * with no references and no files. The sign-in that keeps the document returns
 * to a new page load, which opens it by id with the status routes.
 */
export const TEMPORARY_INPUTS_RUNTIME: InputsStatusRuntime = {
  readKey: () => Promise.resolve(null),
  refusesReferences: 'Sign in to keep your work before choosing the files it depends on.',
};

/** The plain values of the document's two reserved roots. */
export interface InputsLocalRoots {
  refs: unknown;
  read: unknown;
}

/** What a hub needs from the document it serves. */
export interface InputStatusHost {
  runtime: InputsStatusRuntime;
  /** The line the document holds, named on every request. */
  lineId(): string | null;
  /** The reserved roots as the document holds them, or null for a document
   *  with no engine (a frozen copy), which reports the platform's status. */
  localRoots(): InputsLocalRoots | null;
  /** Calls `cb` synchronously whenever either reserved root changes. */
  watchLocalRoots(cb: () => void): () => void;
}

/** How many times a paged read restarts when the status moves under it. */
const FULL_READ_ATTEMPTS = 3;

/** The wait before re-reading after a failed read, doubling to a ceiling. */
const RETRY_FIRST_MS = 1_000;
const RETRY_CEILING_MS = 30_000;

type Listener<S> = (status: S) => void;

// A changed entry the platform reported, with the read mark the document held
// for it when the report arrived. Once the platform stops reporting an entry
// the document's own mark acknowledged, the entry is kept with that mark
// (`ackMark`), so an Undo of the mark brings it back before the platform has
// heard of the Undo.
interface Reported {
  change: WireChange;
  markAtReport: InputReadMark | undefined;
  ackMark?: InputReadMark;
}

abstract class Tracker<W, S> {
  protected wire: W | null = null;
  protected readonly listeners = new Set<Listener<S>>();
  // Listeners added after a status landed, still owed their first call. A
  // status emitted before that call is due reaches them through `emit`,
  // which is what keeps a later status from being followed by an earlier one.
  private readonly owedFirst = new Set<Listener<S>>();
  private readonly failureListeners = new Set<(err: unknown) => void>();
  private lastEmitted: string | null = null;
  private running = false;
  private again = false;
  private retryMs = RETRY_FIRST_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  protected disposed = false;

  constructor(protected readonly host: InputStatusHost) {}

  add(cb: Listener<S>): void {
    this.listeners.add(cb);
    if (this.wire !== null) {
      this.owedFirst.add(cb);
      queueMicrotask(() => {
        if (!this.owedFirst.delete(cb)) return;
        if (!this.disposed && this.listeners.has(cb)) call(cb, this.compute());
      });
    }
  }

  /** Hears every read that fails, until the returned function is called. */
  onFailure(cb: (err: unknown) => void): () => void {
    this.failureListeners.add(cb);
    return () => this.failureListeners.delete(cb);
  }

  remove(cb: Listener<S>): boolean {
    this.listeners.delete(cb);
    this.owedFirst.delete(cb);
    if (this.listeners.size === 0) this.dispose();
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.owedFirst.clear();
    this.failureListeners.clear();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Fetch whatever moved, coalescing with a read already out. */
  pump(): void {
    if (this.disposed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void (async () => {
      try {
        do {
          this.again = false;
          try {
            const next = await this.fetch();
            if (this.disposed) return;
            this.retryMs = RETRY_FIRST_MS;
            if (next !== undefined) this.accept(next);
          } catch (err) {
            if (!this.disposed) {
              if (this.failureListeners.size === 0) {
                console.error('Brass: reading the input status failed', err);
              }
              for (const cb of Array.from(this.failureListeners)) cb(err);
              this.scheduleRetry();
            }
          }
        } while (this.again && !this.disposed);
      } finally {
        this.running = false;
      }
    })();
  }

  // A failed read is read again after a wait that doubles to a ceiling, so a
  // status the platform could not answer reaches the app once it can.
  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_CEILING_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, wait);
  }

  /** The reserved roots moved: report the status they now imply. */
  localChanged(): void {
    if (this.wire !== null && !this.disposed) this.emit();
  }

  protected accept(next: W): void {
    this.wire = next;
    this.remember();
    this.emit();
  }

  protected emit(): void {
    const status = this.compute();
    const serialized = JSON.stringify(status);
    if (serialized === this.lastEmitted) return;
    this.lastEmitted = serialized;
    for (const cb of this.listeners) {
      this.owedFirst.delete(cb);
      call(cb, status);
    }
  }

  protected query(extra: Record<string, string> = {}): Record<string, string> {
    const line = this.host.lineId();
    return line === null ? extra : { [INPUT_STATUS_LINE_PARAM]: line, ...extra };
  }

  protected local(): Map<string, InputsKeyState> | null {
    const roots = this.host.localRoots();
    return roots === null ? null : decodeInputsRoots(roots.refs, roots.read);
  }

  /** Undefined when nothing moved. */
  protected abstract fetch(): Promise<W | undefined>;
  protected abstract remember(): void;
  protected abstract compute(): S;
}

function call<S>(cb: Listener<S>, status: S): void {
  try {
    cb(status);
  } catch (err) {
    console.error('Brass: a subscribeInputStatus listener threw', err);
  }
}

function emptyStatus(key: string): WireStatus {
  return { key, refs: [], files: [], changed: [], hidden_count: 0, truncated: false, rev: 0 };
}

class KeyTracker extends Tracker<WireStatus, InputStatus> {
  private readonly reported = new Map<string, Reported>();
  // A key the platform holds no row for yet is read whole on every nudge.
  private missing = false;
  private nudgedRev = -1;

  constructor(
    host: InputStatusHost,
    readonly key: string,
  ) {
    super(host);
  }

  nudge(rev: number | null): void {
    if (rev !== null) {
      if (this.wire !== null && !this.missing && rev <= this.wire.rev) return;
      this.nudgedRev = Math.max(this.nudgedRev, rev);
    } else {
      // A nudge naming no revision (a resubscribe) says nudges may have been
      // missed, so no revision already seen can answer it: ask the server.
      this.nudgedRev = -1;
    }
    this.pump();
  }

  protected async fetch(): Promise<WireStatus | undefined> {
    if (this.wire === null || this.missing) return this.readWhole();
    if (this.nudgedRev !== -1 && this.nudgedRev <= this.wire.rev) return undefined;
    const raw = await this.host.runtime.readKey(
      this.key,
      this.query({ [INPUT_STATUS_SINCE_PARAM]: String(this.wire.rev) }),
    );
    if (raw === null) return this.readWhole();
    const delta = parseInputStatusDelta(raw);
    if (delta === null) throw new Error('Malformed input status delta');
    if ('resync' in delta) return this.readWhole();
    // A projection settling clears `stale` without moving the revision.
    if (delta.rev === this.wire.rev) {
      if ((delta.stale === true) === (this.wire.stale === true)) return undefined;
      const next: WireStatus = { ...this.wire };
      if (delta.stale === true) next.stale = true;
      else delete next.stale;
      return next;
    }
    return applyInputStatusDelta(this.wire, delta) ?? this.readWhole();
  }

  // Pages the whole status. A page answering a resync means the status moved
  // between pages, and the read starts again.
  private async readWhole(): Promise<WireStatus | undefined> {
    for (let attempt = 0; attempt < FULL_READ_ATTEMPTS; attempt++) {
      if (this.disposed) return undefined;
      const first = await this.host.runtime.readKey(this.key, this.query());
      if (first === null) {
        this.missing = true;
        return this.wire !== null && this.wire.rev === 0 ? undefined : emptyStatus(this.key);
      }
      const page = parseInputStatusPage(first);
      if (page === null) throw new Error('Malformed input status');
      const files = [...page.files];
      const changed = [...page.changed];
      let cursor = page.cursor;
      let consistent = true;
      while (cursor !== null) {
        if (this.disposed) return undefined;
        const raw = await this.host.runtime.readKey(
          this.key,
          this.query({ [INPUT_STATUS_CURSOR_PARAM]: cursor }),
        );
        const next = raw === null ? null : parseInputStatusPage(raw);
        if (next === null || next.rev !== page.rev) {
          consistent = false;
          break;
        }
        files.push(...next.files);
        changed.push(...next.changed);
        cursor = next.cursor;
      }
      if (!consistent) continue;
      this.missing = false;
      const { cursor: _cursor, ...status } = page;
      return { ...status, files, changed };
    }
    return undefined;
  }

  protected remember(): void {
    const wire = this.wire!;
    const read = this.local()?.get(this.key)?.read ?? {};
    const stamps = stampsOf(wire);
    retire(this.reported, new Set(wire.changed.map((c) => c.doc_id)), (entry) => read[entry.change.doc_id], stamps, stamps);
    for (const change of wire.changed) {
      this.reported.set(change.doc_id, { change, markAtReport: read[change.doc_id] });
    }
  }

  protected compute(): InputStatus {
    const wire = this.wire!;
    const local = this.local();
    const state = local?.get(this.key);
    const refs = local === null ? wire.refs : (state?.refs ?? []);
    const resolve = referenceResolver([...refs, ...wire.refs]);
    const stampOf = stampsOf(wire);

    const listed = new Set(wire.changed.map((c) => c.doc_id));
    const candidates: Reported[] = wire.changed.map(
      (change) => this.reported.get(change.doc_id) ?? { change, markAtReport: undefined },
    );
    if (local !== null) {
      for (const [docId, entry] of this.reported) {
        if (!listed.has(docId)) candidates.push(entry);
      }
    }
    const changed: InputStatusChange[] = [];
    // A key this copy holds no references under has no input files, whatever
    // the platform last reported for it.
    if (local !== null && refs.length === 0) candidates.length = 0;
    for (const entry of candidates) {
      if (local !== null && !shown(entry, listed.has(entry.change.doc_id), state?.read[entry.change.doc_id], stampOf, stampOf)) {
        continue;
      }
      changed.push(toChange(entry.change, resolve));
    }
    changed.sort(byDocId);
    return {
      key: this.key,
      refs,
      inputs: wire.files.map((f) => ({
        doc_id: f.doc_id,
        name: f.name,
        ...(f.schema_type !== undefined ? { family: f.schema_type } : {}),
        updated_at: f.updated_at,
        from: resolve(f.from),
        ...(f.awaits_import === true ? { awaits_import: true as const } : {}),
      })),
      changed,
      hidden_count: wire.hidden_count,
      truncated: wire.truncated,
      settled: wire.arriving !== true && (local === null || sameReferences(refs, wire.refs)),
    };
  }
}

// Whether the platform's status was resolved from the references this copy
// holds. Until a change to them reaches the platform, `files` and `changed`
// describe the references it replaced.
function sameReferences(a: readonly WireReference[], b: readonly WireReference[]): boolean {
  const ids = new Set(a.map(inputReferenceId));
  const other = new Set(b.map(inputReferenceId));
  if (ids.size !== other.size) return false;
  for (const id of ids) if (!other.has(id)) return false;
  return true;
}

function stampsOf(wire: WireStatus): Map<string, number | null> {
  return new Map(wire.files.map((f) => [f.doc_id, inputStampFromUpdatedAt(f.updated_at)]));
}

// Called with a fresh report: an entry it no longer lists is kept only when
// the document's own mark acknowledged it, recording that mark; any other
// entry the platform dropped is forgotten.
function retire<K>(
  reported: Map<K, Reported>,
  listed: ReadonlySet<K>,
  markOf: (entry: Reported) => InputReadMark | undefined,
  stampOf: ReadonlyMap<string, number | null>,
  files: ReadonlyMap<string, unknown>,
): void {
  for (const [id, entry] of reported) {
    if (listed.has(id)) continue;
    if (leftTheKey(entry, files)) {
      reported.delete(id);
      continue;
    }
    const mark = markOf(entry);
    if (entry.ackMark === undefined && mark !== undefined && acknowledged(entry.change, mark, entry.markAtReport, stampOf)) {
      entry.ackMark = mark;
    } else if (entry.ackMark === undefined) {
      reported.delete(id);
    }
  }
}

// Whether the key's current files contradict a change the platform stopped
// listing, so an Undo of its mark has nothing to bring back: a file it no
// longer lists among the key's files has left the key, and a removed file it
// lists again (an Undo that restored the reference with the mark) is back.
function leftTheKey(entry: Reported, files: ReadonlyMap<string, unknown>): boolean {
  return (entry.change.change === 'removed') === files.has(entry.change.doc_id);
}

// Whether an entry belongs in `changed`. One the platform lists is shown
// unless the document's mark acknowledges it; one it has stopped listing is
// shown only while the document holds an earlier mark than the one that
// acknowledged it, which is what an Undo of that mark leaves.
function shown(
  entry: Reported,
  listed: boolean,
  mark: InputReadMark | undefined,
  stampOf: ReadonlyMap<string, number | null>,
  files: ReadonlyMap<string, unknown>,
): boolean {
  if (listed) return !acknowledged(entry.change, mark, entry.markAtReport, stampOf);
  if (entry.ackMark === undefined) return false;
  if (leftTheKey(entry, files)) return false;
  return mark === undefined || inputReadMarkAfter(entry.ackMark, mark);
}

// Whether the document's read mark for a changed file acknowledges it. A file
// whose current version is known is acknowledged by a mark covering that
// version, the rule the platform applies, so a mark written from a copy read
// before the file last moved leaves it changed. Otherwise the mark has to have
// moved past the one held when the platform reported the file.
function acknowledged(
  change: WireChange,
  mark: InputReadMark | undefined,
  markAtReport: InputReadMark | undefined,
  stampOf: ReadonlyMap<string, number | null>,
): boolean {
  if (mark === undefined) return false;
  const moved = markAtReport === undefined || inputReadMarkAfter(mark, markAtReport);
  if (change.change === 'removed') return moved || (mark.removed && !stampOf.has(change.doc_id));
  const stamp = stampOf.get(change.doc_id);
  if (typeof stamp !== 'number') return moved;
  return !mark.removed && mark.stamp >= stamp;
}

function toChange(
  change: WireChange,
  resolve: (ids: readonly string[]) => WireReference[],
): InputStatusChange {
  return {
    doc_id: change.doc_id,
    change: change.change,
    from: resolve(change.from),
    ...(change.updated_at !== undefined ? { updated_at: change.updated_at } : {}),
  };
}

function referenceResolver(refs: readonly WireReference[]): (ids: readonly string[]) => WireReference[] {
  const byId = new Map<string, WireReference>();
  for (const ref of refs) {
    const id = inputReferenceId(ref);
    if (!byId.has(id)) byId.set(id, ref);
  }
  return (ids) => ids.flatMap((id) => byId.get(id) ?? []);
}

function byDocId(a: { doc_id: string }, b: { doc_id: string }): number {
  return a.doc_id < b.doc_id ? -1 : a.doc_id > b.doc_id ? 1 : 0;
}

/**
 * Every status subscription one document holds: a tracker per key, and the
 * one watch on the reserved roots they share.
 */
export class InputStatusHub {
  private readonly keys = new Map<string, KeyTracker>();
  private stopWatch: (() => void) | null = null;

  constructor(private readonly host: InputStatusHost) {}

  subscribeKey(
    key: string,
    cb: Listener<InputStatus>,
    onFailure?: (err: unknown) => void,
  ): () => void {
    let tracker = this.keys.get(key);
    const fresh = tracker === undefined;
    if (tracker === undefined) {
      tracker = new KeyTracker(this.host, key);
      this.keys.set(key, tracker);
    }
    const held = tracker;
    held.add(cb);
    const stopFailure = onFailure === undefined ? null : held.onFailure(onFailure);
    this.watch();
    if (fresh) held.pump();
    return () => {
      stopFailure?.();
      if (held.remove(cb) && this.keys.get(key) === held) {
        this.keys.delete(key);
        this.unwatchIfIdle();
      }
    };
  }

  /** A nudge for `key` at `rev`, or (both null) a resubscribe that may have
   *  missed nudges for any key. */
  nudged(key: string | null, rev: number | null): void {
    if (key === null) {
      for (const tracker of this.keys.values()) tracker.nudge(null);
    } else {
      this.keys.get(key)?.nudge(rev);
    }
  }

  dispose(): void {
    for (const tracker of this.keys.values()) tracker.dispose();
    this.keys.clear();
    this.stopWatch?.();
    this.stopWatch = null;
  }

  private watch(): void {
    this.stopWatch ??= this.host.watchLocalRoots(() => {
      for (const tracker of this.keys.values()) tracker.localChanged();
    });
  }

  private unwatchIfIdle(): void {
    if (this.keys.size > 0) return;
    this.stopWatch?.();
    this.stopWatch = null;
  }
}
