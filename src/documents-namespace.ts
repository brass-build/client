// SDK surface: `Brass.documents.*`. The metadata surface: get /
// thumbnails. The editable surface (snapshot + ops + mutate) is the
// `Document` runtime class via `Brass.openDocumentById` /
// `Brass.createDocument`. Access-granting is hosted-only (the share
// dialog), not a programmatic method here.

import { awaitSeal, type SealStatus } from './staged-seal.js';
import type { ImportReport } from './import-report.js';
import type { DocumentWorkStatus } from './document-signals.js';
import type { InputReference } from './hosted-ui.js';
import type { Document } from './documents.js';
import type { CheckpointAnchor } from './document-checkpoints.js';
import type { ImportClaimResponse, ImportFailedResponse } from './importer.js';
import { createApiFetch } from './api-fetch.js';
import {
  DEFAULT_IMPORT_STREAM,
  encodeImportStreams,
  encodeStreamBundle,
  type ImportContent,
} from './import-contract.js';
import type { PackedRecord } from './record-paging.js';
import { BrassError } from './errors.js';
import { createRequestLane } from './request-lane.js';
import { createBatchedGet } from './batched-get.js';
import { parseProvisionalInputsAnswer, type ProvisionalInputsAnswer, type ProvisionalInputsPost } from './inputs.js';
import {
  createDocumentList,
  type DocumentList,
  type DocumentSetSocket,
} from './document-set-subscription.js';

export type DocumentRole = 'owner' | 'editor' | 'viewer';

export interface DocumentMember {
  sub: string;
  role: DocumentRole;
  granted_at: string;
}

// An app-supplied preview image, anchored to a `(branch, version)`.
// `url` is a short-lived presigned GET valid until `expires_at`;
// `width` / `height` are `null` when the uploading app didn't report
// them. Brass can't render an app's document body, so a thumbnail
// exists only when the app uploaded one; treat its absence as normal.
export interface DocumentThumbnail {
  url: string;
  version: number;
  branch_id: string;
  content_type: string;
  width: number | null;
  height: number | null;
  created_at: string;
  expires_at: string;
}

// Wire shape returned by the document HTTP routes. `project_id` is
// `null` for loose documents.
export interface DocumentSummary {
  doc_id: string;
  organization_id: string;
  project_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
  owner_sub: string;
  deleted_at?: string;
  // The document's current card thumbnail, or absent when no app has
  // uploaded one.
  thumbnail?: DocumentThumbnail;
}

// The original file behind an opaque-blob document, returned by
// `doc.sourceBlob()`. `url` is a short-lived presigned GET the app
// fetches the raw bytes from (the bytes are not inlined: a real source
// file routinely exceeds the API response cap); the descriptor fields let
// the app decide whether it handles this format before downloading.
export interface DocumentSourceBlob {
  url: string;
  filename: string;
  content_type: string;
  byte_size: number;
  expires_in: number;
}

export interface DocumentRecord extends DocumentSummary {
  // The caller's effective role on this document, resolved via the
  // scope-loop on the server.
  role: DocumentRole;
  members: DocumentMember[];
  app_metadata?: Record<string, unknown>;
  /** The name of the project the document is filed in, ready to show as
   *  is, or null when it is in no project. Render it verbatim rather than
   *  composing a location from `project_id`. */
  location_label: string | null;
  // Whether anything can produce a file from this document. The server
  // resolves who would write it, so a newly exportable format needs no
  // client change.
  downloadable: boolean;
  /** The folder or archive this document sits in. Absent when it sits
   *  directly in its project, or loose. */
  member_of?: DocumentContainer;
  /** The document's family. A file carries its family before it is
   *  imported. Absent on a file no importer takes. */
  family?: string;
}

/** The folder or archive a document sits in. `path` is the document's own
 *  path inside it. `chain` is every folder and archive above the document,
 *  outermost first, ending with the one `doc_id` names. */
export interface DocumentContainer {
  doc_id: string;
  path: string;
  name: string;
  kind: 'folder' | 'archive';
  chain: DocumentContainerStep[];
}

export interface DocumentContainerStep {
  doc_id: string;
  name: string;
  kind: 'folder' | 'archive';
}

