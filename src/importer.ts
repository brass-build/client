import type { Document } from './documents.js';
import type { DocumentSourceBlob } from './documents-namespace.js';
import { BrassError } from './errors.js';
import { whenSaved } from './when-saved.js';

// The app's import half for a file Brass does not parse: given the stored
// source file and the open document, parse the bytes and write the records
// through the ordinary handles. Register one at boot with
// `Brass.registerImporter`, beside `Brass.registerSerializer`.
//
// The SDK drives the protocol: on each open it asks the platform for the
// import claim, and only the winning client fetches the source and runs
// the importer. Every other open client receives the records through its
// normal subscription, and completing the import stamps the document with
// the app's declared schema.
export type DocumentImporter = (
  source: DocumentSourceBlob,
  doc: Document,
) => void | Promise<void>;

// Wire shape of `POST /documents/:docId/import-claim`'s 200 responses.
// `claimed` marks the CAS win; `already_imported` carries the stamped
// provenance of a finished import. A pending claim by another client
// arrives as a 409 `BrassError` instead.
export interface ImportClaimResponse {
  claimed?: boolean;
  already_imported?: boolean;
  schema_ref?: { app_id: string; schema_hash: string };
}

export interface ImportRunnerDeps {
  claimImport(docId: string): Promise<ImportClaimResponse>;
  completeImport(docId: string): Promise<unknown>;
  reportError(error: Error): void;
}

export interface ImportRunner {
  setImporter(importer: DocumentImporter): void;
  attempt(doc: Document): Promise<void>;
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

// A claim expires while a long import is still parsing or still waiting for
// its writes to be acked, and the completion needs it, so the runner
// re-claims on this interval while its own import runs. Bounded so a
// document whose writes never drain stops re-claiming.
const CLAIM_REFRESH_MS = 60_000;
const CLAIM_REFRESH_MAX = 30;

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
  // Retries already scheduled against another client's live claim.
  const pendingRetries = new WeakMap<Document, number>();
  const runner: ImportRunner = {
    setImporter(fn: DocumentImporter): void {
      importer = fn;
    },
    async attempt(doc: Document): Promise<void> {
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
      // read yet. A drive-linked file is fetched from the drive and stored
      // by a worker AFTER the open returns, so claiming now asks to import
      // bytes that have not arrived: the platform refuses, and this
      // document's one attempt is spent on a document that was never
      // eligible. Wait for the work the server reports, then attempt.
      if (doc.status?.pending === true) {
        // Any listener from an earlier attempt goes first, so the document is
        // watched exactly once whether or not the previous one survived.
        waiting.get(doc)?.();
        waiting.delete(doc);
        try {
          const off = doc.onStatus((status) => {
            if (status.pending) return;
            waiting.get(doc)?.();
            waiting.delete(doc);
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
      attempted.set(doc, doc._openGeneration);
      const run = importer;
      const docId = doc.id;
      let claim: ImportClaimResponse;
      try {
        claim = await deps.claimImport(docId);
      } catch (err) {
        const status = err instanceof BrassError ? err.status : undefined;
        if (status === 409) {
          schedulePendingRetry(doc);
          return;
        }
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
      if (claim.claimed !== true) return;
      // This client won the claim: run the importer, then report
      // completion so the platform stamps the document with the app's
      // schema. A throw skips the completion and leaves the claim to
      // expire; the platform decides what a later claim may do with a
      // document the failed run already wrote records into.
      try {
        const source = await doc.sourceBlob();
        const stopRefresh = startClaimRefresh(docId, doc);
        // Whether the importer put anything on the wire. A commit fires the
        // document's subscribers synchronously and raises `savingCount` as it
        // does, so a run that wrote is seen here even when its ops ack before
        // it returns.
        let wroteRecords = false;
        const stopWatchingWrites = doc.subscribe(() => {
          if (doc.savingCount > 0) wroteRecords = true;
        });
        let saved = false;
        try {
          await run(source, doc);
          // The importer's ops are still in flight when it returns, and
          // the completion stamps the version the import produced from
          // the head it lands on. Completing before they are acked stamps
          // a version below the records' own, which reads as a document
          // edited since it was uploaded from then on.
          saved = await whenSaved(doc);
        } finally {
          stopRefresh();
          stopWatchingWrites();
        }
        // The wait ends on the document going, and on the acks stopping, as
        // well as on the writes draining, and only the last of those means
        // the records are stored. The completion stamps the document with the
        // app's schema at the version it lands on, so running it over writes
        // that never reached the server records an import of records the
        // document does not hold. Abandoning instead leaves the claim to
        // expire, and a client that is still open imports the file properly.
        if (!saved) return;
        // An importer that returns without writing anything must not stamp the
        // document imported: the stamp is permanent, a later open reads
        // `already_imported`, and the file's records then have no path into a
        // document that holds none. `try { parse() } catch { return }` is an
        // ordinary shape, so this is reachable from app code that looks
        // correct. Both signals are required before skipping, so an import
        // that DID write is completed either way and never runs twice.
        if (!wroteRecords && isEmptyDocument(doc)) {
          deps.reportError(
            new Error(
              'The importer wrote no records, so this file was not imported. ' +
                'Reload to try again.',
            ),
          );
          return;
        }
        await deps.completeImport(docId);
      } catch (err) {
        deps.reportError(asError(err));
      }
    },
  };

  function schedulePendingRetry(doc: Document): void {
    const taken = pendingRetries.get(doc) ?? 0;
    const delay =
      PENDING_RETRY_DELAYS_MS[taken] ??
      (taken < PENDING_RETRY_DELAYS_MS.length + PENDING_RETRY_TAIL
        ? PENDING_RETRY_INTERVAL_MS
        : undefined);
    if (delay === undefined) {
      // Out of attempts with the file still unimported. The reader is looking
      // at an empty document, so say so rather than leaving them to conclude
      // the file was empty.
      deps.reportError(
        new Error(
          'Could not import this file: another window has been importing it ' +
            'for longer than expected. Reload to try again.',
        ),
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

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// Whether the document holds nothing at all, read only when no write was
// observed, so the walk is over an empty or near-empty document.
//
// A document reports its ROOTS whatever it holds (a fresh one reads
// `{ entities: {} }`), so emptiness is every root being empty rather than
// there being no roots.
function isEmptyDocument(doc: Document): boolean {
  try {
    return Object.values(doc.toJSON()).every(
      (root) =>
        root === null ||
        typeof root !== 'object' ||
        Object.keys(root as object).length === 0,
    );
  } catch {
    // A document that cannot be read is not one to declare empty.
    return false;
  }
}
