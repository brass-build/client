// `subscribeInputDocuments`: calls an app's handlers with the input documents
// of a key, each as a handle the app may open in any mode. `loaded` gets every
// input wherever the document is open; `changed` gets the inputs changed since
// the document last read them, where it can be edited, and records each as
// read once its handler resolves; `removed` gets each input that left.

import type { InputReference } from './hosted-ui.js';
import { inputStampFromUpdatedAt } from './inputs.js';
import { inDevelopment } from './in-development.js';
import { importerWaitRejections } from './importer-wait.js';
import type { InputStatus, InputStatusChange } from './inputs-status.js';
import type { OpenDocumentByIdOptions, OpenedDocument } from './open-document.js';
import type { OpenModeOptions, ReadOnlyDocument } from './read-only-document.js';
import type { MarkReadHandle, MarkReadOptions, MarkReadStatus } from './references.js';

/** `input.open`, typed by what the open asks for, as `Brass.openDocumentById` is. */
export interface InputDocumentOpen {
  (options: OpenDocumentByIdOptions & { frozen: true; readOnly?: true }): Promise<ReadOnlyDocument>;
  (options: OpenDocumentByIdOptions & { readOnly: true }): Promise<ReadOnlyDocument>;
  (options?: OpenDocumentByIdOptions & { frozen?: false }): Promise<OpenedDocument>;
  (
    options: Omit<OpenDocumentByIdOptions, 'frozen' | 'readOnly'> & OpenModeOptions,
  ): Promise<OpenedDocument | ReadOnlyDocument>;
}

/** An input document for the app to work on. */
export interface InputDocument {
  readonly doc_id: string;
  readonly name: string;
  /** The input's family, absent on a document that has none. */
  readonly family?: string;
  /** The version of the input this call is for. */
  readonly updated_at: string;
  /** The key's references that include this input, nearest first. */
  readonly from: InputReference[];
  /** Opens the input, or returns the document already opened with the same
   *  options (a frozen one loaded at this version). Opening with other options
   *  closes that one. What `open` returns closes when the handler resolves,
   *  unless the app passed `keepDocumentsOpen`. */
  readonly open: InputDocumentOpen;
  /** Closes what `open` returned for this input. */
  close(): void;
}

/** What `subscribeInputDocuments` calls. */
export interface InputDocumentHandlers {
  /** Every input each time the app subscribes, then each new version,
   *  wherever the document is open. Records nothing. */
  loaded?(input: InputDocument): void | Promise<void>;
  /** Each input added or edited since this document last read it, where the
   *  document can be edited. Brass records the input as read when the
   *  handler resolves. */
  changed?(input: InputDocument): void | Promise<void>;
  /** Each input no longer among the key's inputs, or deleted: one `loaded`
   *  was given, wherever the document is open, and one this document read
   *  before, where it can be edited. */
  removed?(docId: string): void | Promise<void>;
  /** The key's status, whenever it changes or its `settled` flips. */
  status?(status: InputStatus): void;
  /** Once every known input's handler has finished for its current
   *  version, resolved or rejected, and the inputs have stopped changing:
   *  after the first load, and after each later batch
   *  of additions, edits or removals. */
  settled?(status: InputStatus): void;
}

/** How `subscribeInputDocuments` runs the handlers. */
export interface InputDocumentOptions {
  /** Keep each document `open` returns until its input is removed,
   *  `input.close()` is called, or the app unsubscribes. The next `open` of
   *  the input returns the same document. */
  readonly keepDocumentsOpen?: boolean;
  /** The most handlers that run at once. Brass paces them by default. */
  readonly concurrency?: number;
}

/** @internal What the follower needs from its document. */
export interface InputDocumentsHost {
  subscribeStatus(key: string, cb: (status: InputStatus) => void): () => void;
  canWrite(): boolean;
  markRead(status: MarkReadStatus, options: MarkReadOptions): void;
  open: ((docId: string, options?: OpenDocumentByIdOptions) => Promise<OpenedDocument>) | null;
}

/** A failed file waits this long before its first retry at the same
 *  version, doubling up to the ceiling. A new version is tried at once. A file
 *  refused `not_imported` is tried again when its import lands instead. */
const RETRY_FIRST_MS = 2_000;
const RETRY_CEILING_MS = 5 * 60_000;

/** `settled` waits for this long with no call starting or finishing and no
 *  change to the set, so a burst of arrivals reaches it once. */