// One stream of a document: a named, independently-loadable CRDT unit
// (`doc.stream(name)` opens exactly the streams an app touches, so open
// cost scales with what is used, not the whole document). `line_id`
// identifies the stream's underlying CRDT line; apps only need `name`.
export interface DocumentStreamInfo {
  name: string;
  // `'crdt'` for every stream the platform writes today, frozen or not.
  // `doc.stream()` refuses any other value, so a kind of stream added
  // later is not opened as a line by this SDK.
  format: string;
  line_id: string;
  created_at: string;
  created_by: string;
}

// One branch of a document. A document has N branches: alternate
// states of the same design (the AEC "design option" used for
// whole-scheme versioning). Each branch is edited independently;
// `Brass.openDocumentById(docId, { branch })` opens a specific one.
export interface BranchSummary {
  branch_id: string;
  name: string;
  created_at: string;
  created_by: string;
  // True for the branch a cold open (no `?branch=`) lands on.
  is_default: boolean;
  // Lineage. Null for the doc's original branch; set on forked ones.
  created_from: { branch_id: string; version: number } | null;
  // The branch's current live head seq.
  current_seq: number;
}

// Input to `documents.setThumbnail`. `image` is the raw image bytes
// (a canvas `toBlob` result, a fetched `ArrayBuffer`, a `Uint8Array`);
// the SDK base64-encodes them onto the JSON upload body. `contentType`
// is required unless `image` is a `Blob` that already carries a
// `type` (canvas `toBlob` does). Allowed types: image/png,
// image/jpeg, image/webp. The version the thumbnail depicts and the
// branch it belongs to are read from the `Document` passed to
// `setThumbnail`, not supplied here, so the stored anchor always
// matches the state the app rendered.
export interface SetThumbnailInput {
  image: Blob | ArrayBuffer | Uint8Array;
  // Image MIME type. Optional only when `image` is a typed `Blob`.
  contentType?: string;
  // Optional intrinsic pixel dimensions, round-tripped so a renderer
  // can reserve layout space before the image loads.
  width?: number;
  height?: number;
}

// Options for `documents.getThumbnail`. With no options the call
// returns the document's current card thumbnail; pass `version` to
// fetch the thumbnail for a point in history (the newest one at or
// below that version).
export interface GetThumbnailOptions {
  version?: number;
  branch?: string;
}

// Wire shape returned by `POST /documents/:docId/checkpoints` and
// mirrored on `listDocumentVersions` markers with `kind: 'checkpoint'`.
// `created_by` / `created_at` are always present.
export interface DocumentCheckpoint {
  version: number;
  branch_id: string;
  created_by: string;
  created_at: string;
}

// Input to `documents.pushToDrive`. The optional `message` rides as
// the new drive version's commit message (and surfaces on the
// `drive.push.success` audit so operators investigating "what
// changed" can read it). Omitted means no message.
export interface PushToDriveInput {
  message?: string;
  // The file's bytes, for a document the platform has no writer for: its
  // own app serializes it. The SDK supplies these from the registered
  // serializer, so nothing an app calls has to.
  /** @internal */
  bytes?: Uint8Array;
}

// Outcome of a successful push.
export interface PushToDriveResult {
  // The new external ref (the drive's version id) the push produced.
  // Apps that surface "published as version X" use this. Empty when
  // `pending` is true (the importer has not produced the version yet).
  new_ref: string;
  // True when the drive's write is asynchronous: the bytes were
  // submitted and the drive's importer was queued, but the resulting
  // Version (and the re-synced baseline) is not known yet. This is the
  // file-roundtrip path (a doc imported from a drive file). The doc stays
  // `ahead` until the drive's change-event webhook confirms the import,
  // so an app should say "submitted, waiting for the importer" rather
  // than "published", and expect `driveStatus.publishing` to stay true
  // (with `canPush` false) until the confirmation lands. Absent / false means the push was
  // synchronous and the baseline already advanced (the doc is `synced`).
  pending?: boolean;
  // Entity count the push uploaded.
  entity_count: number;
  // ISO timestamp of the push.
  pushed_at: string;
}

export interface CreateBranchRequest {
  // The version on the source branch to fork from. Omit it to fork
  // from the branch's live head, which is the common case ("branch
  // the current state") and the only race-free one: the server
  // resolves the head atomically, so you never have to read and
  // pass a `current_seq` that is already stale by the time the
  // create lands. Provide a value only to fork from a specific
  // historical version.
  from_version?: number;
  // The branch to fork from. Omit to fork from the doc's default.
  from_branch_id?: string;
  // Optional display name. Defaults to "<source> copy" server-side.
  name?: string;
}

