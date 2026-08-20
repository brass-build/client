// SDK surface: `Brass.documents.*`. The metadata surface: get /
// thumbnails. The editable surface (snapshot + ops + mutate) is the
// `Document` runtime class via `Brass.openDocumentById` /
// `Brass.createDocument`. Access-granting is hosted-only (the share
// dialog), not a programmatic method here.

import type { Document } from './documents.js';
import type { ImportClaimResponse } from './importer.js';
import { createApiFetch } from './api-fetch.js';
import { BrassError } from './errors.js';

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

// One byte stream of the original file behind an opaque-blob document. A
// source file is a set of one or more streams: the primary stream (what
// the file's own name names) plus any sidecar streams uploaded with it (a
// glTF's `.bin` buffer, a shapefile's `.dbf`). Each stream carries its own
// short-lived download URL, so an app fetches exactly the streams it
// needs, in parallel.
export interface DocumentSourceStream {
  // The stream's name within the file set (the primary stream's is the
  // file's own name).
  name: string;
  url: string;
  content_type: string;
  byte_size: number;
}

// The original file behind an opaque-blob document, returned by
// `doc.sourceBlob()`. `url` is a short-lived presigned GET the app
// fetches the raw bytes from (the bytes are not inlined: a real source
// file routinely exceeds the API response cap); the descriptor fields let
// the app decide whether it handles this format before downloading.
// `streams` lists every stream of the file set, primary first (its entry
// mirrors the top-level fields): a single-stream file has exactly one
// entry, so an app that iterates `streams` handles single- and
// multi-stream files with one code path.
export interface DocumentSourceBlob {
  url: string;
  filename: string;
  content_type: string;
  byte_size: number;
  expires_in: number;
  streams: DocumentSourceStream[];
}

export interface DocumentRecord extends DocumentSummary {
  // The caller's effective role on this document, resolved via the
  // scope-loop on the server.
  role: DocumentRole;
  members: DocumentMember[];
  app_metadata?: Record<string, unknown>;
  // Server-authored, opaque label for where the document lives, rendered
  // verbatim by the toolbar's location chip (the project's name when filed,
  // null when loose). The SDK never composes location from `project_id` /
  // `organization_id`, so the hierarchy above the document can evolve
  // (folders / teams) without a client change.
  location_label: string | null;
  // Whether anything can produce a file from this document. The server
  // resolves who would write it, so a newly exportable format needs no
  // client change.
  downloadable: boolean;
}

// One stream of a document: a named, independently-loadable CRDT unit
// (`doc.stream(name)` opens exactly the streams an app touches, so open
// cost scales with what is used, not the whole document). `line_id`
// identifies the stream's underlying CRDT line; apps only need `name`.
export interface DocumentStreamInfo {
  name: string;
  // The stream's format. `doc.stream()` opens `'crdt'` entries, the
  // editable collaborative unit, and rejects any other value loudly, so a
  // format the platform adds later cannot be half-opened by this SDK.
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
  // than "published", and expect `driveStatus` to stay `canPush` until
  // the confirmation lands. Absent / false means the push was
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

export interface DocumentsNamespace {
  // Metadata read. Returns organization_id, project_id (or null), role,
  // members, name. Closes the cold-URL-restore gap (an app whose URL
  // carries a doc_id can resolve project + organization + role from
  // this one call before opening the editable Document via
  // `Brass.openDocumentById`). Creating / moving / listing documents is
  // done through the hosted pickers + document-settings dialog, not
  // this namespace; the runtime create-and-open path is the top-level
  // `Brass.createDocument` / `Brass.openDocumentById`.
  get(docId: string): Promise<DocumentRecord>;
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
  createCheckpoint(doc: Document): Promise<DocumentCheckpoint>;
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
  // The import-claim protocol behind `Brass.registerImporter`. The SDK
  // (never the app) claims the right to run the import of a stored
  // source file, and reports completion so the platform stamps the
  // document with the importing app's schema. Both reject with a
  // `BrassError` on the ineligible / claim-lost outcomes.
  claimImport(docId: string): Promise<ImportClaimResponse>;
  completeImport(
    docId: string,
  ): Promise<{ schema_ref: { app_id: string; schema_hash: string } }>;
}

interface DocumentsFactoryOptions {
  apiBaseUrl: string;
  getAccessToken: () => Promise<string | null>;
  getAppAssertion?: () => Promise<string | null>;
}

export function createDocumentsNamespace(
  opts: DocumentsFactoryOptions,
): DocumentsNamespace & DocumentsInternalNamespace {
  const apiFetch = createApiFetch(opts);
  // Identifies THIS client to the import claim, so two tabs of one app
  // signed in as one user are two claimants and only one of them imports.
  // Minted once per namespace, so re-claiming from this client refreshes
  // its own claim rather than taking a second one.
  const importClientId = randomToken();

  return {
    get(docId) {
      return apiFetch<DocumentRecord>({
        path: `/documents/${encodeURIComponent(docId)}`,
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
      const docId = doc.id;
      if (docId === null) {
        throw new BrassError(
          'setThumbnail requires a Document opened from the server',
          { status: 400 },
        );
      }
      // Capture the depicted version synchronously, before the async
      // encode, so a concurrent editor's op landing mid-upload cannot
      // shift the anchor away from the state the app rendered.
      const version = doc.currentSeq;
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
    },
    async createCheckpoint(doc) {
      const docId = doc.id;
      if (docId === null) {
        throw new BrassError(
          'createCheckpoint requires a Document opened from the server',
          { status: 400 },
        );
      }
      // Capture the depicted version synchronously, so a concurrent
      // editor's op landing mid-call cannot shift the anchor away
      // from the state the user is on. Mirrors the setThumbnail
      // version-capture pattern. This is the anchor the server pins
      // the checkpoint to; it is not an app-facing "seal a past
      // version" control.
      const version = doc.currentSeq;
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
    claimImport(docId) {
      return apiFetch<ImportClaimResponse>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/import-claim`,
        body: { client_id: importClientId },
      });
    },
    completeImport(docId) {
      return apiFetch<{ schema_ref: { app_id: string; schema_hash: string } }>({
        method: 'POST',
        path: `/documents/${encodeURIComponent(docId)}/import-complete`,
        body: { client_id: importClientId },
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
}

function randomToken(): string {
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