const QUIET_MS = 2_000;

/** The handlers that run at once when the app sets no `concurrency`. Each
 *  handler usually opens its input, and a few hundred opens started together
 *  are refused as throttled, for this app and every other caller. */
const DEFAULT_CONCURRENCY = 8;

/** A call pending this long is reported in development builds: the input
 *  gets no further call until it settles, and it keeps its concurrency slot. */
const LONG_PENDING_MS = 60_000;

type Copy = MarkReadHandle & { close(): void; reload?(): Promise<void> };

/** A copy `file.open` returned: the copy itself, and the handle the app got,
 *  which warns when it is used after the copy closed. */
interface Opened {
  options: string;
  copy: Copy;
  handle: Copy;
  closedBy: string | null;
}

type Kind = 'loaded' | 'changed' | 'removed';

/** On the input a shared follower hands out: `open` on behalf of one
 *  subscription, so a copy another subscription is using in the same call is
 *  not replaced. */
const OPEN_FOR = Symbol('openFor');
type OpenFor = (owner: object) => InputDocumentOpen;

interface Work {
  docId: string;
  kind: Kind;
  /** What `done` is compared against, so work at a version already handled is
   *  not given to a handler again. */
  version: string;
  from: InputReference[];
  /** The status entry this work reads, for `changed` and for a removal this
   *  document records. */
  entry: InputStatusChange | null;
}

interface Running {
  work: Work;
  abort: AbortController;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

/** Options that open the same copy compare equal. */
const optionsKey = (options: OpenDocumentByIdOptions | undefined): string =>
  JSON.stringify(Object.entries(options ?? {}).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)));

const failKeyOf = (w: Work): string => `${w.kind}:${w.docId}@${w.version}`;

const newer = (version: string, than: string | null): boolean => {
  if (than === null) return true;
  const a = inputStampFromUpdatedAt(version);
  const b = inputStampFromUpdatedAt(than);
  return a !== null && b !== null ? a > b : version !== than;
};

/** Whether a copy was loaded at a later version than the call it was opened for. */
const openedAhead = (copyAt: string | null, callAt: string): boolean => {
  if (copyAt === null) return false;
  const a = inputStampFromUpdatedAt(copyAt);
  const b = inputStampFromUpdatedAt(callAt);
  return a !== null && b !== null && a > b;
};

/** @internal */
export function followInputDocuments(
  host: InputDocumentsHost,
  key: string,
  handlers: InputDocumentHandlers,
  options: InputDocumentOptions = {},
): () => void {
  checkOptions(options);
  return follow(host, key, handlers, () => options).stop;
}

const checkOptions = (options: InputDocumentOptions): void => {
  if (options.concurrency !== undefined && !(options.concurrency >= 1)) {
    throw new TypeError('subscribeInputDocuments: concurrency must be at least 1');
  }
};

interface Follower {
  stop(): void;
  /** Runs again the inputs whose open stopped waiting for `registerImporter`. */
  importerRegistered(): void;
  /** Gives `joined` the key's status, and `loaded` every input again where a
   *  handler set has not had it at its current version. */
  join(joined: InputDocumentHandlers): void;
}

/** Handlers read at each call, so a property may come and go. */
type LiveHandlers = { [K in keyof InputDocumentHandlers]?: InputDocumentHandlers[K] | undefined };