/** @internal What `documents.setRecords` is handed: the whole content of a document,
 *  in the order it should hold it. Each record is what a document holds: a
 *  stable key, the tag the record store calls `type`, and the body it calls
 *  `params`, which is the same value an app assigns when it writes a record
 *  through a handle. */
export type DocumentRecordSetInput = DocumentRecordStoreInput | DocumentStreamsInput;

/** A record store: the records, in order, under a schema version. */
export interface DocumentRecordStoreInput {
  records: Array<{ key: string; type: string; params: unknown }>;
  /** The schema version stamped on the document, which is what a reader
   *  checks its own expectations against. */
  schemaVersion: string;
  /** A format's own preamble, for records that came out of a file that has
   *  one. Omit it for records an app computed. */
  header?: Array<{ type: string; params: unknown }>;
}

/** Content by stream, in the shape an importer returns it: the document's
 *  own stream is `default`, and any other name is a stream an app opens with
 *  `doc.stream(name)`. */
export interface DocumentStreamsInput {
  streams: Record<string, ImportContent>;
}

/**
 * Which documents to list. The other fields narrow what `from` resolves to
 * and are AND-ed; a query naming no references lists no documents.
 *
 * The query is over the document, not over what is inside it: name, type,
 * project and date are answered from the listing itself, and a question
 * about records is asked of each document once it is open.
 */
export interface ListDocumentsQuery {
  // The references to resolve: what `Brass.chooseInputs()` handed you,
  // kept by your app. A folder reference keeps answering, so the platform
  // resolves it against what is filed there now.
  //
  // Name them on every call. Your app's permissions are not a question it
  // can ask: naming none answers with none, rather than with every document
  // anyone has ever opened with it.
  from?: readonly InputReference[];
  // Type tokens, matched against a document's own type or the type of the
  // file behind it, either of which names it: a file nobody has read yet
  // already carries the family its importer will stamp, and opening it is
  // what reads it.
  types?: string[];
  /** @internal */
  projectIds?: string[];
  /** @internal Case-insensitive substring of the document's name. */
  name?: string;
  /** @internal ISO-8601 bound on when the document last changed. */
  updatedAfter?: string;
  /** @internal */
  updatedBefore?: string;
  /** @internal At most this many, most recently worked on first. */
  limit?: number;
}

export interface DocumentListing {
  doc_id: string;
  // Internal fields are optional, because the published types strip them
  // and a value an app builds against those types carries neither.
  /** @internal */
  organization_id?: string;
  project_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
  // When a person last acted on the document.
  last_activity_at: string;
  /** @internal */
  owner_sub?: string;
  // The document's family, and the type of the file behind it. Both say
  // what the document IS: a file nothing has read yet already carries the
  // family its importer will stamp, so neither answers whether the content
  // has arrived. `doc.status` on the open document answers that.
  family?: string;
  file_type?: string;
  thumbnail?: DocumentThumbnail;
  // The folder or archive the document sits in, and its path inside it.
  member_of?: { doc_id: string; path: string };
  // Present while the platform has work in flight on the document (an import
  // it is running), and after work that failed. Absent otherwise, including
  // on a file nothing has opened yet.
  status?: DocumentWorkStatus;
  // Every entry of the listing's `from` that admits this document, nearest
  // first: the document itself where it was named, then the folders or
  // archives above it, nearest first, then its project, then its
  // organization. The same objects the query was given, so they compare by
  // identity.
  from?: InputReference[];
}

type DocumentListingWire = Omit<DocumentListing, 'family' | 'from'> & {
  schema_type?: string;
  refs?: string[];
};

type DocumentRecordWire = Omit<DocumentRecord, 'family'> & { schema_type?: string };

function listingFromWire(byToken: Map<string, InputReference>) {
  return ({ refs, schema_type, ...row }: DocumentListingWire): DocumentListing => ({
    ...row,
    ...(schema_type !== undefined ? { family: schema_type } : {}),
    ...(refs !== undefined ? { from: refs.flatMap((token) => byToken.get(token) ?? []) } : {}),
  });
}

