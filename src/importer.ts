import { SealRefusedError } from './staged-seal.js';
import type { Document } from './documents.js';
import type { DocumentWorkStatus } from './document-signals.js';
import type { DocumentSourceBlob } from './documents-namespace.js';
import type { ImportReport } from './import-report.js';
import {
  ImportResultError,
  encodeImportStreams,
  encodeStreamBundle,
  readImportResult,
  type DocumentImporter,
  type ImportFile,
  type ImportResult,
} from './import-contract.js';
import { BrassError } from './errors.js';
import { claimHolderOf, type ClaimHolder } from './api-fetch.js';

// The browser tab's runner for an app's importer (`Brass.registerImporter`):
// the importer itself is a leaf (`import-contract.ts`), and this is what runs
// it here. On each open it asks the platform for the import claim, and only
// the winning client reads the stored files, runs the importer, encodes what
// it returns, and hands the encoded streams to the platform to seal as the
// document's first content in one step. So the import is neither an edit nor
// something a reader sees part-way, and every other open client receives it
// whole.

export type { DocumentImporter, ImportFile, ImportResult };

// Wire shape of `POST /documents/:docId/import-claim`'s 200 responses.
// `claimed` marks the CAS win; `already_imported` carries the stamped
// provenance of a finished import; `import_failed` is an earlier import of
// this same file that failed, with the message the document shows. A pending
// claim by another client arrives as a 409 `BrassError` instead.
export interface ImportClaimResponse {
  claimed?: boolean;
  already_imported?: boolean;
  schema_ref?: { app_id: string; schema_hash: string };
  import_failed?: boolean;
  message?: string;
}

// Wire shape of `POST /documents/:docId/import-failed`'s 200 response.
export interface ImportFailedResponse {
  import_failed: true;
  message: string;
}

export interface ImportRunnerDeps {
  claimImport(docId: string): Promise<ImportClaimResponse>;
  // Stages the import's encoded streams as one bundle, answering the key the
  // completion names it by.
  stageImport(docId: string, bundle: Uint8Array): Promise<string>;
  completeImport(
    docId: string,
    report: ImportReport | undefined,
    uploadKey: string,
  ): Promise<unknown>;
  // Records that the importer could not read the file, releasing the claim.
  failImport(docId: string, message: string): Promise<ImportFailedResponse>;
  reportError(error: Error): void;
}

export interface ImportRunner {
  setImporter(importer: DocumentImporter): void;
  // `reloadInPlace` is for a frozen copy, which takes the sealed content
  // under the same handles rather than being reopened.
  attempt(doc: Document, options?: { reloadInPlace?: boolean }): Promise<void>;
}

// The claim holder can close its tab mid-import and let its claim expire, so
// a client that lost the race asks again instead of spending this document's
// one attempt on it.
//
// A holder EXTENDS its claim while it runs (`startClaimRefresh`), so the
// expiry a loser is waiting out is not the platform's base TTL but
// `last-refresh + TTL`, up to `CLAIM_REFRESH_MAX` refreshes away. A schedule
// sized against the base TTL therefore gives up while the claim is still
// live, and what it leaves behind is a reader sitting on an empty document
// with no further attempt coming and nothing said. So the tail keeps asking,
// at an interval, for longer than a holder can hold.
const PENDING_RETRY_DELAYS_MS = [15_000, 45_000, 135_000];
const PENDING_RETRY_INTERVAL_MS = 120_000;
// Enough tail attempts to outlast a holder refreshing to its own bound, and
// far inside the per-caller claim budget.
const PENDING_RETRY_TAIL = 18;
// The whole wait on another client's claim, which is what the schedule above
// spans; a holder that keeps refreshing is waited for this long.
const PENDING_WAIT_MAX_MS =
  PENDING_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) +
  PENDING_RETRY_TAIL * PENDING_RETRY_INTERVAL_MS;

// A holder refreshes its claim every `CLAIM_REFRESH_MS`, so one that has not
// for this long has missed a refresh and is taken to have stopped. The reader
// asks again the moment the stopped holder's claim lapses, which is when the
// platform lets it take the claim over.
export const STALLED_HOLDER_MS = 2 * 60_000;
const LAPSE_MARGIN_MS = 2_000;