function follow(
  host: InputDocumentsHost,
  key: string,
  handlers: LiveHandlers,
  options: () => InputDocumentOptions,
): Follower {
  const has = (name: keyof InputDocumentHandlers): boolean => typeof handlers[name] === 'function';
  // With none of the file handlers, the list alone decides `settled`.
  const followsChanges = (): boolean => has('changed') || has('removed');
  let stopped = false;
  let latest: InputStatus | null = null;
  // One call per file at a time; the file's next work is taken up once it
  // settles.
  const running = new Map<string, Running>();
  // `<kind>:<doc_id>@<version>` -> the failed attempts at that version and
  // when the next may run, or that it waits for the file's import. A call
  // that failed has finished, so it does not hold `settled`.
  const failed = new Map<
    string,
    { attempts: number; retryAt: number; awaitsImport?: true; awaitsImporter?: true }
  >();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  // `<kind>:<doc_id>` -> the versions it was last handled at. For `changed`
  // this stands in for the read record until the status catches up with it.
  const done = new Map<string, string[]>();
  // Files `loaded` was given this session, so their removal reaches `removed`.
  const seen = new Set<string>();
  // The copies open per file.
  const copies = new Map<string, Opened>();
  // Moves when a handler set joins, so a `loaded` call that started before
  // it does not count as given to the newcomer.
  let joins = 0;

  const isDone = (w: Work): boolean => {
    const versions = done.get(`${w.kind}:${w.docId}`);
    if (versions === undefined) return false;
    if (versions.includes(w.version)) return true;
    const stamp = inputStampFromUpdatedAt(w.version);
    return (
      stamp !== null &&
      versions.some((v) => {
        const at = inputStampFromUpdatedAt(v);
        return at !== null && stamp <= at;
      })
    );
  };

  const closeCopy = (docId: string, by: string): void => {
    const opened = copies.get(docId);
    if (opened === undefined) return;
    copies.delete(docId);
    opened.closedBy = by;
    try {
      opened.copy.close();
    } catch {
      // Already closed by the app.
    }
  };

  // A handle that warns, once, when it is used after its copy closed.
  const guard = (docId: string, copy: Copy, opened: () => Opened): Copy => {
    let warned = false;
    const bound = new Map<PropertyKey, unknown>();
    return new Proxy(copy, {
      get(target, prop) {
        const by = opened().closedBy;
        if (by !== null && !warned && typeof prop === 'string' && prop !== 'then' && prop !== 'close') {
          warned = true;
          console.warn(`[brass] input ${docId}: the document open returned was closed ${by}, so it no longer follows the input.`);
        }
        if (prop === 'close') {
          return () => {
            if (copies.get(docId) === opened()) closeCopy(docId, 'by close()');
            else target.close();
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== 'function') return value;
        let fn = bound.get(prop);
        if (fn === undefined) {
          fn = (value as (...args: unknown[]) => unknown).bind(target);
          bound.set(prop, fn);
        }
        return fn;
      },
    });
  };

  // The work a status asks for, before subtracting what is done or running.
  const workOf = (status: InputStatus): Work[] => {
    const out: Work[] = [];
    const listed = new Set<string>();
    if (has('loaded')) {
      for (const f of status.inputs) {
        listed.add(f.doc_id);
        out.push({ docId: f.doc_id, kind: 'loaded', version: f.updated_at, from: f.from, entry: null });
      }
    } else {
      for (const f of status.inputs) listed.add(f.doc_id);
    }
    const removing = new Set<string>();
    if (followsChanges()) {
      const writer = host.canWrite();
      for (const c of status.changed) {
        if (c.change === 'removed') {
          // A copy that cannot record the removal still reports a file
          // `loaded` was given, below.
          if (!writer && seen.has(c.doc_id)) continue;
          removing.add(c.doc_id);
          out.push({ docId: c.doc_id, kind: 'removed', version: `removed:${c.updated_at ?? ''}`, from: c.from, entry: c });
        } else if (has('changed')) {
          const version = status.inputs.find((f) => f.doc_id === c.doc_id)?.updated_at ?? '';
          out.push({ docId: c.doc_id, kind: 'changed', version, from: c.from, entry: c });
        }
      }
    }
    for (const docId of seen) {
      if (!listed.has(docId) && !removing.has(docId)) {
        out.push({ docId, kind: 'removed', version: 'gone', from: [], entry: null });
      }
    }
    return out;
  };

  // `loaded` and a removal of a file it was given run on any copy; work that
  // records a read runs where the document can be written.
  const canRun = (w: Work): boolean => !stopped && (w.entry === null || host.canWrite());

  const scheduleRetry = (): void => {
    if (stopped) return;
    let next = Infinity;
    for (const f of failed.values()) next = Math.min(next, f.retryAt);
    if (next === Infinity) return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (latest !== null) start(latest);
    }, Math.max(0, next - Date.now()));
  };

  // Whether the status lists the file as not imported yet.
  const awaitsImport = (status: InputStatus, docId: string): boolean =>
    status.inputs.find((f) => f.doc_id === docId)?.awaits_import === true;

  const fail = (failKey: string, untilImported: boolean, untilImporter = false): void => {
    const attempts = (failed.get(failKey)?.attempts ?? 0) + 1;
    if (untilImporter) {
      failed.set(failKey, { attempts, retryAt: Infinity, awaitsImporter: true });
      return;
    }
    if (untilImported) {
      failed.set(failKey, { attempts, retryAt: Infinity, awaitsImport: true });
      return;
    }
    const wait = Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_CEILING_MS);
    failed.set(failKey, { attempts, retryAt: Date.now() + wait });
    scheduleRetry();
  };

  const forget = (docId: string): void => {
    seen.delete(docId);
    done.delete(`loaded:${docId}`);
    done.delete(`changed:${docId}`);
    closeCopy(docId, 'because the input was removed');
  };

  // `retry` is a further call at a version whose call already finished: it
  // changes what `settled` reports only if it resolves.
  const run = (status: InputStatus, work: Work, failKey: string, retry: boolean): void => {
    const { docId, kind } = work;
    const abort = new AbortController();
    const joinsAtStart = joins;
    // Reported whether or not a newer version abandoned the call, since an
    // abandoned call still holds the input and its slot.
    const pendingTimer = inDevelopment()
      ? setTimeout(() => {
          console.warn(
            `[brass] subscribeInputDocuments("${key}"): the ${kind} handler for input ${docId} has not settled after ${LONG_PENDING_MS / 1000}s. The input gets no other call until it resolves or rejects.`,
          );
        }, LONG_PENDING_MS)
      : null;
    running.set(docId, { work, abort, pendingTimer });
    if (!retry) touch();
    let resolved = false;
    // The copies this call opened, which it records the read at, and which
    // subscriptions each was handed to.
    const openedHere: Opened[] = [];
    const users = new Map<Opened, Set<object>>();
    // Copies opened for this call alone, beside one another subscription uses.
    const ownCopies: Opened[] = [];
    const use = (opened: Opened, owner: object): Opened => {
      if (!openedHere.includes(opened)) openedHere.push(opened);
      let by = users.get(opened);
      if (by === undefined) users.set(opened, (by = new Set()));
      by.add(owner);
      return opened;
    };
    let opening: { options: string; opened: Promise<Opened> } | null = null;
    let settled = false;
    let result: unknown;
    let callAt = work.version;
    try {
      if (kind === 'removed') {
        result = handlers.removed?.(docId);
      } else {
        const handler = kind === 'loaded' ? handlers.loaded : handlers.changed;
        const file = status.inputs.find((f) => f.doc_id === docId);
        const updatedAt = file?.updated_at ?? work.version;
        callAt = updatedAt;
        if (kind === 'loaded') seen.add(docId);
        const refuseLate = (): void => {
          if (stopped) throw new Error('open: the subscription ended');
          if (settled) throw new Error(`open: call it before the ${kind} handler resolves`);
        };
        const openFor: OpenFor = (owner) => (async (openOptions?: OpenDocumentByIdOptions) => {
          const openById = host.open;
          if (openById === null) throw new Error('open: this document cannot open its inputs');
          const wanted = optionsKey(openOptions);
          // A concurrent open with the same options shares the one in flight;
          // one with other options waits for it, then replaces it.
          while (opening !== null) {
            const pending = opening;
            if (pending.options === wanted) return use(await pending.opened, owner).handle;
            await pending.opened.catch(() => undefined);
          }
          const existing = [copies.get(docId), ...ownCopies].find((o) => o !== undefined && o.options === wanted);
          if (existing !== undefined) {
            if (newer(updatedAt, existing.copy.updatedAt)) await existing.copy.reload?.();
            return use(existing, owner).handle;
          }
          refuseLate();
          const entry = {
            options: wanted,
            opened: (async (): Promise<Opened> => {
              const copy = (await openById(docId, openOptions)) as unknown as Copy;
              if (settled || stopped) {
                copy.close();
                refuseLate();
              }
              const opened: Opened = { options: wanted, copy, handle: copy, closedBy: null };
              opened.handle = guard(docId, copy, () => opened);
              const current = copies.get(docId);
              const sharedWith = current === undefined ? [] : Array.from(users.get(current) ?? []);
              if (sharedWith.some((u) => u !== owner)) {
                ownCopies.push(opened);
              } else {
                // A copy opened with other options replaces the one open before.
                closeCopy(docId, 'when the input was opened with other options');
                copies.set(docId, opened);
              }
              return use(opened, owner);
            })(),
          };
          opening = entry;
          try {
            return (await entry.opened).handle;
          } finally {
            if (opening === entry) opening = null;
          }
        }) as InputDocumentOpen;
        // The owner a direct handler's opens are made for.
        const sole = {};
        const input: InputDocument & { [OPEN_FOR]: OpenFor } = {
          doc_id: docId,
          name: file?.name ?? '',
          ...(file?.family !== undefined ? { family: file.family } : {}),
          updated_at: updatedAt,
          from: work.from,
          open: openFor(sole),
          close: () => closeCopy(docId, 'by input.close()'),
          [OPEN_FOR]: openFor,
        };
        result = handler?.(input);
      }
    } catch (err) {
      result = Promise.reject(err);
    }
    void Promise.resolve(result)
      .then(
        () => {
          if (stopped || abort.signal.aborted) return;
          if (work.entry === null) {
            if (kind === 'removed') forget(docId);
            else if (joins === joinsAtStart) done.set(`loaded:${docId}`, [work.version]);
            failed.delete(failKey);
            resolved = true;
            return;
          }
          if (!host.canWrite()) return;
          try {
            if (kind === 'removed') {
              host.markRead({ key, changed: [work.entry], inputs: [] }, { files: [], undoable: false });
              forget(docId);
              done.set(`removed:${docId}`, [work.version]);
            } else {
              const read = openedHere.map((o) => o.copy);
              // Recorded at the call's version when a copy is ahead of it, so
              // the newer version gets a call of its own.
              const ahead = read.some((c) => openedAhead(c.updatedAt, callAt));
              const files = ahead || read.length === 0 ? [{ doc_id: docId }] : read;
              host.markRead(status, { files, undoable: false });
              const versions = ahead ? [] : read.map((c) => c.updatedAt).filter((v): v is string => v !== null);
              done.set(`changed:${docId}`, [work.version, ...versions]);
            }
            failed.delete(failKey);
            resolved = true;
          } catch {
            // The document closed or stopped being writable while the handler
            // ran, or refused the record; the file stays changed and waits
            // like a rejected one, so a refusal cannot spin.
            fail(failKey, false);
          }
        },
        (err: unknown) => {
          // Work abandoned on purpose is not a failure: its replacement, if
          // any, is already listed.
          if (stopped || abort.signal.aborted) return;
          // A file only another app imports is called again when the status
          // reports its import landed, rather than on a timer.
          const notImported = (err as { code?: unknown } | null)?.code === 'not_imported';
          // This app imports the file and has not registered its importer:
          // the import waits for the registration rather than for the status.
          const untilImporter = typeof err === 'object' && err !== null && importerWaitRejections.has(err);
          fail(
            failKey,
            notImported && kind !== 'removed' && awaitsImport(latest ?? status, docId),
            untilImporter && kind !== 'removed',
          );
          if (!notImported) {
            console.error(`[brass] input ${kind} handler for ${docId} failed`, err);
          }
        },
      )
      .finally(() => {
        settled = true;
        if (pendingTimer !== null) clearTimeout(pendingTimer);
        for (const o of ownCopies) {
          o.closedBy = `when the ${kind} handler resolved`;
          try {
            o.copy.close();
          } catch {
            // Already closed by the app.
          }
        }
        if (options().keepDocumentsOpen !== true) {
          for (const o of openedHere) {
            if (copies.get(docId) === o) closeCopy(docId, `when the ${kind} handler resolved (pass keepDocumentsOpen to keep it)`);
          }
        }
        running.delete(docId);
        if (!stopped && !abort.signal.aborted && (!retry || resolved)) touch();
        if (latest !== null) start(latest);
      });
  };

  // Abandons running work the status no longer asks for: the file left, or a
  // newer version of it is listed. Its result is not recorded.
  const abandon = (status: InputStatus): void => {
    if (running.size === 0) return;
    const versions = new Map(status.inputs.map((f) => [f.doc_id, f.updated_at]));
    for (const { work, abort } of running.values()) {
      if (work.kind === 'removed') continue;
      const now = versions.get(work.docId);
      if (now === undefined || now !== work.version) abort.abort();
    }
  };

  const start = (status: InputStatus): void => {
    const now = Date.now();
    for (const work of workOf(status)) {
      if (running.size >= (options().concurrency ?? DEFAULT_CONCURRENCY)) return;
      if (!canRun(work) || running.has(work.docId) || isDone(work)) continue;
      const failKey = failKeyOf(work);
      const f = failed.get(failKey);
      if (f !== undefined) {
        // An input refused for want of this page's importer runs again when
        // the importer registers or when another client's import lands.
        const waiting =
          f.awaitsImporter === true || f.awaitsImport === true
            ? awaitsImport(status, work.docId)
            : now < f.retryAt;
        if (waiting) continue;
      }
      run(status, work, failKey, f !== undefined);
    }
  };

  // Settled once the file list is complete, every call it asks for has
  // finished (resolved or rejected), and nothing has started, finished or
  // changed for `QUIET_MS`. Work not yet called, or called and still running
  // for the first time at its version, holds it; so does a change no writer
  // has read yet.
  let reportedSettled = false;
  let delivering = false;
  let lastShaped: InputStatus | null = null;
  const outstanding = (status: InputStatus): boolean =>
    workOf(status).some((w) => !isDone(w) && !failed.has(failKeyOf(w)));
  const emit = (status: InputStatus): InputStatus => {
    const reported = { ...status, settled: reportedSettled };
    handlers.status?.(reported);
    return reported;
  };
  const quiet = (): void => {
    quietTimer = null;
    if (stopped || latest === null || !latest.settled || outstanding(latest)) return;
    reportedSettled = true;
    const reported = emit(latest);
    handlers.settled?.(reported);
  };
  // Something started, finished or changed: `settled` reads false until the
  // set has been quiet again.
  function touch(): void {
    if (stopped) return;
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(quiet, QUIET_MS);
    if (!reportedSettled) return;
    reportedSettled = false;
    if (!delivering && latest !== null) emit(latest);
  }
  // What a status asks of the follower.
  const shapeOf = (status: InputStatus): string =>
    JSON.stringify([
      status.settled,
      status.inputs.map((f) => [f.doc_id, f.updated_at, f.awaits_import === true]),
      workOf(status).filter((w) => !isDone(w)).map(failKeyOf),
    ]);

  const stopStatus = host.subscribeStatus(key, (status) => {
    latest = status;
    const first = lastShaped === null;
    delivering = true;
    try {
      abandon(status);
      start(status);
      // Both read against what is done now, so a change this document has
      // just read compares equal to the status that drops it.
      const changed = !first && shapeOf(lastShaped!) !== shapeOf(status);
      lastShaped = status;
      if (changed) touch();
    } finally {
      delivering = false;
    }
    if (stopped) return;
    // A first status that starts no call has nothing to wait out.
    const settleNow = first && quietTimer === null && status.settled && !outstanding(status);
    if (settleNow) reportedSettled = true;
    const reported = emit(status);
    if (settleNow) handlers.settled?.(reported);
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (quietTimer !== null) clearTimeout(quietTimer);
    for (const { abort, pendingTimer } of running.values()) {
      abort.abort();
      if (pendingTimer !== null) clearTimeout(pendingTimer);
    }
    for (const docId of copies.keys()) closeCopy(docId, 'when the app unsubscribed');
    stopStatus();
  };

  const join = (joined: InputDocumentHandlers): void => {
    if (stopped || latest === null) return;
    const reported = { ...latest, settled: reportedSettled };
    joined.status?.(reported);
    if (typeof joined.loaded === 'function') {
      joins++;
      for (const k of done.keys()) if (k.startsWith('loaded:')) done.delete(k);
    }
    const quietBefore = quietTimer;
    start(latest);
    // Nothing started for the newcomer, so the set is as settled as it was.
    if (reportedSettled && quietTimer === quietBefore) joined.settled?.(reported);
  };

  const importerRegistered = (): void => {
    if (stopped) return;
    let woke = false;
    for (const [failKey, f] of failed) {
      if (f.awaitsImporter !== true) continue;
      failed.set(failKey, { attempts: f.attempts, retryAt: 0 });
      woke = true;
    }
    if (woke && latest !== null) start(latest);
  };

  return { stop, join, importerRegistered };
}