export interface DocumentsNamespace {
  // Metadata read. Returns organization_id, project_id (or null), role,
  // members, name. Closes the cold-URL-restore gap (an app whose URL
  // carries a doc_id can resolve project + organization + role from
  // this one call before opening the editable Document via
  // `Brass.openDocumentById`). Creating / moving documents is done
  // through the hosted pickers + document-settings dialog, not this
  // namespace; the runtime create-and-open path is the top-level
  // `Brass.createDocument` / `Brass.openDocumentById`.
  get(docId: string): Promise<DocumentRecord>;
  /**
   * The documents the references in `query.from` resolve to, narrowed by
   * the rest of `query` and by what the signed-in person can see. Naming no
   * references lists no documents. `onChanged`
   * fires once when a document joins the set, leaves it, or changes.
   *
   * @internal The app-facing listing of a set is a key's input status
   * (`status.files`).
   */
  list(query?: ListDocumentsQuery): Promise<DocumentList>;
  // Upload a preview image for a document. Brass cannot render an
  // app's document body, so an app that wants a thumbnail on its
  // document cards renders one itself (e.g. `canvas.toBlob`) and
  // uploads it here. Pass the live `Document` the image was rendered
  // from: the SDK anchors the thumbnail to that document's exact
  // current version and branch, so the stored preview always matches
  // the state it depicts. The most recent upload becomes the
  // document's card thumbnail. Returns the stored thumbnail (with a
  // presigned `url`).
  setThumbnail(
    doc: Document,
    input: SetThumbnailInput,
  ): Promise<DocumentThumbnail>;
  /**
   * @internal
   * Give a document its whole content at once, as a record set.
   *
   * The other way to fill a document is to write its records through the
   * handles, one commit at a time, which is what builds a collaborative
   * document: each record arrives as an edit, and the history of those edits
   * is what makes it mergeable, undoable and versioned. A producer that
   * already holds the whole set, an app that parsed a file it understands or
   * computed a result, pays for that history and never uses it, and its
   * readers pay again to get the records back out.
   *
   * So this hands the set over. The document then opens faster, holds less,
   * and reads through exactly the same `Document`: an app reading it calls
   * what it always calls.
   *
   * Takes a record store, or content by stream in the shape an importer
   * returns. Legal only while the document has no content. Rejects otherwise,
   * because a record set carries no history and so cannot be written over one.
   */
  setRecords(docId: string, input: DocumentRecordSetInput): Promise<void>;
  // Read a document's thumbnail. With no options, returns the
  // document's current card thumbnail; pass `version` for the
  // thumbnail at a point in history. Resolves `null` when no
  // matching thumbnail exists.
  getThumbnail(
    docId: string,
    options?: GetThumbnailOptions,
  ): Promise<DocumentThumbnail | null>;
}

// Plumbing behind the per-`Document` surface (`doc.pushToDrive` /
// `doc.createCheckpoint`), the internal branch controller (list / create,
// which the toolbar branch command + hosted branch dialog drive), and the
// hosted history modal; not exposed on `Brass.documents`.
export interface DocumentsInternalNamespace {
  // `setThumbnail` at an explicit version: the picture a checkpoint took,
  // uploaded once the checkpoint's version is known.
  setThumbnailAt(
    doc: Document,
    input: SetThumbnailInput,
    version: number,
  ): Promise<DocumentThumbnail>;
  createCheckpoint(
    doc: Document,
    anchor?: CheckpointAnchor,
  ): Promise<DocumentCheckpoint>;
  listBranches(
    docId: string,
  ): Promise<{ default_branch_id: string; branches: BranchSummary[] }>;
  // Streams plumbing behind `doc.stream()` /
  // `doc.listStreams()`. A stream's `line_id` is what the SDK joins
  // (`?branch=<line_id>`) and subscribes (`doc:<docId>:<line_id>`).
  listStreams(
    docId: string,
    branchId: string,
  ): Promise<{ branch_id: string; streams: DocumentStreamInfo[] }>;
  createStream(
    docId: string,
    branchId: string,
    name: string,
  ): Promise<DocumentStreamInfo>;
  createBranch(
    docId: string,
    input: CreateBranchRequest,
  ): Promise<BranchSummary>;
  pushToDrive(
    doc: Document,
    input?: PushToDriveInput,
  ): Promise<PushToDriveResult>;
  // Fetch a presigned GET + descriptor for the file a document was uploaded
  // as, so an app that knows the format can download and parse it
  // in-browser. Rejects with a `BrassError` when the document holds no such
  // file or the caller cannot reach it (404). The per-doc instance method
  // `doc.sourceBlob()` routes through this.
  sourceBlob(doc: Document): Promise<DocumentSourceBlob>;
  // The input status behind `subscribeInputStatus`, one key's. Answers the
  // response body as the server sent it, or null for a 404 (a key with no row
  // yet, or a platform without the route).
  readInputKeyStatus(docId: string, key: string, query: Record<string, string>): Promise<unknown>;
  // Posts a key's provisional entry after the op carrying its change is
  // acknowledged. Never rejects: the document already holds the change, and
  // the platform projects it from there whatever this post answers.
  /** @internal */
  postProvisionalInputs(
    docId: string,
    post: ProvisionalInputsPost,
    opts?: { superseded?: () => boolean },
  ): Promise<ProvisionalInputsAnswer | null>;
  // The import-claim protocol behind `Brass.registerImporter`. The SDK
  // (never the app) claims the right to run the import of a stored
  // source file, and reports completion so the platform stamps the
  // document with the importing app's schema. Both reject with a
  // `BrassError` on the ineligible / claim-lost outcomes.
  claimImport(docId: string): Promise<ImportClaimResponse>;
  // Stage an import's encoded streams, as one bundle, for `completeImport`
  // to seal; answers the key the completion names it by.
  stageImport(docId: string, bundle: Uint8Array): Promise<string>;
  completeImport(
    docId: string,
    report: ImportReport | undefined,
    uploadKey: string,
  ): Promise<{ schema_ref: { app_id: string; schema_hash: string } }>;
  // Record that the claim holder's importer could not read the file.
  failImport(docId: string, message: string): Promise<ImportFailedResponse>;
}