// A claim expires while a long import is still parsing or still waiting for
// its writes to be acked, and the completion needs it, so the runner
// re-claims on this interval while its own import runs. Bounded so a
// document whose writes never drain stops re-claiming.
const CLAIM_REFRESH_MS = 60_000;
const CLAIM_REFRESH_MAX = 30;

// How long an importer may run before its import is recorded as failed, as a
// thrown importer's is. Inside the claim's refreshed lifetime, so the failure
// is recorded while this client still holds the claim, and far past what a
// file at the platform's upload cap takes to parse.
export const IMPORTER_RUN_CEILING_MS = 20 * 60_000;

// The status the platform refuses an import the app cannot run with: its
// `imports` do not claim the file, it declares no schema, or the document
// holds a half-written import.
const CLAIM_REFUSED_STATUS = 422;

// Runs the import protocol for one opened document: claim, and on the
// win fetch + parse + complete. Separated from the client so the
// protocol is testable against mocked HTTP deps.
export function createImportRunner(deps: ImportRunnerDeps): ImportRunner {
  let importer: DocumentImporter | null = null;
  // One attempt per OPEN, recorded as the open generation the attempt was
  // made in. The mark cannot be per-instance: an app's `close()` parks the
  // Document and the park cache hands the SAME instance back on reopen, so a
  // bare mark says "this document already had its attempt" for the life of the
  // page. Every path that leaves the file unimported (the claim failing, the
  // importer throwing, the writes never draining) is then unrecoverable
  // without a reload, and the reopen the reader reaches for does nothing and
  // says nothing. Keyed on the open, a reopen attempts again; a document whose
  // import already finished spends one claim that resolves `already_imported`,
  // which is what a reopen has always cost on a fresh instance.
  const attempted = new WeakMap<Document, number>();
  // Documents waiting on server-side work, holding the detach for the status
  // listener that is watching it. Kept apart from `attempted` so the wait does
  // not consume the attempt, and holding the DETACH rather than a bare mark so
  // a second `attempt` call replaces the listener instead of stacking one.
  //
  // Replacing rather than returning early is what survives a park. An app's
  // `close()` parks the Document, which drops every status listener, and the
  // park cache hands the SAME instance back on reopen; a mark alone would
  // still say "someone is watching this" when nothing is, and the reopened
  // document would never attempt its import again for the life of the page.
  const waiting = new WeakMap<Document, () => void>();
  // Retries already scheduled against another client's live claim, and when
  // the wait on it began.
  const pendingRetries = new WeakMap<Document, number>();
  const pendingSince = new WeakMap<Document, number>();
  // Documents whose last answer named a holder that had stopped refreshing.
  const stalledBefore = new WeakSet<Document>();
  // Documents this runner is holding read-only while an import is in flight
  // on them, in this client or in another. The import becomes the document's
  // content only while nothing else has been written to it, so an edit made
  // first would leave the file unimportable.
  const importLocks = new WeakSet<Document>();
  const reloadsInPlace = new WeakSet<Document>();
  // The import attempt in flight for each document id, from its claim to its
  // outcome, across every Document this client holds for that id.
  const inFlight = new Map<string, Promise<void>>();
  // Frozen copies that reload when their hold is released, because what they
  // loaded is no longer what the document holds: a copy taken before its file
  // was stored learns what that work left, and a copy of a file another
  // client imported takes that import.
  const reloadOnRelease = new WeakSet<Document>();

  function lock(doc: Document, message: string): void {
    importLocks.add(doc);
    doc._importHold = { message, pending: true, blocking: true };
    doc._emitStatus(doc._importHold);
  }

  // Release the hold onto a failed import rather than onto "Ready": the
  // document holds nothing the file had in it.
  function settleFailed(doc: Document, message: string): void {
    reloadOnRelease.delete(doc);
    importLocks.delete(doc);
    doc._importHold = null;
    doc._emitStatus({ message, pending: false, blocking: true });
  }

  function unlock(doc: Document): void {
    if (reloadOnRelease.delete(doc)) {
      importLocks.delete(doc);
      doc._awaitsImport = false;
      doc._importHold = null;
      doc.reload().catch((err: unknown) => deps.reportError(asError(err)));
      return;
    }
    if (!importLocks.delete(doc)) return;
    doc._importHold = null;
    doc._emitStatus(
      { message: 'Ready', pending: false, blocking: false },
      { contentLoaded: true },
    );
  }
  const runner: ImportRunner = {
    setImporter(fn: DocumentImporter): void {
      importer = fn;
    },
    async attempt(doc: Document, options?: { reloadInPlace?: boolean }): Promise<void> {
      if (options?.reloadInPlace === true) reloadsInPlace.add(doc);
      if (importer === null || doc.id === null) return;
      if (attempted.has(doc) && attempted.get(doc) === doc._openGeneration) {
        return;
      }
      // Claiming an import binds the document to THIS client for the claim's
      // lifetime, and only this client can complete it. A document that is
      // closed or parked can no longer read its source or write records, so a
      // claim taken for one is a claim nothing will ever complete: every other
      // open client is refused until the platform's claim expires. The retry
      // timer below and the resumed-open path both reach here with a document
      // that may have gone since, so the gate belongs at the entry rather than
      // at each caller.
      if (!doc._isLive) return;
      // A document with server-side work in flight has no source file to
      // read yet (a trial document opened through its link while the
      // visitor's file is stored), so claiming now asks to import bytes that
      // have not arrived: the platform refuses, and this document's one
      // attempt is spent on a document that was never eligible. Wait for the
      // work the server reports, then attempt.
      if (doc._workStatusNow?.pending === true && !importLocks.has(doc)) {
        // Any listener from an earlier attempt goes first, so the document is
        // watched exactly once whether or not the previous one survived.
        waiting.get(doc)?.();
        waiting.delete(doc);
        // A frozen copy holds through the end of that work: the copy is still
        // the empty one it loaded, so the settled status the work reports
        // would read as an empty file until the claim answers. The hold is
        // what the document emits in place of that status, which is how the
        // listener tells the work ending from its progress.
        const hold: DocumentWorkStatus | null = reloadsInPlace.has(doc)
          ? { message: 'Importing...', pending: true, blocking: true }
          : null;
        if (hold !== null) {
          doc._importHold = hold;
          doc._awaitsImport = true;
        }
        try {
          const off = doc.onStatus((status) => {
            if (status.pending && status !== hold) return;
            waiting.get(doc)?.();
            waiting.delete(doc);
            if (hold !== null) {
              importLocks.add(doc);
              reloadOnRelease.add(doc);
            }
            void runner.attempt(doc);
          });
          waiting.set(doc, off);
        } catch {
          // The document closed while attaching; nothing left to import
          // into, and the attempt is unspent, so the reopen attempts again.
        }
        return;
      }
      // The work finished, so nothing is left to wait for; drop the listener
      // rather than leave it to fire against a document already past it.
      waiting.get(doc)?.();
      waiting.delete(doc);
      // Another Document for this id is already importing it in this client.
      // Every claim this client makes carries one client id, so the platform
      // would hand this one the same claim and the file would be imported
      // twice. It waits for that attempt to settle and then asks for itself,
      // which answers from whatever that attempt left.
      const running = inFlight.get(doc.id);
      if (running !== undefined) {
        if (doc._awaitsImport) lock(doc, 'Importing...');
        await running;
        return runner.attempt(doc);
      }
      attempted.set(doc, doc._openGeneration);
      const run = importer;
      const docId = doc.id;
      let settle: () => void = () => undefined;
      const work = new Promise<void>((resolve) => (settle = resolve));
      inFlight.set(docId, work);
      try {
        // Held before the claim goes out, and synchronously, so the app never
        // sees the empty document as editable while the answer is in flight.
        if (doc._awaitsImport) lock(doc, 'Importing...');
        doc._importAbandoned = null;
        let claim: ImportClaimResponse;
        try {
          claim = await deps.claimImport(docId);
        } catch (err) {
          const status = err instanceof BrassError ? err.status : undefined;
          if (status === 409) {
            const holder = claimHolderOf(err);
            // A holder that stopped refreshing and still held the claim after
            // it should have lapsed is not coming back for it.
            if (holder !== null && stalled(holder) && stalledBefore.has(doc)) {
              stalledBefore.delete(doc);
              giveUp(doc, STALLED_HOLDER_MESSAGE);
              return;
            }
            lock(doc, 'Importing...');
            schedulePendingRetry(doc, holder);
            return;
          }
          // Refused for rate, not eligibility: the file is still waiting, so
          // the document stays held and the claim is asked again.
          if (status === 429 && doc._awaitsImport) {
            deps.reportError(asError(err));
            lock(doc, 'Importing...');
            schedulePendingRetry(doc);
            return;
          }
          unlock(doc);
          // A refusal names what the developer has to change, so it reaches
          // the app's error handler; the rest of the 4xx surface (nothing
          // stored to import, read-only access) is a no-op.
          if (
            status !== undefined &&
            status < 500 &&
            status !== CLAIM_REFUSED_STATUS
          ) {
            return;
          }
          deps.reportError(asError(err));
          return;
        }
        if (claim.import_failed === true) {
          settleFailed(doc, claim.message ?? 'This file could not be imported.');
          return;
        }
        if (claim.claimed !== true) {
          // Imported elsewhere, or nothing to import: either way the lock has
          // nothing left to hold, since the reload an import's completion sent
          // carries its content. A frozen copy hears that reload as a change
          // notice only, so it loads the content itself.
          if (reloadsInPlace.has(doc) && claim.already_imported === true) reloadOnRelease.add(doc);
          unlock(doc);
          return;
        }
        // This client won the claim: run the importer over the stored files,
        // encode what it returns, and hand the platform the encoded streams to
        // seal as the document's content. An importer that cannot read the
        // file is recorded on the document, so later opens show the failure
        // instead of running it again, and so is a seal refused for what the
        // importer produced. Any other throw (the file unreachable, the
        // document changed under the seal) leaves the file for a later open
        // to import.
        lock(doc, 'Importing...');
        let failure: Error | null = null;
        try {
          const source = await doc.sourceBlob();
          lock(doc, `Importing ${source.filename}...`);
          const stopRefresh = startClaimRefresh(docId, doc);
          try {
            let result: ImportResult | null = null;
            try {
              result = readImportResult(await withinCeiling(run(importFileOf(source))));
            } catch (err) {
              if (unreadSources.has(err as object)) throw err;
              failure = asError(err);
            }
            if (failure === null && result === null) {
              failure = new Error(
                'The importer returned no content, so this file was not ' +
                  'imported. Return { streams } from the importer.',
              );
            }
            if (failure === null && result !== null) {
              failure = await seal(doc, docId, result);
            }
          } finally {
            stopRefresh();
          }
        } catch (err) {
          deps.reportError(asError(err));
          // A seal the platform refused for the file's content was recorded
          // on the document as a failed import, as the importer's own
          // failure is.
          if (err instanceof SealRefusedError && err.importFailed !== undefined) {
            settleFailed(doc, err.importFailed);
            return;
          }
          unlock(doc);
          return;
        }
        if (failure === null) {
          unlock(doc);
          return;
        }
        deps.reportError(failure);
        try {
          const recorded = await deps.failImport(docId, failure.message);
          settleFailed(doc, recorded.message);
        } catch (err) {
          deps.reportError(asError(err));
          unlock(doc);
        }
      } finally {
        if (inFlight.get(docId) === work) inFlight.delete(docId);
        settle();
      }
    },
  };

  // Seal the streams as the document's first content, answering the failure
  // to record when the result holds nothing. The platform refuses a document
  // something was already written to, and that refusal reaches the app's
  // error handler like any other failed import.
  async function seal(
    doc: Document,
    docId: string,
    result: ImportResult,
  ): Promise<Error | null> {
    const streams = await encodeImportStreams(result);
    // An import that holds nothing must not stamp the document imported: the
    // stamp is permanent, and the file's content would then have no path
    // into a document that holds none.
    if (streams.length === 0) {
      return new Error('The importer returned no records, so this file was not imported.');
    }
    if (!doc._isLive) return null;
    const key = await deps.stageImport(docId, encodeStreamBundle(streams));
    await deps.completeImport(docId, result.report, key);
    // Every open client reloads onto the sealed content, this one included;
    // reloading here shows it without waiting for that frame. The copy stays
    // held as importing until the reloaded one replaces it: released first,
    // it would report Ready on a document that holds none of the file.
    doc._awaitsImport = false;
    if (reloadsInPlace.has(doc)) {
      reloadOnRelease.delete(doc);
      await doc.reload();
      unlock(doc);
      return null;
    }
    importLocks.delete(doc);
    doc._reopen();
    return null;
  }

  // Release a document whose import this client stopped waiting for, saying
  // why: the reader is looking at an empty document, so the reason is what
  // keeps them from concluding the file was empty.
  function giveUp(doc: Document, message: string): void {
    unlock(doc);
    doc._importAbandoned = message;
    deps.reportError(new Error(message));
  }

  function schedulePendingRetry(doc: Document, holder: ClaimHolder | null = null): void {
    const taken = pendingRetries.get(doc) ?? 0;
    const now = Date.now();
    const since = pendingSince.get(doc) ?? now;
    pendingSince.set(doc, since);
    let delay = PENDING_RETRY_DELAYS_MS[taken] ?? PENDING_RETRY_INTERVAL_MS;
    if (holder !== null && !holder.sealing) {
      // Ask again as soon as a holder that stops now would read as stopped,
      // or the moment a stopped one's claim lapses.
      if (stalled(holder)) {
        stalledBefore.add(doc);
        delay = holder.expiresInMs + LAPSE_MARGIN_MS;
      } else {
        stalledBefore.delete(doc);
        delay = Math.min(delay, STALLED_HOLDER_MS - holder.refreshedMsAgo + LAPSE_MARGIN_MS);
      }
    }
    if (now + delay - since > PENDING_WAIT_MAX_MS) {
      // Out of time with the file still unimported.
      giveUp(
        doc,
        'Could not import this file: another window has been importing it ' +
          'for longer than expected. Reload to try again.',
      );
      return;
    }
    pendingRetries.set(doc, taken + 1);
    attempted.delete(doc);
    setTimeout(() => {
      void runner.attempt(doc);
    }, delay);
  }

  function startClaimRefresh(docId: string, doc: Document): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let left = CLAIM_REFRESH_MAX;
    const tick = (): void => {
      if (left <= 0) return;
      // A renewal from a document that has gone tells the platform the holder
      // is still working, when this client can no longer complete the import
      // at all. Stopping here is what lets the claim expire on its own TTL so
      // a client that IS open picks the file up, rather than being refused for
      // the whole refresh budget.
      if (!doc._isLive) return;
      left -= 1;
      // A failed refresh needs no handling: the completion reports
      // whether the claim survived.
      void deps.claimImport(docId).catch(() => undefined);
      timer = setTimeout(tick, CLAIM_REFRESH_MS);
    };
    timer = setTimeout(tick, CLAIM_REFRESH_MS);
    return () => {
      clearTimeout(timer);
      left = 0;
    };
  }

  return runner;
}