/** One subscription's handlers and options, and what its handlers resolved. */
interface HandlerSet {
  readonly handlers: InputDocumentHandlers;
  readonly options: InputDocumentOptions;
  /** `<kind>:<doc_id>` -> the version this set's handler resolved at. A
   *  removal is kept only until every set has taken it. */
  readonly given: Map<string, string>;
}

interface Shared {
  readonly sets: Set<HandlerSet>;
  readonly follower: Follower;
}

type FileHandler = 'loaded' | 'changed' | 'removed';

// The input as one subscription sees it: its `open` is that subscription's.
const inputFor = (input: InputDocument, set: HandlerSet): InputDocument => {
  const openFor = (input as InputDocument & { [OPEN_FOR]?: OpenFor })[OPEN_FOR];
  return openFor === undefined ? input : { ...input, open: openFor(set) };
};

// Calls `name` on every set that has not resolved it at `version`, and
// rejects with the first rejection once all settle, so a retry reaches only
// the sets that failed.
async function callEach(
  sets: Set<HandlerSet>,
  name: FileHandler,
  docId: string,
  version: string,
  call: (set: HandlerSet) => void | Promise<void>,
): Promise<void> {
  const given = `${name}:${docId}`;
  const due = Array.from(sets).filter((s) => typeof s.handlers[name] === 'function' && s.given.get(given) !== version);
  const results = await Promise.allSettled(
    due.map(async (set) => {
      await call(set);
      set.given.set(given, version);
      if (name === 'removed') {
        set.given.delete(`loaded:${docId}`);
        set.given.delete(`changed:${docId}`);
      } else {
        set.given.delete(`removed:${docId}`);
      }
    }),
  );
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure !== undefined) throw failure.reason;
  if (name === 'removed') for (const set of due) set.given.delete(given);
}