interface DocumentsFactoryOptions {
  apiBaseUrl: string;
  getAccessToken: () => Promise<string | null>;
  getAppAssertion?: () => Promise<string | null>;
  getSocket?: () => DocumentSetSocket | undefined;
}

// A chosen reference as the `refs` query names it, and as a listing row names
// the reference it came from.
function refToken(ref: InputReference): string {
  return ref.extent === 'organization'
    ? `organization:${ref.organization_id}`
    : ref.extent === 'project'
      ? `project:${ref.project_id}`
      : `document:${ref.doc_id}`;
}

// How long a provisional inputs post waits before trying again, or null to
// give up. A 409 names an op that has not landed on its line yet, which it
// does within moments; a 429 asks for fewer requests; a 5xx is a write that
// applied nothing (other writers held the line), jittered so a commit's posts
// do not meet again. Anything else is final.
const PROVISIONAL_NOT_LANDED_DELAYS_MS = [500, 1000, 2000, 4000];
const PROVISIONAL_RATE_LIMITED_DELAYS_MS = [5000, 15000];
const PROVISIONAL_UNAVAILABLE_DELAYS_MS = [1000, 3000, 9000];

export function provisionalRetryDelayMs(
  status: number | undefined,
  attempt: number,
  random: () => number = Math.random,
): number | null {
  if (status !== undefined && status >= 500 && status <= 504) {
    const base = PROVISIONAL_UNAVAILABLE_DELAYS_MS[attempt];
    return base === undefined ? null : Math.round(base * (0.5 + random()));
  }
  const delays =
    status === 409
      ? PROVISIONAL_NOT_LANDED_DELAYS_MS
      : status === 429
        ? PROVISIONAL_RATE_LIMITED_DELAYS_MS
        : [];
  return delays[attempt] ?? null;
}

let inputsRouteMissingNoted = false;

// A platform without the provisional inputs route still records a key from
// the document when it compacts, so the post's absence delays the status
// rather than losing anything. Said once per page.
function noteInputsRouteMissing(): void {
  if (inputsRouteMissingNoted) return;
  inputsRouteMissingNoted = true;
  console.info(
    'Brass: this platform does not take provisional input posts yet, so input status updates after the document compacts.',
  );
}

/** How many single `documents.get` requests one client has in flight at once. */
const GET_CONCURRENCY = 6;
/** How many batched `documents.get` requests (20 ids each) one client has in
 *  flight at once. */
const BATCH_CONCURRENCY = 5;
/** Attempts a queued `get` makes against a throttled API (about 9 s of
 *  backoff). The API's request budget is shared by every caller, so a get
 *  queued behind a burst can meet a refusal that clears within seconds. */
const GET_ATTEMPTS = 6;