// An importer's run, rejected once it passes `IMPORTER_RUN_CEILING_MS`.
function withinCeiling<T>(run: T | PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `The importer did not finish within ${IMPORTER_RUN_CEILING_MS / 60_000} minutes, ` +
              'so this file was not imported.',
          ),
        ),
      IMPORTER_RUN_CEILING_MS,
    );
  });
  return Promise.race([Promise.resolve(run), ceiling]).finally(() => clearTimeout(timer));
}

const STALLED_HOLDER_MESSAGE =
  'Could not import this file: the window that was importing it stopped ' +
  'responding. Reload to try again.';

function stalled(holder: ClaimHolder): boolean {
  return !holder.sealing && holder.refreshedMsAgo >= STALLED_HOLDER_MS;
}

// Errors thrown reading the stored file. They say the file could not be
// reached, not that the importer could not read it, so they are not recorded
// as a failed import.
const unreadSources = new WeakSet<object>();

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// The file an importer is given, fetched when the importer asks for its
// bytes.
function importFileOf(source: DocumentSourceBlob): ImportFile {
  return {
    name: source.filename,
    content_type: source.content_type,
    byte_size: source.byte_size,
    url: source.url,
    async bytes(): Promise<Uint8Array> {
      try {
        const response = await fetch(source.url);
        if (!response.ok) {
          throw new BrassError(`Reading ${source.filename} failed`, {
            status: response.status,
          });
        }
        return new Uint8Array(await response.arrayBuffer());
      } catch (err) {
        if (err !== null && typeof err === 'object') unreadSources.add(err);
        throw err;
      }
    },
  };
}

export { ImportResultError };
