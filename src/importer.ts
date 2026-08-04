import type { Document } from './documents.js';
import type { DocumentSourceBlob } from './documents-namespace.js';
import { BrassError } from './errors.js';

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

// Runs the import protocol for one opened document: claim, and on the
// win fetch + parse + complete. Separated from the client so the
// protocol is testable against mocked HTTP deps.
export function createImportRunner(deps: ImportRunnerDeps): ImportRunner {
  let importer: DocumentImporter | null = null;
  // One attempt per Document instance; a reopen mints a new instance,
  // whose claim resolves `already_imported` as a no-op.
  const attempted = new WeakSet<Document>();
  return {
    setImporter(fn: DocumentImporter): void {
      importer = fn;
    },
    async attempt(doc: Document): Promise<void> {
      if (importer === null || doc.id === null || attempted.has(doc)) return;
      attempted.add(doc);
      const run = importer;
      const docId = doc.id;
      let claim: ImportClaimResponse;
      try {
        claim = await deps.claimImport(docId);
      } catch (err) {
        // The common no-op outcomes arrive as 4xx: not a stored source
        // file, read-only access, another client's claim in flight. Only
        // a server fault surfaces.
        if (err instanceof BrassError && err.status !== undefined && err.status < 500) {
          return;
        }
        deps.reportError(asError(err));
        return;
      }
      if (claim.claimed !== true) return;
      // This client won the claim: run the importer, then report
      // completion so the platform stamps the document with the app's
      // schema. A throw leaves the claim to expire, so another client
      // can retry rather than the document staying half-claimed.
      try {
        const source = await doc.sourceBlob();
        await run(source, doc);
        await deps.completeImport(docId);
      } catch (err) {
        deps.reportError(asError(err));
      }
    },
  };
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