export function createDocumentsNamespace(
  opts: DocumentsFactoryOptions,
): DocumentsNamespace & DocumentsInternalNamespace {
  const apiFetch = createApiFetch(opts);
  // Identifies THIS client to the import claim, so two tabs of one app
  // signed in as one user are two claimants and only one of them imports.
  // Minted once per namespace, so re-claiming from this client refreshes
  // its own claim rather than taking a second one.
  const importClientId = randomToken();
  // An app that shows something about each of several hundred documents
  // calls `get` once per document, usually all at once. Sent one request each,
  // those calls spend the API's request budget for this app's other calls
  // (its opens) and every other caller's, so they are batched, and reads sent
  // on their own queue.
  const getLane = createRequestLane(GET_CONCURRENCY);
  const singleGet = (docId: string): Promise<DocumentRecordWire> =>
    getLane.run(docId, () =>
      apiFetch<DocumentRecordWire>({
        path: `/documents/${encodeURIComponent(docId)}`,
        maxAttempts: GET_ATTEMPTS,
      }),
    );
  const batchedGet = createBatchedGet<DocumentRecordWire>({
    apiFetch,
    lane: createRequestLane(BATCH_CONCURRENCY),
    single: singleGet,
    maxAttempts: GET_ATTEMPTS,
  });
  const readSeal =
    (docId: string) =>
    (sealId: string): Promise<SealStatus> =>
      apiFetch<SealStatus>({
        path: `/documents/${encodeURIComponent(docId)}/seals/${encodeURIComponent(sealId)}`,
      });

  const putThumbnail = async (
    doc: Document,
    input: SetThumbnailInput,
    version: number | null,
  ): Promise<DocumentThumbnail> => {
    const docId = doc.id;
    if (docId === null) {
      throw new BrassError(
        'setThumbnail requires a Document opened from the server',
        { status: 400 },
      );
    }
    if (version === null) {
      throw new BrassError(
        'setThumbnail: the document has no resolved version yet',
        { status: 400 },
      );
    }
    const branchId = doc.branchId;
    const { data, contentType } = await encodeThumbnailImage(input);
    const body: {
      content_type: string;
      data: string;
      version: number;
      branch_id?: string;
      width?: number;
      height?: number;
    } = { content_type: contentType, data, version };
    if (branchId !== null) body.branch_id = branchId;
    if (input.width !== undefined) body.width = input.width;
    if (input.height !== undefined) body.height = input.height;
    const res = await apiFetch<{ thumbnail: DocumentThumbnail }>({
      method: 'POST',
      path: `/documents/${encodeURIComponent(docId)}/thumbnail`,
      body,
    });
    return res.thumbnail;
  };

  const namespace: DocumentsNamespace & DocumentsInternalNamespace = {
    get(docId) {
      return batchedGet(docId).then(({ schema_type, ...record }) => ({
        ...record,
        ...(schema_type !== undefined ? { family: schema_type } : {}),
      }));
    },
    async list(query) {
      const params = new URLSearchParams();
      if (query?.from?.length) {
        params.set(
          'refs',
          JSON.stringify(
            query.from.map((ref) => ({
              ref: refToken(ref),
              ...(ref.accept !== undefined ? { accept: ref.accept } : {}),
            })),
          ),
        );
      }
      if (query?.types?.length) params.set('type', query.types.join(','));
      if (query?.projectIds?.length) params.set('project_id', query.projectIds.join(','));
      if (query?.name) params.set('name', query.name);
      if (query?.updatedAfter) params.set('updated_after', query.updatedAfter);
      if (query?.updatedBefore) params.set('updated_before', query.updatedBefore);
      if (query?.limit !== undefined) params.set('limit', String(query.limit));
      const search = params.toString();
      const result = await apiFetch<{ documents: DocumentListingWire[] }>({
        path: search ? `/documents?${search}` : '/documents',
      });
      const byToken = new Map((query?.from ?? []).map((ref) => [refToken(ref), ref]));
      const documents = result.documents.map(listingFromWire(byToken));
      return createDocumentList({
        documents,
        query: query ?? {},
        list: async (q) => (await namespace.list(q)).documents,
        socket: opts.getSocket?.(),
      });
    },
    listBranches(docId) {
      return apiFetch<{ default_branch_id: string; branches: BranchSummary[] }>({
        path: `/documents/${encodeURIComponent(docId)}/branches`,
      });
    },
    listStreams(docId, branchId) {
      return apiFetch<{ branch_id: string; streams: DocumentStreamInfo[] }>({
        path: `/documents/${encodeURIComponent(docId)}/streams?branch=${encodeURIComponent(branchId)}`,
      });
    },
    async setRecords(docId, input) {
      // Encoded on the client, by the encoder an importer's result goes
      // through, and staged as one bundle, so the platform seals it exactly
      // as it seals an import. What reaches the network is the stored form's
      // tables rather than a JSON rendering of them, which is several times
      // larger.
      const { encodeSealedRecordsUpload } = await import('./sealed-encode.js');
      const streams =
        'streams' in input
          ? await encodeImportStreams({ streams: input.streams })
          : [
              {
                name: DEFAULT_IMPORT_STREAM,
                bytes: await encodeSealedRecordsUpload({
                  schemaVersion: input.schemaVersion,
                  header: (input.header ?? []).map((entry) => ({
                    tag: entry.type,
                    body: entry.params,
                  })),
                  records: input.records.map(
                    (record): PackedRecord<unknown> => [
                      record.key,
                      record.type,
                      record.params,
                    ],
                  ),
                }),
              },
            ];
      if (streams.length === 0) {
        throw new BrassError('There is nothing to set: every stream is empty', {
          status: 400,
        });
      }
      const bytes = encodeStreamBundle(streams);
      const staged = await apiFetch<{ upload_key: string; url: string }>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/records/upload`,
        body: { byte_size: bytes.byteLength },
      });
      // A presigned PUT carries no Brass headers: the signature is the
      // credential, and a stray header breaks it.
      // The view's own buffer rather than the view: a `Uint8Array` over a
      // larger buffer would send the whole of it, and `fetch` takes the
      // buffer type directly.
      const put = await fetch(staged.url, {
        method: 'PUT',
        body: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      });
      if (!put.ok) {
        throw new BrassError('Uploading the record set failed', {
          status: put.status,
        });
      }
      // The platform answers once the set is queued; the call resolves when
      // it is stored, and rejects with the platform's refusal if it is not.
      const accepted = await apiFetch<unknown>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/records`,
        body: { upload_key: staged.upload_key },
      });
      await awaitSeal(accepted, readSeal(docId));
    },
    createStream(docId, branchId, name) {
      return apiFetch<DocumentStreamInfo>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/streams`,
        body: {
          name,
          branch_id: branchId,
        },
      });
    },
    createBranch(docId, input) {
      const body: CreateBranchRequest = {};
      if (input.from_version !== undefined) {
        body.from_version = input.from_version;
      }
      if (input.from_branch_id !== undefined) {
        body.from_branch_id = input.from_branch_id;
      }
      if (input.name !== undefined) body.name = input.name;
      return apiFetch<BranchSummary>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/branches`,
        body,
      });
    },
    async setThumbnail(doc, input) {
      // Capture the depicted version synchronously, before the async
      // encode, so a concurrent editor's op landing mid-upload cannot
      // shift the anchor away from the state the app rendered.
      return putThumbnail(doc, input, doc.currentSeq);
    },
    async setThumbnailAt(doc, input, version) {
      return putThumbnail(doc, input, version);
    },
    async createCheckpoint(doc, anchor) {
      const docId = doc.id;
      if (docId === null) {
        throw new BrassError(
          'createCheckpoint requires a Document opened from the server',
          { status: 400 },
        );
      }
      // The scheduler passes the seq it read once every local op was acked,
      // so the marker holds the state of the calls it covers. Without one,
      // the depicted version is read here, synchronously, so an op landing
      // mid-call cannot shift the anchor.
      const version = anchor?.version ?? doc.currentSeq;
      if (version === null) {
        throw new BrassError(
          'createCheckpoint: the document has no resolved version yet',
          { status: 400 },
        );
      }
      const branchId = doc.branchId;
      const body: {
        version: number;
        branch_id?: string;
      } = { version };
      if (branchId !== null) body.branch_id = branchId;
      const res = await apiFetch<{ checkpoint: DocumentCheckpoint }>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/checkpoints`,
        body,
      });
      return res.checkpoint;
    },
    async pushToDrive(doc, input) {
      const docId = doc.id;
      if (docId === null) {
        throw new BrassError(
          'pushToDrive requires a Document opened from the server',
          { status: 400 },
        );
      }
      const body: {
        message?: string;
        content_base64?: string;
      } = {};
      if (input?.message !== undefined) body.message = input.message;
      if (input?.bytes !== undefined) {
        body.content_base64 = bytesToBase64(input.bytes);
      }
      const res = await apiFetch<PushToDriveResult>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/drive-sync/push`,
        body,
      });
      return res;
    },
    async sourceBlob(doc) {
      const docId = doc.id;
      if (docId === null) {
        throw new BrassError(
          'sourceBlob requires a Document opened from the server',
          { status: 400 },
        );
      }
      return apiFetch<DocumentSourceBlob>({
        path: `/documents/${encodeURIComponent(docId)}/source-blob`,
      });
    },
    async postProvisionalInputs(docId, { key, body }, opts = {}) {
      const path = `/documents/${encodeURIComponent(docId)}/inputs/${encodeURIComponent(key)}`;
      for (let attempt = 0; ; attempt += 1) {
        let status: number | undefined;
        try {
          return parseProvisionalInputsAnswer(await apiFetch<unknown>({ method: 'POST', path, body }));
        } catch (err) {
          status = err instanceof BrassError ? err.status : undefined;
        }
        if (status === 404) {
          noteInputsRouteMissing();
          return null;
        }
        const delay = provisionalRetryDelayMs(status, attempt);
        if (delay === null || opts.superseded?.() === true) return null;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (opts.superseded?.() === true) return null;
      }
    },
    readInputKeyStatus(docId, key, query) {
      const search = new URLSearchParams(query).toString();
      const path = `/documents/${encodeURIComponent(docId)}/inputs/${encodeURIComponent(key)}`;
      return orNullOn404(apiFetch<unknown>({ path: search ? `${path}?${search}` : path }));
    },
    claimImport(docId) {
      return apiFetch<ImportClaimResponse>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/import-claim`,
        body: { client_id: importClientId, stages: true },
      });
    },
    async stageImport(docId, bundle) {
      const staged = await apiFetch<{ upload_key: string; url: string }>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/import-complete/upload`,
        body: { byte_size: bundle.byteLength },
      });
      // A presigned PUT carries no Brass headers: the signature is the
      // credential, and a stray header breaks it.
      const put = await fetch(staged.url, {
        method: 'PUT',
        body: bundle.buffer.slice(
          bundle.byteOffset,
          bundle.byteOffset + bundle.byteLength,
        ) as ArrayBuffer,
      });
      if (!put.ok) {
        throw new BrassError('Uploading the import failed', {
          status: put.status,
        });
      }
      return staged.upload_key;
    },
    async completeImport(docId, report, uploadKey) {
      const accepted = await apiFetch<unknown>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/import-complete`,
        body: {
          client_id: importClientId,
          ...(report !== undefined ? { report } : {}),
          upload_key: uploadKey,
        },
      });
      return awaitSeal<{ schema_ref: { app_id: string; schema_hash: string } }>(
        accepted,
        readSeal(docId),
      );
    },
    failImport(docId, message) {
      return apiFetch<ImportFailedResponse>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/import-failed`,
        body: { client_id: importClientId, message },
      });
    },
    async getThumbnail(docId, options) {
      const params = new URLSearchParams();
      if (options?.version !== undefined) {
        params.set('version', String(options.version));
      }
      if (options?.branch !== undefined) params.set('branch', options.branch);
      const qs = params.toString();
      const res = await apiFetch<{ thumbnail: DocumentThumbnail | null }>({
        path: `/documents/${encodeURIComponent(docId)}/thumbnail${
          qs ? `?${qs}` : ''
        }`,
      });
      return res.thumbnail;
    },
  };
  return namespace;
}