/** @internal The `subscribeInputDocuments` followers of one document: one
 *  per key, whatever number of subscriptions share it. Each input's work runs
 *  once and every subscription's handlers are called for it; a `changed`
 *  input is recorded as read once all of them resolve. */
export class InputFollowers {
  private readonly byKey = new Map<string, Shared>();

  subscribe(
    host: InputDocumentsHost,
    key: string,
    handlers: InputDocumentHandlers,
    options: InputDocumentOptions = {},
  ): () => void {
    checkOptions(options);
    const set: HandlerSet = { handlers, options, given: new Map() };
    let shared = this.byKey.get(key);
    if (shared === undefined) {
      const sets = new Set<HandlerSet>([set]);
      const has = (name: keyof InputDocumentHandlers): boolean =>
        Array.from(sets).some((s) => typeof s.handlers[name] === 'function');
      // Called on a snapshot of the sets, skipping one that left during an
      // earlier set's handler.
      const each = (fn: (s: HandlerSet) => void): void => {
        for (const s of Array.from(sets)) if (sets.has(s)) fn(s);
      };
      // The tightest `concurrency` any subscription asks for, and documents
      // kept open if any asks.
      const merged = (): InputDocumentOptions => {
        let concurrency: number | undefined;
        let keepDocumentsOpen = false;
        for (const s of sets) {
          const c = s.options.concurrency;
          if (c !== undefined) concurrency = concurrency === undefined ? c : Math.min(concurrency, c);
          if (s.options.keepDocumentsOpen === true) keepDocumentsOpen = true;
        }
        return { ...(concurrency !== undefined ? { concurrency } : {}), keepDocumentsOpen };
      };
      const combined: LiveHandlers = {
        get loaded() {
          if (!has('loaded')) return undefined;
          return (input: InputDocument) =>
            callEach(sets, 'loaded', input.doc_id, input.updated_at, (s) => s.handlers.loaded!(inputFor(input, s)));
        },
        get changed() {
          if (!has('changed')) return undefined;
          return (input: InputDocument) =>
            callEach(sets, 'changed', input.doc_id, input.updated_at, (s) => s.handlers.changed!(inputFor(input, s)));
        },
        get removed() {
          if (!has('removed')) return undefined;
          return (docId: string) => callEach(sets, 'removed', docId, '', (s) => s.handlers.removed!(docId));
        },
        status: (status) => each((s) => s.handlers.status?.(status)),
        settled: (status) => each((s) => s.handlers.settled?.(status)),
      };
      shared = { sets, follower: follow(host, key, combined, merged) };
      this.byKey.set(key, shared);
    } else {
      shared.sets.add(set);
      shared.follower.join(handlers);
    }
    const owner = shared;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      owner.sets.delete(set);
      if (owner.sets.size > 0) return;
      if (this.byKey.get(key) === owner) this.byKey.delete(key);
      owner.follower.stop();
    };
  }

  /** Runs again, in every follower, the inputs whose open stopped waiting
   *  for `registerImporter`. */
  importerRegistered(): void {
    for (const shared of this.byKey.values()) shared.follower.importerRegistered();
  }

  /** Stops every follower, as the document closes or parks. */
  stopAll(): void {
    const all = [...this.byKey.values()];
    this.byKey.clear();
    for (const shared of all) shared.follower.stop();
  }
}