export function randomToken(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// Reads `SetThumbnailInput.image` into base64 plus a resolved MIME
// type. A `Blob` carries its own `type` (canvas `toBlob` sets it);
// raw `ArrayBuffer` / `Uint8Array` bytes need an explicit
// `contentType`.
async function encodeThumbnailImage(
  input: SetThumbnailInput,
): Promise<{ data: string; contentType: string }> {
  let bytes: Uint8Array;
  let blobType: string | undefined;
  if (input.image instanceof Uint8Array) {
    bytes = input.image;
  } else if (input.image instanceof ArrayBuffer) {
    bytes = new Uint8Array(input.image);
  } else {
    bytes = new Uint8Array(await input.image.arrayBuffer());
    blobType = input.image.type || undefined;
  }
  const contentType = input.contentType ?? blobType;
  if (!contentType) {
    throw new BrassError(
      'setThumbnail: contentType is required when image is not a typed Blob',
      { status: 400 },
    );
  }
  return { data: bytesToBase64(bytes), contentType };
}

// Standard-alphabet base64 of a byte array. Chunked so a large image
// does not blow the argument-count limit on `String.fromCharCode`.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function orNullOn404(request: Promise<unknown>): Promise<unknown> {
  try {
    return await request;
  } catch (err) {
    if (err instanceof BrassError && err.status === 404) return null;
    throw err;
  }
}
