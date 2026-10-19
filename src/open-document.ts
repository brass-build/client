// SDK `Brass.openDocumentById(id, options?)`: the editable join path.
//
// Cold-load contract: `Document.openFromSnapshot` must stay within 2x of
// raw Loro import at 50k entities, so the materialisation path adds no
// full-snapshot logging or deep cloning of decoded bytes.

import { awaitSeal, type SealStatus } from './staged-seal.js';
import {
  DEFAULT_STREAM_NAME,
  Document,
  type BranchProvider,
  type DocumentOptions,
  type DocumentWorkStatus,
  type DocumentDriveStatus,
  type DrivePublishTarget,
  type DocumentDriveTrackingState,
  type DriveMirrorDirection,
  type HostedUiProvider,
  type ForcedReadOnlyReason,
  type ResyncPushOutcome,
  type CheckoutFetcher,
} from './documents.js';
import { ensureWasmReady } from './wasm-runtime.js';
import { createPresenceController } from './presence.js';
import type { WsTopicCallback } from './ws-client.js';
import { applyAppAssertionHeader, applyClientVersionHeader } from './api-headers.js';
import { brassErrorFromBody } from './api-fetch.js';
import type { SelectDocumentResult } from './hosted-ui.js';
import type { ImportReport } from './import-report.js';
import type { ImportClaimResponse, ImportFailedResponse } from './importer.js';
import { randomToken, type DocumentSourceBlob } from './documents-namespace.js';
import {
  fetchWithRetry,
  RETRY_IDEMPOTENT_WRITE,
  RETRY_WRITE_503,
} from './fetch-retry.js';
import {
  deadlineForUpload,
  fetchWithDeadline,
  OP_WRITE_TIMEOUT_MS,
} from './fetch-deadline.js';
import type { DocSyncDiagnostics } from './types.js';

// Why a client is reporting its sync health. Mirrors the server's
// `CLIENT_REPORT_REASONS`; the published SDK cannot import the workspace
// contracts package, so the values are restated here and the server refuses
// any it does not recognise.
type ClientReportReason =
  | 'op_stuck'
  | 'reconnected_unsaved'
  | 'divergence_healed';
import { BrassError } from './errors.js';
import { perfStart } from './perf.js';
import { SealedContent } from './sealed-store.js';
import { joinCoverageFloor, snapshotSeqOf } from './join-coverage.js';
import { parseInputStatusNudge } from './inputs.js';
import { TEMPORARY_INPUTS_RUNTIME, type InputsStatusRuntime } from './inputs-status.js';
import { setJoinStamp } from './join-stamp.js';
import { storeClaimSecret } from './guest-link.js';
import {
  base64ToBytes,
  decodeJoinContent,
  joinEncoding,
  type ContentFetch,
  type JoinContent,
} from './join-content.js';
import { declaredTailBytes, resolveTailOps, type WireTailOp } from './tail-ops.js';
import { SEALED_ACCEPT } from './sealed-store.js';
import {
  opBlobExceedsDurableLimit,
  opBlobNeedsStaging,
  opFrameExceedsWsLimit,
  type OpFrame,
} from './ws-frame-limit.js';

export interface OpenDocumentByIdOptions {
  // Forwarded to `Document.openFromSnapshot` / `Document.create`; overrides
  // the root-map key for a doc created against a non-default rootKey.
  documentOptions?: DocumentOptions;
  /**
   * Reserved for future server-side filtering; v1 servers ignore it. Still
   * serialised onto the query string so the request shape is
   * forward-compatible.
   * @internal
   */
  filter?: Record<string, unknown>;
  /**
   * Carry past the server's schema-conflict refusal. The platform refuses to
   * join a document this app's declared schema cannot read, so that a
   * bookmark or a reload does not silently open one; this says the refusal
   * has already been answered. Set by the client after a person answers its
   * dialog.
   * @internal
   */
  acceptSchemaConflict?: boolean;
  /**
   * The branch to open; omitting opens the doc's default branch. Branch
   * selection is hosted chrome (the `branches` command / `?branch=` URL,
   * which the session restores through this); an app names no branch, so
   * this is internal.
   * @internal
   */
  branch?: string;
  /**
   * Which stream of the document to open. The returned Document's own
   * handles (`doc.map(...)`) read that stream, so an app that works in one
   * part of a partitioned document downloads only that part. Defaults to
   * `'default'`, the stream every document has.
   */
  stream?: string;
  /**
   * Open at a historical version: the returned Document is read-only with no
   * live subscription. Version navigation is hosted chrome (the `history`
   * command drives it), so an app never opens a version itself.
   * @internal
   */
  version?: number;
  /**
   * Open a live copy with nothing on it that writes: it follows other
   * people's edits, and `mutate` throws. `false` opens to write whatever
   * `documentOptions.readOnly` says. Unset, `documentOptions.readOnly`
   * decides.
   */
  readOnly?: boolean;
  /**
   * Open a read-only copy that changes only when the app asks: it reports
   * that the document moved (`onChanged`) and holds what it loaded
   * until `reload()`. Implies `readOnly`.
   */
  frozen?: boolean;
  /**
   * SDK-internal load-progress sink. The session threads it through to
   * surface a progress state before the Document exists; apps read that via
   * `Brass.session`, never this.
   *
   * Both phases count BYTES, so a reader watching a load sees one figure
   * rather than two bars filling in turn. `phase` says which stretch is on
   * the wire, because the two are paced by different things and a document
   * can spend the whole of the first in what looks like silence: `tail` is
   * the spilled ops the join fetches, `snapshot` the snapshot itself, and
   * absent means `snapshot`. `preparing` reports no bytes: the platform is
   * making the document editable, and the open is waiting for it. `importing`
   * reports no bytes either: a reader's open is waiting for work that replaces
   * the content (a new version of the file being read), and `message` is the
   * platform's own words for it. Answering `false` to either says nobody wants
   * this open any more, and the open rejects rather than going on waiting.
   *
   * `total` is the whole download in both phases. The tail declares it from
   * each spilled op's own size plus the snapshot still to come, so the
   * percentage runs across the pair; the snapshot phase reports only its own
   * (the decompressed size from `x-amz-meta-raw-bytes`, or null), and the
   * session adds the tail back.
   * @internal
   */
  onSnapshotProgress?: LoadProgress;
}

/**
 * What a load reports as it runs. See `onSnapshotProgress` for the phases.
 * @internal
 */
export type LoadProgress = (
  loaded: number,
  total: number | null,
  phase?: 'snapshot' | 'tail' | 'preparing' | 'importing',
  message?: string,
) => void | boolean;

// `Brass.createDocument(options?)` creates a new document and returns it
// fully editable. `name` defaults to "Untitled". Placement is resolved from
// context rather than named here (see `CreateDocumentArgs`): a caller who
// belongs to one organization lands there, and a caller who belongs to
// several is asked, so this shape carries no organization or project.
export interface CreateDocumentOptions {
  name?: string;
  // Snake_case because the SDK relays this object to `POST /documents`
  // verbatim and `Brass.documents.get` hands it back under the same key, so
  // the key an app writes is the key it reads. The camelCase sibling below
  // never leaves the process, which is why the two conventions sit together.
  app_metadata?: Record<string, unknown>;
  // Forwarded to `Document.openFromSnapshot` / `Document.create`; overrides
  // the root-map key for a doc created against a non-default rootKey.
  documentOptions?: DocumentOptions;
}

// Internal create inputs. Placement is expressed by CONTEXT, never by an
// org / project the caller names: `siblingOf` anchors the new doc to an
// existing one (the session's active doc), `destination` is the opaque
// blob the hosted picker returned and is relayed verbatim (never
// destructured, so the hierarchy shape can change server-side without an
// SDK change). Neither present = let the server resolve the caller's
// single membership.
export interface CreateDocumentArgs {
  name?: string;
  app_metadata?: Record<string, unknown>;
  documentOptions?: DocumentOptions;
  siblingOf?: string;
  destination?: unknown;
}

// The server could not resolve a destination on its own: the caller
// belongs to more than one organization (open the hosted picker) or to
// none (open the acquire-organization surface). The SDK reacts to these;
// an app never sees them.
export type CreateDocumentResult =
  | { kind: 'created'; docId: string }
  | { kind: 'needs-destination' }
  | { kind: 'needs-organization' };

// What `POST /anonymous-documents` minted: the document, the editor link
// token that is its only credential, when the platform removes it, and the
// secret that claims it on a sign-in in this browser.
export interface MintedAnonymousDocument {
  docId: string;
  linkToken: string;
  expiresAt: Date;
  claimSecret?: string;
}

// The file types a visitor can start a document from, as an `<input
// accept>` value (`''` when there are none), and the largest file taken.
export interface AnonymousUploadAccept {
  accept: string;
  maxBytes: number;
}

// The app's upload-types read: whether the app starts new documents at all,
// and either the file types a visitor can start one from or the app's
// refusal of signed-out use.
export type AnonymousUploadTypes =
  | { offersNew: boolean; accept: AnonymousUploadAccept }
  | { offersNew: boolean; refusal: BrassError };

export function acceptFromUploadTypes(body: unknown): AnonymousUploadAccept {
  const wire = body as
    | {
        import_types?: { extensions?: unknown; content_types?: unknown }[];
        max_bytes?: unknown;
      }
    | undefined;
  const tokens = new Set<string>();
  for (const type of Array.isArray(wire?.import_types) ? wire.import_types : []) {
    for (const list of [type.extensions, type.content_types]) {
      if (!Array.isArray(list)) continue;
      for (const token of list) if (typeof token === 'string' && token !== '') tokens.add(token);
    }
  }
  return {
    accept: [...tokens].join(','),
    maxBytes: typeof wire?.max_bytes === 'number' ? wire.max_bytes : Number.POSITIVE_INFINITY,
  };
}

function parseMintedAnonymousDocument(parsed: unknown): MintedAnonymousDocument {
  const minted = parsed as {
    doc_id?: unknown;
    link_token?: unknown;
    claim_secret?: unknown;
    expires_at?: unknown;
  } | undefined;
  const expiresAt =
    typeof minted?.expires_at === 'string' ? new Date(minted.expires_at) : null;
  if (
    typeof minted?.doc_id !== 'string' ||
    typeof minted.link_token !== 'string' ||
    expiresAt === null ||
    Number.isNaN(expiresAt.getTime())
  ) {
    throw new BrassError('Malformed anonymous document response', { status: 500 });
  }
  return {
    docId: minted.doc_id,
    linkToken: minted.link_token,
    expiresAt,
    ...(typeof minted.claim_secret === 'string' ? { claimSecret: minted.claim_secret } : {}),
  };
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

// PUT a file to a presigned URL. Through XHR where there is one, which is
// the browser API that reports upload progress.
function putFile(
  url: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const failed = (status: number) =>
    new BrassError('The file could not be uploaded.', { status: status || 503 });
  if (typeof XMLHttpRequest === 'undefined') {
    return fetch(url, { method: 'PUT', body: file }).then((r) => {
      if (!r.ok) throw failed(r.status);
    });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(failed(xhr.status)));
    xhr.onerror = () => reject(failed(0));
    xhr.send(file);
  });
}

export interface GuestImportCalls {
  claimImport(): Promise<ImportClaimResponse>;
  stageImport(bundle: Uint8Array): Promise<string>;
  completeImport(report: ImportReport | undefined, uploadKey: string): Promise<unknown>;
  failImport(message: string): Promise<ImportFailedResponse>;
  sourceBlob(): Promise<DocumentSourceBlob>;
}

export interface ClaimAnonymousDocumentArgs {
  linkToken: string;
  claimSecret: string;
  // The hosted picker's opaque destination, relayed verbatim like a create's.
  destination?: unknown;
  // The name the person settled on in the destination dialog.
  name?: string;
}

// The claim's outcome, classified the way a create's is so the same
// placement loop runs over it. `record` is the claimed document as the
// server answered it, in the picker's shape, so the claim can be stashed as
// a selection; null when the answer did not carry the fields.
export type ClaimDocumentResult =
  | { kind: 'claimed'; record: SelectDocumentResult | null }
  | { kind: 'needs-destination' }
  | { kind: 'needs-organization' };

// Wire-protocol-pinned response shape from
// `GET /documents/{docId}?include=snapshot`.
export interface DocumentSnapshotResponse {
  doc_id: string;
  // The LINE this snapshot was materialized from; the SDK subscribes on
  // `doc:<doc_id>:<branch_id>`. Always present. When the open named a
  // stream, this is that stream's line rather than the branch itself.
  branch_id: string;
  // The BRANCH the opened stream hangs off, present only when it differs
  // from `branch_id`. The stream manifest belongs to a branch, so
  // `doc.stream(...)` binds to this.
  stream_branch_id?: string;
  // `inline` carries base64 bytes; `presigned` is a signed URL the
  // client GETs directly; `null` means no snapshot yet (empty new doc).
  // `sealed` is SEALED CONTENT rather than a snapshot: the document's
  // records as they were produced, which this reader decodes with no CRDT
  // engine. Always a URL, never inline.
  snapshot:
    | { kind: 'inline'; data_b64: string }
    | { kind: 'presigned'; url: string }
    | { kind: 'sealed'; url: string }
    | null;
  // Tail ops since the last snapshot, seq ascending, each a base64 Loro op
  // blob. Applied in order; `applyRemoteOp` is idempotent.
  tail_ops: Array<{ seq: number; op_blob_b64: string }>;
  // The branch's seq counter at join time: the highest seq the document
  // has handed out. Not the same as the highest seq this response carries,
  // because a seq is allocated before its op row is written, so a join read
  // during a bulk write names seqs whose rows it could not see. Pair it with
  // `snapshot_seq` to work out what was delivered. Optional (older fixtures
  // omit it).
  current_seq?: number;
  // The seq the snapshot was sealed at: everything at or below it is inside
  // `snapshot`, and `tail_ops` carries the rows above it. Optional (older
  // servers and fixtures omit it).
  snapshot_seq?: number;
  // Base64 version vector of the persisted snapshot (durability-handshake
  // ground truth). The handshake runs off the `doc_init` frame's copy; this
  // is carried for wire parallelism. Absent until the branch is compacted.
  snapshot_version_vector?: string;
  // The seq the line's current import was sealed at (`importSeqMoved`).
  import_seq?: number;
  // True while the document is its stored file and no import has run on it:
  // an importer claiming it will replace this (empty) content, so a client
  // with one holds the document before the claim answers.
  awaits_import?: boolean;
  // Why `can_edit` is false when the grant itself would allow writing.
  read_only_reason?: string;
  // Whether the caller may write to this document, as the server's own
  // write gate answers it. `false` opens the Document read-only, so
  // `doc.readOnly` covers a view-only grant at bind time rather than
  // leaving the app to discover it from a refused op. Optional: a server
  // that does not send it is one whose refusals the transport still
  // catches, so its absence opens the document editable as before.
  can_edit?: boolean;
  // Opaque status of slow server-side work (e.g. a drive stub hydrating on
  // first open, with `snapshot` then `null`). Surfaced on `doc.status`;
  // phases stream in via `doc_status` frames.
  status?: DocumentWorkStatus;
  // Drive provenance + tracking state, present only on drive-linked docs.
  // Seeds `doc.driveStatus`; live changes stream in via `doc_drive_status`.
  drive?: DocumentDriveSummaryWire;
  // Whether this document's export runs in the app this client acts as.
  // Server-answered per caller, so it says only that this app is the one to
  // serialize, never which app is if it is not. Absent for a caller carrying
  // no app assertion.
  calling_app_exports?: boolean;
  // The version of the document's current picture, absent when it has none.
  // Only the version is read (a picture behind the head is what makes this
  // open seed one), so the shape is deliberately narrow: the full wire record
  // is the thumbnail routes' surface, not the join's.
  thumbnail?: { version?: number } | null;
  // Where a document that mirrors nothing can be published, present only
  // while it mirrors nothing and its project is linked to a drive that
  // takes a new file. The hosted drive badge offers the publish off this.
  drive_publish_target?: DrivePublishTargetWire;
}

// Wire shape of a publish target on the join response. Snake_case,
// mirroring the server's `DocumentDrivePublishTarget` (CONTRACT.md "Where
// a document with no drive item can publish").
export interface DrivePublishTargetWire {
  drive_type?: unknown;
  drive_name?: unknown;
  container_name?: unknown;
  detail?: unknown;
  source_unreadable?: unknown;
  publishing?: unknown;
  publish_failed?: unknown;
  unpublishable?: unknown;
}

// Wire shape of the `drive` block carried on the join response and the
// `doc_drive_status` frame. Snake_case, mirroring the server's
// `DocumentDriveSummary` (CONTRACT.md "Drive document tracking state").
// The SDK maps it to the public camelCase `DocumentDriveStatus` via
// `toDriveStatus`.
export interface DocumentDriveSummaryWire {
  drive_type: string;
  drive_name: string;
  item_name: string;
  item_url: string;
  tracking_state: DocumentDriveTrackingState;
  tracking_ref: string;
  tracking_ref_updated_at: string;
  tracking_label: string | null;
  tracking_detail: string | null;
  broken: boolean;
  push_replaces_remote: boolean;
  mirror_direction: DriveMirrorDirection;
  // Optional: a frame from an older server omits it, treated as not
  // publishing (the `canPush` affordance then behaves as before).
  publishing?: boolean;
  // The server's publish decision: something a publish would change now.
  publishable?: boolean;
  keeps_prior_versions?: boolean;
  source_unreadable?: string;
}

// Wire-protocol-pinned response shape from
// `GET /documents/{docId}/at/{version}`. Mirrors the join's snapshot
// envelope minus `doc_id`, plus `effective_version` (rounded down from the
// requested one when compaction TTL'd the exact op) and `branch_id`.
export interface DocumentAtVersionResponse {
  effective_version: number;
  requested_version: number;
  branch_id: string;
  // `sealed` when the version is the head of a document still stored as a
  // record set (see `DocumentSnapshotResponse`).
  snapshot:
    | { kind: 'inline'; data_b64: string }
    | { kind: 'presigned'; url: string }
    | { kind: 'sealed'; url: string }
    | null;
  tail_ops: Array<{ seq: number; op_blob_b64: string }>;
  current_seq: number;
}

// Structural subset of `BrassWsClient` the factory uses, so it can be
// unit-tested against a mock.
export interface OpenDocumentWsClient {
  subscribe(
    topic: string,
    callback: WsTopicCallback,
    options?: {
      ownsFrameRetry?: boolean;
      onEnded?: (info: { reason: string }) => void;
      onSubscribed?: (info: { resubscribed: boolean; currentSeq?: number }) => void;
      notice?: boolean;
    },
  ): () => void;
  send(frame: unknown): void;
  // Connection-level facts the transport reports but does not own. Optional
  // so a transport-only test can supply a bare stub; absent reads as a
  // client that has never reconnected on a visible page, which is what a
  // test harness is.
  readonly reconnectCount?: number;
  readonly pageHidden?: boolean;
  // Whether a socket is open right now. Absent reads as connected, which is
  // what a transport-only test stub is.
  readonly connected?: boolean;
  // Whether any socket has opened in this page load. Absent reads as opened,
  // for the same reason.
  readonly everOpened?: boolean;
}

export interface LinkCredential {
  accessToken: string;
  appAssertion: string;
}

export interface OpenDocumentFactoryOptions {
  appId: string;
  apiBaseUrl: string;
  getAccessToken: () => Promise<string | null>;
  // Forwarded as `X-Brass-App-Assertion` on the Brass-API fetches only; the
  // presigned snapshot downloads carry no Brass headers.
  getAppAssertion?: () => Promise<string | null>;
  // The person's own credential for a link open, held when they signed in on
  // a link page. An app that opens public links only for people signed in
  // to it refuses the open without one.
  getLinkCredential?: () => LinkCredential | null | Promise<LinkCredential | null>;
  // How a link open proceeds when the server answers that the signed-in
  // person opens the document as themselves. Defaults to this factory's own
  // `open`.
  openAsMember?: (docId: string, options?: OpenDocumentByIdOptions) => Promise<OpenedDocument>;
  // The shared WS client. When provided (production), the factory wires a
  // doc-topic subscription + local-op send hook so the Document is editable.
  // When absent (tests / snapshot reads), the local-op hook is inert: state
  // still mutates locally but nothing leaves the process.
  wsClient?: OpenDocumentWsClient;
  // The socket a document opened through `token` uses. A link admits a socket
  // to its one document only, so a link's socket carries nothing else and the
  // page's own socket keeps the signed-in person's credential. Falls back to
  // `wsClient`.
  linkWsClient?: (token: string) => OpenDocumentWsClient | undefined;
  // ID minter, exposed for deterministic test clientOpIds. Defaults to
  // `crypto.randomUUID()`, falling back to a 32-hex Math.random() string.
  // Correlation is SDK-side only (the server never reads the value), so
  // cryptographic uniqueness is not required.
  newClientOpId?: () => string;
  // The HTTP capability the internal branch controller lists / creates
  // through, feeding the toolbar's branch chip + the hosted branch
  // dialog. When absent (tests) the doc reports no branch and the hosted
  // branch actions are unavailable. Not an app-facing surface.
  branchProvider?: BranchProvider;
  // When supplied, `doc.useCanvas(canvas)` captures + uploads a screenshot
  // after each local commit. When absent (tests), the upload step no-ops.
  thumbnailUploader?: (
    doc: Document,
    image: Blob,
    width: number,
    height: number,
    version?: number,
  ) => Promise<unknown>;
  // Routes `doc.createCheckpoint(...)`. When absent (tests), it throws.
  checkpointCreator?: (
    doc: Document,
    anchor: import('./document-checkpoints.js').CheckpointAnchor,
  ) => Promise<import('./documents-namespace.js').DocumentCheckpoint>;
  // Routes `doc.pushToDrive(...)`. When absent (tests / offline), it throws.
  drivePusher?: (
    doc: Document,
    input: import('./documents-namespace.js').PushToDriveInput,
  ) => Promise<import('./documents-namespace.js').PushToDriveResult>;
  // Routes `doc.sourceBlob()` (the namespace's `GET .../source-blob`). When
  // absent (tests / offline), it throws. Wired by `client.ts`.
  sourceBlobFetcher?: (
    doc: Document,
  ) => Promise<import('./documents-namespace.js').DocumentSourceBlob>;
  // Routes `subscribeInputStatus` / `inputStatus` for a document or one of
  // its stream lines. When absent (tests / offline), those methods throw.
  inputsRuntime?: (docId: string) => import('./inputs-status.js').InputsStatusRuntime;
  // Posts a key's provisional entry once the op carrying a `dependsOn` /
  // `markRead` change is acknowledged. When absent, nothing is posted and the
  // platform reads the key from the document when it compacts.
  /** @internal */
  provisionalInputsPoster?: (
    docId: string,
    post: import('./inputs.js').ProvisionalInputsPost,
    opts?: { superseded?: () => boolean },
  ) => Promise<import('./inputs.js').ProvisionalInputsAnswer | null>;
  // Streams manifest plumbing (`GET` / `POST /documents/{docId}/streams`).
  // When supplied, every returned Document exposes `doc.stream(name)` /
  // `doc.stream(name)` / `doc.listStreams()`; the factory owns the
  // per-line open (join + subscribe). When absent (tests), those methods
  // reject with "no runtime attached".
  streamProvider?: {
    list: (
      docId: string,
      branchId: string,
    ) => Promise<{
      streams: import('./documents-namespace.js').DocumentStreamInfo[];
    }>;
    create: (
      docId: string,
      branchId: string,
      name: string,
    ) => Promise<import('./documents-namespace.js').DocumentStreamInfo>;
  };
  // Backs the Document's built-in 'history' / 'manage' / 'share'
  // commands. When absent (tests), those commands render disabled.
  hostedUiProvider?: HostedUiProvider;
  // The organization this app is already acting in, read through a getter
  // because `init` resolves it after the factory's options are written and
  // because it moves as the reader works. See `createDocumentId`.
  preferredOrganizationId?: () => string | null;
  // Who is signed in, as the park cache's ownership stamp (see
  // `ParkedDocEntry.identity`). Read at park and at take, so a Document only
  // ever comes back to the person it was opened for. Absent (tests, the
  // anonymous link-guest path) parks under a null identity, which is
  // consistent with itself and so behaves as it always has.
  identity?: () => string | null;
  // Async-error sink for built-in command failures; `null` falls back to
  // console.
  reportError?: (err: Error) => void;
}

// A Document from `openDocumentById` / `createDocument` always carries a
// server-minted `id`, narrowed non-null here so callsites skip the guard.
// The `Document` class keeps the `| null` union for the test-only path.
// (The join also always materializes a branch, tracked in the Document's
// internal `branchId`; branch is hosted chrome, not app surface, so it is
// not narrowed onto the public type.)
export type OpenedDocument = Document & {
  readonly id: string;
};

// The terminal frame the platform sends when it clears a document's work
// status: the work finished and the content is in. The SDK emits the same
// shape wherever it settles that transition off its own import (a
// subscribe-time reconcile, a retried pull), so the app cannot tell the two
// apart. `blocking: false` is what releases the load lock.
const WORK_READY_STATUS: DocumentWorkStatus = {
  message: 'Ready',
  pending: false,
  blocking: false,
};

// How long an edit waits on a client that has never opened a socket before
// the document tells the reader it is not saved. Timed from the first waiting
// edit rather than counted in failed handshakes, because a network that
// swallows the upgrade can hold one attempt open with no failure to count.
// The socket starts connecting when the document opens, so by the time this
// expires it has had at least this long, which is several times a slow
// mobile handshake, and a network that refuses upgrades outright has failed
// four or five of them under the reconnect backoff (1s, 2s, 4s).
export const NEVER_OPENED_NOTICE_MS = 10_000;

const CONTENT_PULL_ATTEMPTS = 5;
const CONTENT_PULL_BACKOFF_MS = 1000;

// Pull a document's content in after the platform reports its inbound work
// finished, retrying a transient fetch failure (a network blip, a dropped
// presigned download): the platform asserts the content exists, so a silent
// give-up would leave the doc empty behind a terminal status, reading as "the
// model never loaded" and invisible in every log. Emits `finalStatus` only
// once the import lands, so an app re-reading on `onStatus` sees the content.
// On exhaustion it reports the failure and emits a terminal failure status,
// which keeps the doc read-only. Returns whether the content is in.
async function pullContentWithRetry(args: {
  doc: Document;
  docId: string;
  finalStatus: DocumentWorkStatus;
  fetchAndImport: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  reportError?: (err: Error) => void;
}): Promise<boolean> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= CONTENT_PULL_ATTEMPTS; attempt += 1) {
    try {
      const outcome = await args.fetchAndImport();
      if (outcome.ok) {
        args.doc._emitStatus(args.finalStatus, { contentLoaded: true });
        return true;
      }
      lastError = new Error(outcome.reason);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    // A retrying attempt is exceptional, so this warn is quiet in normal
    // operation and decisive in a bug report; without it a failure here is
    // undiagnosable from any log.
    console.warn(
      `[Brass] document content reload attempt ${attempt}/${CONTENT_PULL_ATTEMPTS} failed (doc ${args.docId}): ${lastError.message}`,
    );
    if (attempt < CONTENT_PULL_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, CONTENT_PULL_BACKOFF_MS * attempt));
    }
  }
  const error = new BrassError(
    `Document content reload failed after ${CONTENT_PULL_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
    { status: 0 },
  );
  if (args.reportError) args.reportError(error);
  else console.error('[Brass]', error);
  args.doc._emitStatus({
    message: 'The model could not be loaded. Reload to try again.',
    pending: false,
    // The content never arrived, so this terminal status still locks the
    // doc: an edit here would write into a document holding nothing.
    blocking: true,
  });
  return false;
}

export type OpenDocumentByIdFn = (
  docId: string,
  options?: OpenDocumentByIdOptions,
) => Promise<OpenedDocument>;

// Open a document read-only from a public-link token (the "anyone with the
// link" guest path). No auth header is sent: the token IS the credential,
// and the server serves a read-only, member-stripped snapshot. The result
// is a read-only Document with no live subscription, the same shape as an
// at-version open.
export type OpenDocumentByLinkFn = (
  token: string,
  options?: OpenDocumentByIdOptions,
) => Promise<OpenedDocument>;

export type CreateDocumentFn = (
  options?: CreateDocumentOptions,
) => Promise<OpenedDocument>;

export interface DocumentFactory {
  // Strict open: a 404 stays a 404.
  open: OpenDocumentByIdFn;
  // POSTs to create a doc then pipes the returned doc_id through `open`, so
  // the result is identical in shape to `open(docId)`. The low-level path:
  // resolves the caller's single org, opens the acquire surface for none,
  // and rejects with a 409 for a multi-org caller (no hosted picker).
  create: CreateDocumentFn;
  // Create-only (no open): POST the context body and report the outcome so
  // a caller (the session) can react to a needed destination / organization
  // before entering its loading state. The reactive picker / acquire dance
  // lives in the caller, not here.
  createDocumentId: (args: CreateDocumentArgs) => Promise<CreateDocumentResult>;
  // Read-only guest open from a public-link token (no auth, no live sub).
  openByLink: OpenDocumentByLinkFn;
  // Mint a document with no account: `POST /anonymous-documents`, no
  // Authorization header. The returned link token opens it through
  // `openByLink` read-write until it expires.
  mintAnonymousDocument: (args: {
    name?: string;
  }) => Promise<MintedAnonymousDocument>;
  // Whether this app starts new documents, and the file types a visitor
  // without an account can start one from:
  // `GET /anonymous-documents/upload-types`.
  anonymousUploadTypes: () => Promise<AnonymousUploadTypes>;
  // Mint a document with no account from a file: stage it through a
  // presigned PUT, then `POST /anonymous-documents/from-upload`. The file's
  // import runs after this resolves, and the open reports it as pending.
  // The app-run import calls for a document a visitor started from a file,
  // through the member import routes with its edit link as the credential.
  guestImports: (token: string, docId: string) => GuestImportCalls;
  mintAnonymousDocumentFromFile: (args: {
    file: File;
    name?: string;
    onUploadProgress?: (loaded: number, total: number) => void;
  }) => Promise<MintedAnonymousDocument>;
  // Move a document minted without an account into the caller's
  // organization: `POST /documents/{docId}/claim`. Classified like
  // `createDocumentId` so the caller can place it through the same hosted
  // surfaces.
  claimAnonymousDocument: (
    docId: string,
    args: ClaimAnonymousDocumentArgs,
  ) => Promise<ClaimDocumentResult>;
}

// Wire shapes on the `doc:` topic. Frame names match the server's exactly, so
// the CONTRACT.md type tests stay synced.
interface DocOpFrame {
  type: 'doc_op';
  topic: string;
  op_blob: string;
  seq: number;
}

interface OpAckFrame {
  type: 'op_ack';
  topic: string;
  client_op_id: string;
  seq: number;
}

// Server-pushed terminal rejection of a single local op: the op can never be
// accepted (it failed frame validation, e.g. it exceeded the server's op-blob
// cap), so unlike a transient drop it must NOT be retried. Carries the
// `client_op_id` so the SDK fails exactly that op (stops its resend, surfaces
// the failure) without touching the topic subscription. Wire shape pinned in
// CONTRACT.md "Server-pushed `op_rejected`".
interface OpRejectedFrame {
  type: 'op_rejected';
  topic: string;
  client_op_id: string;
  // A machine-readable hint at why (the validator's reason); informational.
  reason?: string;
  // Human-readable copy the SDK surfaces through the error reporter.
  message?: string;
}

// Both join fetches and the `doc_init` frame funnel through this, so a
// tail op whose bytes spilled to storage is fetched once, here. Every
// reader downstream then sees the inline shape it already handles, and
// none of the seq bookkeeping has to learn a second representation.
async function resolveParsedTailOps(
  parsed: unknown,
  onProgress?: LoadProgress,
): Promise<void> {
  if (typeof parsed !== 'object' || parsed === null) return;
  const body = parsed as { tail_ops?: unknown; snapshot?: unknown };
  if (!Array.isArray(body.tail_ops)) return;
  const tailOps = body.tail_ops as WireTailOp[];
  // The whole download, stated before any of it starts. A presigned snapshot
  // names its decompressed size and each spilled op names its blob's, and both
  // are fetched over the network with a reader waiting, so the load reports one
  // figure against their sum. An inline snapshot contributes nothing: its bytes
  // came with this response.
  const snapshot = body.snapshot as { raw_bytes?: unknown } | null | undefined;
  const snapshotBytes =
    typeof snapshot?.raw_bytes === 'number' ? snapshot.raw_bytes : 0;
  const totalBytes = declaredTailBytes(tailOps) + snapshotBytes;
  body.tail_ops = await resolveTailOps(
    tailOps,
    fetch,
    onProgress === undefined
      ? undefined
      : (loadedBytes) =>
          onProgress(loadedBytes, totalBytes > 0 ? totalBytes : null, 'tail'),
  );
}

// Post-subscribe server frame mirroring the HTTP join payload. The SDK needs
// the tail_ops + current_seq to cover the join-vs-fanout race (see
// `wireDocTransport`).
// A tail entry as `parseDocInitFrame` normalises it: the seq every reader
// needs for the cursors, and the inline bytes when the entry carries them.
interface DocInitTailOp {
  seq: number;
  // Absent when the op's blob spilled to storage (the server withholds such
  // a tail from this frame, since fetching one needs an await the frame
  // reader does not have) or when the entry names its bytes in a shape this
  // SDK does not recognise. A reader that finds one skips it and picks the
  // op up on the HTTP re-import.
  op_blob_b64?: string;
}
interface DocInitFrame {
  type: 'doc_init';
  topic: string;
  tail_ops: DocInitTailOp[];
  current_seq: number;
  // The seq the snapshot was sealed at, which is where this frame's tail
  // begins. Absent from an older server's frame, and then inferred from the
  // tail's own lower edge.
  snapshot_seq?: number;
  // Base64 version vector of the persisted snapshot, stamped at seal time.
  // Drives the durability handshake: fold the tail ops in for the durable
  // frontier and resync-push anything local holds beyond it. Absent on
  // never-compacted docs; the handshake is skipped (nothing to verify).
  snapshot_version_vector?: string;
  import_seq?: number;
}

// Server-pushed "the document moved past you" prompt, naming the seq to
// reach and carrying none of the content. The server sends it to every
// subscriber of a document on each op the socket could not carry, so it is
// the frequent frame of the two: it says nothing about the subscription it
// arrived on, and a reader that treats it as a (re)subscribe re-asserts
// every unacked op on somebody else's write. Wire shape pinned in
// CONTRACT.md "Server-pushed `doc_catch_up`".
interface DocCatchUpFrame {
  type: 'doc_catch_up';
  topic: string;
  current_seq: number;
}

// Server-pushed eviction frame. Carried on both the content and presence
// topics; the SDK collapses the duplicate via `Document._markGone`'s
// idempotency. Wire shape pinned in CONTRACT.md "Server-pushed `doc_gone`".
interface DocGoneFrame {
  type: 'doc_gone';
  topic: string;
  // The server may grow this vocabulary (a future revoked-access or
  // org-cascade eviction), so it is read as an open string and mapped to the
  // public `DocumentGoneReason` by `goneReasonOf`. An unrecognized reason
  // still evicts: the frame means the document is gone, whatever the label.
  reason: string;
}

// Server-pushed status frame for slow async work (hydration, extraction,
// push). Wire shape pinned in CONTRACT.md "Server-pushed `doc_status`".
interface DocStatusFrame {
  type: 'doc_status';
  topic: string;
  status: DocumentWorkStatus;
  // Internal hint, set on the terminal success frame so the SDK pulls the
  // now-available content into the live doc. Authoritative (set from the
  // committed row change), so success is never inferred from a racy read.
  reload?: boolean;
}

// Server-pushed display name, so every reader with the doc open re-titles
// after a rename, not only the one who made it. Wire shape pinned in
// CONTRACT.md "Server-pushed `doc_meta`".
interface DocMetaFrame {
  type: 'doc_meta';
  topic: string;
  name: string;
}

// Server-pushed drive tracking state. Wire shape pinned in CONTRACT.md
// "Server-pushed `doc_drive_status`". The SDK maps `drive` to the public
// `DocumentDriveStatus` on `doc.driveStatus` / `doc.onDriveStatus`.
interface DocDriveStatusFrame {
  type: 'doc_drive_status';
  topic: string;
  drive: DocumentDriveSummaryWire;
}

// Server-pushed publish state for a document that mirrors nothing on a drive
// yet. Wire shape pinned in CONTRACT.md "Server-pushed `doc_drive_publish`".
// The first publish creates the artifact, so until it lands the document has
// no drive summary and `doc_drive_status` carries nothing about the push it
// started.
interface DocDrivePublishFrame {
  type: 'doc_drive_publish';
  topic: string;
  publish: {
    publishing?: unknown;
    failed?: unknown;
    detail?: unknown;
  };
}

// Server-pushed frame fired when the platform discards ops it cannot apply.
// The prompt half of the durability
// handshake: the SDK re-checks durability against ground truth now rather
// than waiting for the author's next reconnect, and resync-pushes anything
// it holds. Best-effort and connected-only; the `doc_init` handshake is the
// correctness backstop. `dropped_seqs` / `actor` are informational (the
// handshake self-selects the author via the version-vector diff).
interface DocOpsDroppedFrame {
  type: 'doc_ops_dropped';
  topic: string;
}

// Map the snake_case wire `drive` block to the public camelCase
// `DocumentDriveStatus`. `canPush` is the server's `publishable`.
function toDriveStatus(wire: DocumentDriveSummaryWire): DocumentDriveStatus {
  const state = wire.tracking_state;
  // Only an explicit `import_only` restricts publishing; a frame omitting the
  // field must not strip the Publish affordance from a two-way link, so
  // anything not `import_only` is treated as two-way.
  const mirrorDirection =
    wire.mirror_direction === 'import_only' ? 'import_only' : 'two_way';
  return {
    driveType: wire.drive_type,
    driveName: wire.drive_name,
    state,
    // Only an explicit `true` offers a publish, so a frame that omits the
    // field never offers one the server would refuse.
    canPush: wire.publishable === true,
    label: wire.tracking_label,
    detail: wire.tracking_detail,
    broken: wire.broken === true,
    pushReplacesRemote: wire.push_replaces_remote,
    keepsPriorVersions: wire.keeps_prior_versions === true,
    mirrorDirection,
    ref: wire.tracking_ref,
    refUpdatedAt: wire.tracking_ref_updated_at,
    itemName: wire.item_name,
    itemUrl: wire.item_url,
    publishing: wire.publishing === true,
    // Spread rather than assigned, because `exactOptionalPropertyTypes`
    // separates an absent optional field from one holding `undefined`.
    ...(wire.source_unreadable !== undefined
      ? { sourceUnreadable: wire.source_unreadable }
      : {}),
  };
}

// Map the wire target to the public shape, dropping one that does not carry
// what a publish needs. A malformed target is skipped rather than failing
// the open: the document is readable whatever its publish offer says.
function toPublishTarget(
  wire: DrivePublishTargetWire | undefined,
): DrivePublishTarget | null {
  if (typeof wire !== 'object' || wire === null) return null;
  const driveName = wire.drive_name;
  if (typeof driveName !== 'string' || driveName === '') return null;
  return {
    driveName,
    driveType: typeof wire.drive_type === 'string' ? wire.drive_type : '',
    containerName:
      typeof wire.container_name === 'string' ? wire.container_name : '',
    detail: typeof wire.detail === 'string' ? wire.detail : '',
    publishing: wire.publishing === true,
    publishFailed: wire.publish_failed === true,
    unpublishable: wire.unpublishable === true,
  };
}

function isDocOpFrame(frame: unknown): frame is DocOpFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return (
    f.type === 'doc_op' &&
    typeof f.topic === 'string' &&
    typeof f.op_blob === 'string' &&
    typeof f.seq === 'number'
  );
}

// The frame in the shape its readers act on, or null when it carries nothing
// they can act on.
//
// Gated on the discriminant plus `current_seq`, with the tail degraded entry
// by entry. Most of what a `doc_init` does is carried by the frame itself
// rather than by any one entry: `current_seq` is the cursor, the tail's lower
// edge decides whether the reader re-imports the join, and the frame is the
// (re)subscribe signal that re-asserts every outstanding op and runs the
// durability handshake. So an entry whose shape this SDK does not recognise
// costs the one op it carries, which stays uncovered and is pulled over the
// HTTP join; refusing the frame over it would cost all of the above.
//
// `snapshot_version_vector` is likewise tolerated as absent when it is not a
// string: the handshake needs a vector it can decode, and skipping the
// handshake is a smaller loss than dropping the frame that drives it.
function parseDocInitFrame(frame: unknown): DocInitFrame | null {
  if (typeof frame !== 'object' || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (f.type !== 'doc_init' || typeof f.topic !== 'string') return null;
  if (typeof f.current_seq !== 'number') return null;
  const tailOps: DocInitTailOp[] = [];
  if (Array.isArray(f.tail_ops)) {
    for (const entry of f.tail_ops) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      // The seq is what places an entry in the sequence the cursors and the
      // resync trigger are computed from, so an entry without one is not an
      // entry any reader here can use.
      if (typeof e.seq !== 'number') continue;
      tailOps.push(
        typeof e.op_blob_b64 === 'string'
          ? { seq: e.seq, op_blob_b64: e.op_blob_b64 }
          : { seq: e.seq },
      );
    }
  }
  return {
    type: 'doc_init',
    topic: f.topic,
    current_seq: f.current_seq,
    tail_ops: tailOps,
    ...(typeof f.snapshot_seq === 'number' ? { snapshot_seq: f.snapshot_seq } : {}),
    ...(typeof f.snapshot_version_vector === 'string'
      ? { snapshot_version_vector: f.snapshot_version_vector }
      : {}),
    ...(typeof f.import_seq === 'number' ? { import_seq: f.import_seq } : {}),
  };
}

function isDocCatchUpFrame(frame: unknown): frame is DocCatchUpFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return (
    f.type === 'doc_catch_up' &&
    typeof f.topic === 'string' &&
    typeof f.current_seq === 'number'
  );
}

function isOpAckFrame(frame: unknown): frame is OpAckFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return (
    f.type === 'op_ack' &&
    typeof f.topic === 'string' &&
    typeof f.client_op_id === 'string' &&
    typeof f.seq === 'number'
  );
}

function isOpRejectedFrame(frame: unknown): frame is OpRejectedFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return (
    f.type === 'op_rejected' &&
    typeof f.topic === 'string' &&
    typeof f.client_op_id === 'string'
  );
}

// `{ type: 'error', topic, reason: 'unavailable' }`: the durable write of an
// op the server accepted and authorised did not go through, and the same op
// is expected to succeed on a later attempt. `BrassWsClient` leaves the
// subscription up and routes the frame here (see `isFrameScopedReason` in
// `topic-lifecycle.ts`). The frame names no `client_op_id`, so it identifies
// the shed batch and not one op within it.
/**
 * What one HTTP attempt at an oversized op resolved to.
 *
 * `retryable` carries the same distinction the WS transport gets from an
 * `unavailable` error frame: the server refused the write on capacity and
 * nothing landed, so the op is still the client's to send. Without it, the
 * two transports disagree about the same refusal, and an op that took the
 * HTTP route because it was too large for the socket is the one that gets
 * dropped.
 */
type OversizedOpResult =
  | { ok: true; seq: number }
  // `atCapacity` and `readOnly` ride beside `retryable` rather than
  // replacing it because the three answer different questions: whether to
  // send this op again, whether the document will take a growing op at all,
  // and whether this writer may write to it at all.
  | {
      ok: false;
      message: string;
      retryable: boolean;
      atCapacity?: boolean;
      // Set when the refusal was about the writer rather than the op, which
      // is the same distinction the socket's `op_rejected` reasons draw:
      // every later op meets it too, so the Document turns read-only.
      readOnly?: ForcedReadOnlyReason;
      // A new version's import replaced the line this op was built on: the
      // copy reopens rather than failing the op (`OP_REJECTED_MOVED`).
      moved?: boolean;
      // The document still holds only its uploaded file, and it takes no
      // edits until that file is imported (`OP_REJECTED_NOT_IMPORTED`).
      notImported?: boolean;
      // No transport this writer has can carry the op (a 413).
      tooLarge?: boolean;
    };

// Whether re-sending the same op is the right move. Two statuses refuse to
// write rather than answer about the op, and both leave the row untouched,
// so the op is still the client's to send: 503 (the store refused on
// capacity) and 429 (the caller is over the op-write cap, whose window
// resets). The WS transport reads its own rate refusal the same way, as an
// `unavailable` the shed recovery re-asserts, and the two transports carry
// the same ops, so a refusal cannot mean "later" on one and "never" on the
// other. Every other status is an answer about the op itself and repeats
// however many times it is sent.
function opWriteIsRetryable(status: number): boolean {
  return status === 503 || status === 429;
}

// The HTTP transport's rendering of the same refusal `op_rejected` carries on
// the socket: the document is full. 507 is the status, and the body's `code`
// is checked beside it so the classification does not rest on a status a
// proxy in front of the api could rewrite.
function isCapacityRefusal(status: number, parsed: unknown): boolean {
  if (status === 507) return true;
  return (parsed as { code?: unknown } | undefined | null)?.code === 'at_capacity';
}

// The refusal of an op built on a version of the line that a new version's
// import has since replaced. It is about the copy rather than the op: no
// resend or heal can place an op naming the replaced version's containers, so
// the copy reopens, as it does on `doc_gone` `moved`.
const OP_REJECTED_MOVED = 'moved';

// The document still holds only its uploaded file. Every op meets the same
// refusal until the import lands, so a smaller or later push cannot place
// the refused work and the heal is not armed: the copy locks and reloads.
const OP_REJECTED_NOT_IMPORTED = 'not_imported';

function isNotImportedRefusal(parsed: unknown): boolean {
  return (parsed as { code?: unknown } | undefined | null)?.code === OP_REJECTED_NOT_IMPORTED;
}

function isMovedRefusal(parsed: unknown): boolean {
  return (parsed as { code?: unknown } | undefined | null)?.code === OP_REJECTED_MOVED;
}

// A failure uploading an oversized op's blob to storage. It carries its own
// type because staging runs strictly BEFORE the op write, so what a replay
// means differs from a throw out of the write itself: nothing durable exists
// yet and the op is still the client's to send, where a throw mid-write
// leaves it unknown whether the row landed.
class OpStagingError extends Error {
  override name = 'OpStagingError';
  // The upstream status, or null for a request that drew no answer at all.
  readonly status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.status = status;
  }
}

// Whether staging the blob again is the right move: a status the op write
// itself replays replays here for the same reason, and a request that drew
// no answer wrote nothing either.
function opStagingIsRetryable(err: OpStagingError): boolean {
  return err.status === null || opWriteIsRetryable(err.status);
}

function asOpStagingError(err: unknown): OpStagingError {
  if (err instanceof OpStagingError) return err;
  const status = err instanceof BrassError ? err.status ?? null : null;
  return new OpStagingError(
    status,
    err instanceof Error ? err.message : String(err),
  );
}

function isServerUnavailableFrame(frame: unknown): boolean {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return f.type === 'error' && f.reason === 'unavailable';
}

// The message surfaced through the error reporter for a terminal op rejection.
// Prefers the server's copy; falls back to a generic, actionable line. The
// local edit already applied but can never persist, so the app's cue is to
// reload the document to return to server state.
function opRejectedMessage(frame: OpRejectedFrame): string {
  if (typeof frame.message === 'string' && frame.message !== '') {
    return frame.message;
  }
  return 'A change could not be saved and will not be retried. Reload to continue.';
}

// The one rejection reason that describes the DOCUMENT rather than the op:
// every later write meets it too, so the app is told once about the document
// instead of once per refused edit. Matched on the reason string rather than
// on the message, which is copy and may be reworded.
const OP_REJECTED_AT_CAPACITY = 'at_capacity';

// Whether the document refused this write because of its size. The server
// distinguishes a branch that refuses everything from one that refuses only
// growth, and picks the wording accordingly; the client does not, because both
// leave refused work on this copy and nowhere else and the answer to that is
// the same one.
function isCapacityRejection(frame: OpRejectedFrame): boolean {
  return frame.reason === OP_REJECTED_AT_CAPACITY;
}

// Which refusals describe the WRITER rather than the op. The server reads
// write authority once, when the connection subscribes, so a refusal on
// either of these grounds answers every later op the same way: the reader
// cannot write to this document at all, and the Document says so through
// `readOnly` instead of letting the app offer edits that keep failing. A
// refusal about the op itself (too large, a bad topic) leaves the document
// writable, because the next op may well be accepted.
//
// A Map rather than an object literal because the key is a wire string: an
// object answers for the names it inherits, so a reason reading `constructor`
// or `toString` would resolve a function and lock the document, which is the
// opposite of what an unclassified refusal means.
const READ_ONLY_REJECTION_REASONS = new Map<string, ForcedReadOnlyReason>([
  ['role_denied', 'grant'],
  ['scope_denied', 'app'],
]);

function readOnlyReasonForRejection(
  frame: OpRejectedFrame,
): ForcedReadOnlyReason | null {
  if (typeof frame.reason !== 'string') return null;
  return READ_ONLY_REJECTION_REASONS.get(frame.reason) ?? null;
}

function isDocGoneFrame(frame: unknown): frame is DocGoneFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  // Accept any string `reason`: a `doc_gone` the SDK can't classify still
  // evicts the open document. Gating on the known values would drop a frame
  // carrying a future reason, leaving the editor live on a document the
  // server has already removed.
  return (
    f.type === 'doc_gone' &&
    typeof f.topic === 'string' &&
    typeof f.reason === 'string'
  );
}

// Map the wire reason to the public `DocumentGoneReason`. `moved` is
// preserved (it has its own re-open path); every other value, including a
// future eviction reason, collapses to `deleted`, the terminal "it is gone"
// the app's cleanup reacts to. One definition so the signed-in and guest
// transports cannot drift on the collapse rule.
function goneReasonOf(frame: DocGoneFrame): 'moved' | 'deleted' {
  return frame.reason === 'moved' ? 'moved' : 'deleted';
}

function isDocStatusFrame(frame: unknown): frame is DocStatusFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  if (f.type !== 'doc_status' || typeof f.topic !== 'string') return false;
  const s = f.status;
  if (typeof s !== 'object' || s === null) return false;
  const st = s as Record<string, unknown>;
  // Gate only on `pending`, the render-control discriminant. `message` is
  // display copy read defensively at the use site, so a future message-less
  // or progress-only status still updates `doc.status` (clearing the loading
  // overlay) instead of being dropped as an unknown frame and stranding the
  // app on "loading". The HTTP-join path already emits this status
  // unvalidated, so this keeps the WS path from being the stricter of the two.
  return typeof st.pending === 'boolean';
}

// `message` is typed non-null and rendered verbatim, while the wire gates
// only on `pending`, so default it here.
function normalizeWorkStatus(status: DocumentWorkStatus): DocumentWorkStatus {
  return {
    ...status,
    message: typeof status.message === 'string' ? status.message : '',
  };
}

// The opaque work status a join response carries, or `null` when it carries
// none. Gates on `pending` like `isDocStatusFrame`; the rest is display data
// read defensively at the use site.
function parseWorkStatus(value: unknown): DocumentWorkStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const status = value as DocumentWorkStatus;
  if (typeof status.pending !== 'boolean') return null;
  return normalizeWorkStatus(status);
}

function isDocMetaFrame(frame: unknown): frame is DocMetaFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return (
    f.type === 'doc_meta' &&
    typeof f.topic === 'string' &&
    typeof f.name === 'string'
  );
}

function isDocDrivePublishFrame(frame: unknown): frame is DocDrivePublishFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  if (f.type !== 'doc_drive_publish' || typeof f.topic !== 'string') {
    return false;
  }
  return typeof f.publish === 'object' && f.publish !== null;
}

function isDocDriveStatusFrame(frame: unknown): frame is DocDriveStatusFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  if (f.type !== 'doc_drive_status' || typeof f.topic !== 'string') {
    return false;
  }
  const d = f.drive;
  if (typeof d !== 'object' || d === null) return false;
  const dr = d as Record<string, unknown>;
  // Gate on the discriminant (`drive_type`) + the affordance state
  // (`tracking_state`). `broken` and the rest are read defensively in
  // `toDriveStatus` (which now requires an explicit `false` to enable Publish),
  // so a future partial drive update still updates `doc.driveStatus` instead of
  // being dropped and leaving the sync/Publish surface stale.
  return (
    typeof dr.drive_type === 'string' && typeof dr.tracking_state === 'string'
  );
}

function isDocOpsDroppedFrame(frame: unknown): frame is DocOpsDroppedFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  // Gate on the discriminant alone. The handler reads no other field, so a
  // frame whose informational half changed shape (or went away) must still
  // prompt the durability re-check it is sent for.
  return f.type === 'doc_ops_dropped' && typeof f.topic === 'string';
}

function defaultClientOpIdMinter(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback for environments without `crypto.randomUUID`. Uniqueness is
  // only needed SDK-side (correlate `op_ack` to the outstanding local op).
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}


function isSnapshotResponse(body: unknown): body is DocumentSnapshotResponse {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as {
    doc_id?: unknown;
    branch_id?: unknown;
    snapshot?: unknown;
    tail_ops?: unknown;
  };
  if (typeof b.doc_id !== 'string') return false;
  if (typeof b.branch_id !== 'string') return false;
  if (!Array.isArray(b.tail_ops)) return false;
  // snapshot validated structurally in materialise(); a null is fine.
  return true;
}

/**
 * The body a join answered with, or the error it is.
 *
 * Every open starts here: check the status, then check the shape. Both
 * failures are open-time and neither is recoverable by the caller, so they
 * throw rather than returning, and the shape check is what stops a response
 * the server changed out from under a pinned SDK being read as an empty
 * document. `describe` names the response in the message, since a reader
 * debugging one wants to know which route answered.
 */
function unwrapJoinResponse<T>(
  result: { status: number; parsed: unknown; parseFailed: boolean },
  isShape: (body: unknown) => body is T,
  describe: string,
): T {
  const { status, parsed, parseFailed } = result;
  if (status < 200 || status >= 300) {
    throw brassErrorFromBody(status, parseFailed ? undefined : parsed);
  }
  if (!isShape(parsed)) {
    throw new BrassError(`Malformed document ${describe} response`, {
      status: 500,
    });
  }
  return parsed;
}

// Fold the join's write verdict into the Document options, so a reader the
// server will not accept writes from opens read-only instead of learning it
// from the first refused op. Only ever ADDS the restriction: a caller that
// asked for a read-only Document keeps it whatever the grant says.
/** The longest one pause between joins of a converting document. The wait
 *  itself has no bound, because a slow conversion is still a healthy one:
 *  each join is answered with what is left of it, and a conversion that
 *  cannot finish ends as `at_capacity`, which stops the wait. */
const CONVERSION_MAX_DELAY_MS = 60_000;
/** The shortest pause, so a server answering without holding the join is not
 *  asked again in a tight loop. */
const CONVERSION_MIN_DELAY_MS = 250;
const CONVERSION_POLL_MIN_MS = 1_000;
const CONVERSION_POLL_MAX_MS = 5_000;
/** Joins in a row that may fail outright while a conversion is awaited. */
const CONVERSION_JOIN_FAILURES = 5;
// How often a reader's open waiting on an import reads the work status, as
// the backstop for a terminal frame it did not hear.
const IMPORT_WAIT_POLL_MIN_MS = 2_000;
const IMPORT_WAIT_POLL_MAX_MS = 15_000;
const OPEN_SUPERSEDED_MESSAGE = 'This open was replaced by another';
// How long an open waits on the platform's work (a conversion, an import)
// before it rejects. Above the longest the platform itself takes to end that
// work either way: an import is two runs of the hydration worker (one retry)
// before the platform marks it failed, about 32 minutes, and a conversion is
// three compaction runs before it is marked full, about 18. A wait past this
// is work the platform has stopped reporting on.
// Exported for the fake-timer tests.
export const OPEN_WAIT_CEILING_MS = 40 * 60 * 1000;
const OPEN_WAIT_EXPIRED_MESSAGE = 'This is taking too long to open. Reload to try again.';
const IMPORT_FAILED_MESSAGE = 'This file could not be imported';
/** How long the server holds a writable join for a conversion, less a margin,
 *  so a join sent this long before the conversion is expected is held until
 *  it lands. */
const CONVERSION_HOLD_MS = 10_000;

/** When to send the next held join, given how long the conversion is
 *  expected to take from now. */
function heldJoinDelay(retryAfterMs: number): number {
  return Math.min(
    Math.max(CONVERSION_MIN_DELAY_MS, retryAfterMs - CONVERSION_HOLD_MS),
    CONVERSION_MAX_DELAY_MS,
  );
}

/** Whether a response is the join's retryable refusal for a conversion,
 *  which names its own wait, so the caller paces it rather than a backoff. */
async function namesConversionWait(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const body = (await response.clone().json()) as { retry_after_ms?: unknown };
    return typeof body.retry_after_ms === 'number';
  } catch {
    return false;
  }
}

type JoinAnswer = { status: number; parsed: unknown; parseFailed: boolean };

/**
 * Work a join reports that the open waits out before it resolves: pending work
 * that locks readers, such as the platform importing the file or a new
 * version of it.
 */
function pendingImportWork(
  join: JoinAnswer,
): { status: DocumentWorkStatus; topic: string } | null {
  if (join.status !== 200 || join.parseFailed) return null;
  const parsed = join.parsed as {
    doc_id?: unknown;
    branch_id?: unknown;
    status?: unknown;
  } | null;
  if (parsed === null || typeof parsed !== 'object') return null;
  if (typeof parsed.doc_id !== 'string' || typeof parsed.branch_id !== 'string') return null;
  const status = parseWorkStatus(parsed.status);
  if (status === null || !status.pending || status.blocking === false) return null;
  return { status, topic: `doc:${parsed.doc_id}:${parsed.branch_id}` };
}

/**
 * The error an open rejects with when the file's import failed and the
 * document holds nothing from it, or `null`.
 */
function failedImportOf(join: JoinAnswer): BrassError | null {
  if (join.status !== 200 || join.parseFailed) return null;
  const parsed = join.parsed as {
    current_seq?: unknown;
    awaits_import?: unknown;
    status?: unknown;
  } | null;
  if (parsed === null || typeof parsed !== 'object') return null;
  const status = parseWorkStatus(parsed.status);
  if (status === null || status.pending || status.blocking !== true) return null;
  // An import lands at seq 1 or later, so seq 0 is a document no import has
  // filled.
  const empty =
    parsed.awaits_import === true ||
    typeof parsed.current_seq !== 'number' ||
    parsed.current_seq <= 0;
  if (!empty) return null;
  return new BrassError(status.message !== '' ? status.message : IMPORT_FAILED_MESSAGE, {
    status: 0,
  });
}

/** Why a writable join refused, or `null` for one that served or failed some
 *  other way. */
function joinRefusalOf(join: {
  status: number;
  parsed: unknown;
}):
  | { kind: 'converting'; retryAfterMs?: number }
  | { kind: 'at_capacity'; error?: string }
  | null {
  const body =
    typeof join.parsed === 'object' && join.parsed !== null
      ? (join.parsed as { retry_after_ms?: unknown; code?: unknown; error?: unknown })
      : {};
  if (join.status === 503 && typeof body.retry_after_ms === 'number' && body.retry_after_ms >= 0) {
    return { kind: 'converting', retryAfterMs: body.retry_after_ms };
  }
  if (join.status === 507 && body.code === 'at_capacity') {
    return typeof body.error === 'string' ? { kind: 'at_capacity', error: body.error } : { kind: 'at_capacity' };
  }
  return null;
}

function readOnlyForGrant(
  body: DocumentSnapshotResponse,
  options: DocumentOptions | undefined,
): DocumentOptions | undefined {
  if (body.can_edit !== false) return options;
  return {
    ...options,
    readOnly: true,
    readOnlyReason: body.read_only_reason === 'not_imported' ? 'not_imported' : 'grant',
  };
}

function isAtVersionResponse(
  body: unknown,
): body is DocumentAtVersionResponse {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as {
    effective_version?: unknown;
    branch_id?: unknown;
    tail_ops?: unknown;
  };
  if (typeof b.effective_version !== 'number') return false;
  if (typeof b.branch_id !== 'string') return false;
  if (!Array.isArray(b.tail_ops)) return false;
  // snapshot validated structurally in materialise(); a null is fine.
  return true;
}

export function createOpenDocument(
  opts: OpenDocumentFactoryOptions,
): DocumentFactory {
  const baseUrl = opts.apiBaseUrl.replace(/\/$/, '');

  // Documents this session has answered the schema-conflict prompt for.
  // Consent is per DOCUMENT, not per request: an open makes several joins
  // (the branch refetch, the durability handshake, a resync), each building
  // its own options from the branch it needs, and every one of them would
  // otherwise be refused again after the person already said yes. Holding it
  // here rather than threading it through each call site is what keeps a
  // fourth one from silently dropping it.
  const consented = new Set<string>();

  // What a document is opened with: the signed-in session, a share link, or
  // the edit link of a document started without an account. Every document
  // this factory returns is built by `materialiseAs`, which wires what the
  // credential reaches, so an open path cannot leave a capability out.
  type OpenCredential =
    | { kind: 'session' }
    | { kind: 'link'; token: string }
    | { kind: 'temporary'; token: string };
  const SESSION: OpenCredential = { kind: 'session' };

  function inputsRuntimeFor(credential: OpenCredential, docId: string): InputsStatusRuntime | null {
    switch (credential.kind) {
      case 'session':
        return opts.inputsRuntime ? opts.inputsRuntime(docId) : null;
      case 'link':
        return {
          readKey: (key, query) =>
            getWithLink(
              credential.token,
              `/documents/${encodeURIComponent(docId)}/inputs/${encodeURIComponent(key)}`,
              query,
            ),
        };
      case 'temporary':
        return TEMPORARY_INPUTS_RUNTIME;
    }
  }

  // The join, the op write and the work-status read, through whichever
  // credential the document was opened with.
  // `rejoin` marks a read for a document this page already has open, which a
  // link meters apart from opens.
  async function joinAs(
    credential: OpenCredential,
    docId: string,
    options: OpenDocumentByIdOptions | undefined,
    { rejoin = true }: { rejoin?: boolean } = {},
  ): Promise<JoinAnswer> {
    return credential.kind === 'session'
      ? fetchSnapshot(docId, options, await requireToken())
      : fetchLinkView(credential.token, options ?? {}, undefined, { rejoin });
  }

  async function postOpAs(
    credential: OpenCredential,
    docId: string,
    lineId: string,
    opBlobB64: string,
    clientOpId: string,
    base: { base_import_seq?: number },
  ): Promise<{ status: number; parsed: unknown }> {
    if (credential.kind === 'session') {
      return postDocumentOp(docId, lineId, opBlobB64, clientOpId, await requireToken(), base);
    }
    return postLinkOp(credential.token, docId, lineId, opBlobB64, clientOpId, base);
  }

  async function readStatusAs(credential: OpenCredential, docId: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    let url: string;
    if (credential.kind === 'session') {
      headers['authorization'] = `Bearer ${await requireToken()}`;
      applyClientVersionHeader(headers);
      await applyAppAssertionHeader(headers, opts.getAppAssertion);
      url = `${baseUrl}/documents/${encodeURIComponent(docId)}`;
    } else {
      Object.assign(headers, await linkViewHeaders());
      url = `${baseUrl}/links/${encodeURIComponent(credential.token)}/view?app_id=${encodeURIComponent(opts.appId)}&rejoin=1`;
    }
    const response = await fetch(url, { method: 'GET', headers });
    if (!response.ok) {
      throw new BrassError(`document read returned ${response.status}`, { status: response.status });
    }
    return response.json();
  }

  function wsClientFor(credential: OpenCredential): OpenDocumentWsClient | undefined {
    return credential.kind === 'session' ? opts.wsClient : (opts.linkWsClient?.(credential.token) ?? opts.wsClient);
  }

  async function materialiseAs(
    credential: OpenCredential,
    ...args: Parameters<typeof materialise>
  ): Promise<OpenedDocument> {
    const doc = await materialise(...args);
    doc._setInputsRuntime(inputsRuntimeFor(credential, args[0].doc_id));
    return doc;
  }

  // A join. One that will write and takes nothing else waits while the
  // platform converts the document: the join is refused with how long is
  // left, and asked again then, for as long as that takes. The open's
  // progress sink hears `preparing` on each wait, and its `false` ends the
  // wait with a rejection.
  async function fetchSnapshot(
    docId: string,
    options: OpenDocumentByIdOptions | undefined,
    token: string,
  ): Promise<JoinAnswer> {
    if (opensReadOnly(options)) {
      return joinOnce(docId, options, token);
    }
    // The first join spends the token the caller holds; a re-join after a
    // long wait asks for a current one.
    let held: string | null = token;
    return waitWhileConverting(async () => {
      const t = held ?? (await requireToken());
      held = null;
      return joinOnce(docId, options, t);
    }, options?.onSnapshotProgress);
  }

  async function waitWhileConverting(
    join: () => Promise<JoinAnswer>,
    progress: LoadProgress | undefined,
  ): Promise<JoinAnswer> {
    const deadline = Date.now() + OPEN_WAIT_CEILING_MS;
    let answer = await join();
    let failures = 0;
    for (;;) {
      const refused = joinRefusalOf(answer);
      if (refused?.kind !== 'converting') return answer;
      if (progress?.(0, null, 'preparing') === false) {
        throw new BrassError(OPEN_SUPERSEDED_MESSAGE, { status: 0 });
      }
      if (Date.now() >= deadline) throw new BrassError(OPEN_WAIT_EXPIRED_MESSAGE, { status: 0 });
      let delay =
        refused.retryAfterMs === undefined ? CONVERSION_POLL_MIN_MS : heldJoinDelay(refused.retryAfterMs);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          answer = await join();
          failures = 0;
          break;
        } catch (err) {
          // The document is known to exist and to be converting, so a join
          // that fails outright is the connection rather than the answer.
          failures += 1;
          if (failures >= CONVERSION_JOIN_FAILURES) throw err;
          delay = Math.min(CONVERSION_POLL_MIN_MS * 2 ** (failures - 1), CONVERSION_POLL_MAX_MS);
        }
      }
    }
  }

  async function joinOnce(
    docId: string,
    options: OpenDocumentByIdOptions | undefined,
    token: string,
  ): Promise<JoinAnswer> {
    const search = new URLSearchParams();
    search.set('include', 'snapshot');
    if (options?.filter !== undefined) {
      search.set('filter', JSON.stringify(options.filter));
    }
    if (options?.branch !== undefined) {
      search.set('branch', options.branch);
    }
    if (options?.stream !== undefined) {
      search.set('stream', options.stream);
    }
    if (options?.acceptSchemaConflict === true) consented.add(docId);
    if (consented.has(docId)) search.set('accept_schema_conflict', '1');
    // A caller that will not write asks for the document as it is stored. It
    // matters on a document the platform holds as a record set: serving one
    // to a reader is the point of storing one, and serving it to a writer
    // means converting it to a CRDT first, which the server does and this
    // reader has no reason to wait for.
    if (opensReadOnly(options)) search.set('intent', 'read');
    return sendJoin(`/documents/${encodeURIComponent(docId)}`, search, {
      headers: await memberHeaders(token),
      perf: 'open: GET /documents (http + read body)',
      ...(options?.onSnapshotProgress !== undefined ? { progress: options.onSnapshotProgress } : {}),
    });
  }

  // Every join's request: the stored frames this build decodes (a client that
  // does not name them is served the CRDT), the answer parsed, and its
  // spilled tail ops resolved. A reader holding a CRDT names the frames too:
  // the line as stored is the cheapest answer to serve it, and `applyJoin`
  // takes either form in place.
  async function sendJoin(
    path: string,
    search: URLSearchParams,
    {
      headers,
      perf,
      progress,
    }: {
      headers?: Record<string, string>;
      perf?: string;
      progress?: LoadProgress;
    },
  ): Promise<JoinAnswer> {
    search.set('accept', SEALED_ACCEPT);
    const qs = search.toString();
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const endFetch = perf !== undefined ? perfStart(perf) : null;
    // Idempotent read: ride out a transient 5xx / 429 instead of failing the
    // open on something that clears on its own.
    //
    // Longer than the default handful of attempts because of what a 503 means
    // on a join: the document is intact and its storage is busy. A
    // document's own writes contend with each other, so the one most likely
    // to answer 503 is one that was just written hard, which is exactly the
    // moment a person reloads to see their work. That pressure clears over
    // tens of seconds, not the one second the default budget spans, and the
    // cost of giving up early is telling someone their document will not open
    // when waiting would have opened it.
    //
    // A thrown request gets a short budget of its own: it never reached the
    // API, so busy storage is not what is wrong, and a blocked origin
    // or a host that does not resolve answers the seventh attempt as it
    // answered the first, with the reader watching a loading surface
    // throughout.
    const response = await fetchWithRetry(
      () => fetch(url, { method: 'GET', ...(headers !== undefined ? { headers } : {}) }),
      {
        maxAttempts: 7,
        baseDelayMs: 700,
        maxNetworkAttempts: 3,
        // A conversion's refusal says how long to wait, and the caller waits
        // that long rather than this backoff's second or two.
        isFinal: namesConversionWait,
      },
    );
    const text = await response.text();
    endFetch?.({ status: response.status, responseChars: text.length });
    let parsed: unknown = undefined;
    let parseFailed = false;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parseFailed = true;
      }
    }
    // A tail op whose bytes spilled to storage arrives as a signed URL, which
    // carries its own signature, so a guest resolves it as a member does.
    await resolveParsedTailOps(parsed, progress);
    return { status: response.status, parsed, parseFailed };
  }

  async function memberHeaders(token: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    applyClientVersionHeader(headers);
    await applyAppAssertionHeader(headers, opts.getAppAssertion);
    return headers;
  }

  // `GET /documents/{docId}/at/{version}`: read-only materialization at a
  // historical version.
  async function fetchAtVersion(
    docId: string,
    version: number,
    branch: string | undefined,
    token: string,
  ): Promise<JoinAnswer> {
    const search = new URLSearchParams();
    if (branch !== undefined) search.set('branch', branch);
    return sendJoin(
      `/documents/${encodeURIComponent(docId)}/at/${encodeURIComponent(String(version))}`,
      search,
      { headers: await memberHeaders(token) },
    );
  }

  // The historical-materialise fetcher `doc._checkoutVersion(v)` calls back
  // to, shared by the default Document and each opened stream line (both
  // materialize a branch at a version through `GET .../at/{version}`). The
  // `stream_seqs` in the response (present only on a default/branch preview
  // that resolved a checkpoint, absent on a line's own preview) rides
  // through so the parent can preview every opened stream at the same point.
  function makeCheckoutFetcher(): CheckoutFetcher {
    return async (id, version, branchId) => {
      const t = await requireToken();
      const result = await fetchAtVersion(id, version, branchId, t);
      if (result.status < 200 || result.status >= 300) {
        throw brassErrorFromBody(
          result.status,
          result.parseFailed ? undefined : result.parsed,
        );
      }
      if (!isAtVersionResponse(result.parsed)) {
        throw new BrassError('Malformed document at-version response', {
          status: 500,
        });
      }
      const content = await decodeJoinContent(result.parsed.snapshot, (url) =>
        fetchPresignedSnapshot(url),
      );
      const tailOpBlobs = result.parsed.tail_ops.map((entry) =>
        base64ToBytes(entry.op_blob_b64),
      );
      const rawSeqs = (result.parsed as { stream_seqs?: unknown }).stream_seqs;
      let streamSeqs: Record<string, number> | undefined;
      if (rawSeqs && typeof rawSeqs === 'object' && !Array.isArray(rawSeqs)) {
        const parsed: Record<string, number> = {};
        for (const [lineId, seq] of Object.entries(rawSeqs)) {
          if (typeof seq === 'number') parsed[lineId] = seq;
        }
        if (Object.keys(parsed).length > 0) streamSeqs = parsed;
      }
      return {
        content,
        tailOpBlobs,
        effectiveVersion: result.parsed.effective_version,
        ...(streamSeqs ? { streamSeqs } : {}),
      };
    };
  }

  // POSTs the context-create body to `/documents`. The server resolves the
  // destination from the body (a `sibling_of` doc, the opaque `destination`
  // the hosted picker returned, or the caller's single membership), so the
  // SDK never names an org. Returns the raw status so `createDocumentId`
  // can branch on the 409 destination / organization codes. An empty new
  // doc has no snapshot, so the response is metadata-only and its doc_id is
  // piped through `open` to materialise the editable Document.
  // What the app hears when an op the socket could not carry also failed
  // over HTTP. The server's message is preferred where it has one, since it
  // names the actual refusal (too large to store inline, a revoked
  // role); the status-shaped fallbacks cover a response that carries none.
  function opWriteFailureMessage(status: number, parsed: unknown): string {
    const serverMessage = (parsed as { error?: unknown } | undefined)?.error;
    if (typeof serverMessage === 'string' && serverMessage.length > 0) {
      return serverMessage;
    }
    if (status === 403) return 'You do not have permission to make changes here.';
    if (status === 404) return 'This is no longer available.';
    return `This change could not be saved (${status}).`;
  }

  // Write one op over HTTP. The socket carries an op only up to its own
  // message cap; past it the message is not delivered and the connection is
  // closed, so `wireDocTransport` sends the large ones here.
  // Not retried on a transient failure: the caller holds the op in its
  // outstanding tracker and re-asserts it, and a blind replay would write a
  // second stored copy of the same edit.
  // Mint a presigned PUT and upload the blob to it, returning the staging
  // key the op write names. A share link mints on the same route with the
  // link as the credential. The PUT carries no Brass headers: the URL is
  // signed, and an extra header falls outside that signature.
  async function stageOpBlob(
    docId: string,
    opBlobB64: string,
    credential: { bearer: string } | { link: string },
  ): Promise<string> {
    // Everything in here happens before the op write, so every failure it
    // can take is tagged as one: what the tag buys the writer is the right
    // to send the op again, which a failure of the write itself does not
    // carry.
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if ('link' in credential) {
        headers['authorization'] = `Link ${credential.link}`;
      } else {
        headers['authorization'] = `Bearer ${credential.bearer}`;
        applyClientVersionHeader(headers);
        await applyAppAssertionHeader(headers, opts.getAppAssertion);
      }
      const mint = await fetchWithDeadline(
        `${baseUrl}/documents/${encodeURIComponent(docId)}/ops/upload`,
        { method: 'POST', headers, body: JSON.stringify({ byte_size: opBlobB64.length }) },
        OP_WRITE_TIMEOUT_MS,
      );
      let minted: unknown = undefined;
      try {
        minted = mint.text ? JSON.parse(mint.text) : undefined;
      } catch {
        minted = undefined;
      }
      if (!mint.ok) {
        throw brassErrorFromBody(mint.status, minted);
      }
      const body = (minted ?? {}) as {
        upload_key?: unknown;
        url?: unknown;
      };
      if (typeof body.upload_key !== 'string' || typeof body.url !== 'string') {
        throw new BrassError('Malformed op upload response', { status: 500 });
      }
      const endUpload = perfStart('op: PUT staged op blob');
      const put = await fetchWithDeadline(
        body.url,
        { method: 'PUT', body: opBlobB64 },
        deadlineForUpload(opBlobB64.length),
      );
      endUpload({ status: put.status, opChars: opBlobB64.length });
      if (!put.ok) {
        throw new BrassError('Could not upload the update', {
          status: put.status,
        });
      }
      return body.upload_key;
    } catch (err) {
      throw asOpStagingError(err);
    }
  }

  async function postDocumentOp(
    docId: string,
    branchId: string,
    opBlobB64: string,
    clientOpId: string,
    token: string,
    base: { base_import_seq?: number } = {},
  ): Promise<{ status: number; parsed: unknown }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    applyClientVersionHeader(headers);
    await applyAppAssertionHeader(headers, opts.getAppAssertion);
    // Past the size an op can carry inline, the blob is uploaded first and
    // the write names what was staged, so a multi-megabyte op never travels
    // through a request body.
    let stagedKey: string | undefined;
    if (opBlobNeedsStaging(opBlobB64)) {
      stagedKey = await stageOpBlob(docId, opBlobB64, { bearer: token });
    }
    const endFetch = perfStart('op: POST /documents/{id}/ops');
    const response = await fetchWithDeadline(
      `${baseUrl}/documents/${encodeURIComponent(docId)}/ops`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(stagedKey === undefined
            ? { op_blob: opBlobB64 }
            : { upload_key: stagedKey }),
          branch_id: branchId,
          client_op_id: clientOpId,
          ...base,
        }),
      },
      // An op under the staging threshold travels inline, so this request
      // carries the blob and its deadline has to allow for sending it.
      deadlineForUpload(stagedKey === undefined ? opBlobB64.length : 0),
    );
    endFetch({ status: response.status, opChars: opBlobB64.length });
    let parsed: unknown = undefined;
    try {
      parsed = response.text ? JSON.parse(response.text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: response.status, parsed };
  }

  async function postCreateDocument(
    args: CreateDocumentArgs,
    token: string,
  ): Promise<{ status: number; parsed: unknown; parseFailed: boolean }> {
    // `creating_app_id` powers the dashboard's "Open in {appName}"
    // affordance and is the Layer 2 scope subject; re-derived from the
    // verified app assertion server-side.
    const body: Record<string, unknown> = { creating_app_id: opts.appId };
    if (args.name !== undefined) body['name'] = args.name;
    if (args.app_metadata !== undefined) body['app_metadata'] = args.app_metadata;
    if (args.siblingOf !== undefined) body['sibling_of'] = args.siblingOf;
    // Relayed verbatim: the SDK never reads the destination's fields, so
    // the hierarchy shape can grow server-side without an SDK change.
    if (args.destination !== undefined) body['destination'] = args.destination;
    // Idempotency key: one per logical create, minted BEFORE the retry loop so
    // every replay carries the SAME key. The server records the first create
    // under it and returns that same document for any later request with the
    // key, so a replay after a lost response never creates a second document.
    body['idempotency_key'] = defaultClientOpIdMinter();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    applyClientVersionHeader(headers);
    await applyAppAssertionHeader(headers, opts.getAppAssertion);
    // The create carries an idempotency key, so a replay the server already
    // applied returns the original document instead of a second one. That
    // makes the full transient set (and a network throw) replay-safe here,
    // not just a pre-handler 503 (`RETRY_IDEMPOTENT_WRITE`). Resilience
    // matters most on create because a 503 that swallowed it would also
    // swallow the `app_not_installed` consent flow that rides the response.
    const response = await fetchWithRetry(
      () =>
        fetch(`${baseUrl}/documents`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      { policy: RETRY_IDEMPOTENT_WRITE, baseDelayMs: 250 },
    );
    const text = await response.text();
    let parsed: unknown = undefined;
    let parseFailed = false;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parseFailed = true;
      }
    }
    return { status: response.status, parsed, parseFailed };
  }

  // Create-only (no open). Classifies the response so a caller can react to
  // a needed destination / organization before showing a loading state; any
  // other non-2xx throws.
  //
  // A create that names no placement of its own lands in the organization the
  // app is already acting in: the one a launch named, the one a document the
  // reader just closed lives in, or the one they chose in the account menu's
  // switch. Without it a member of several organizations is asked to name a
  // destination they have already answered, once per create. An explicit
  // `siblingOf` / `destination` outranks it: placing a document beside the
  // open one is the more specific answer.
  const createDocumentId = async (
    args: CreateDocumentArgs,
  ): Promise<CreateDocumentResult> => {
    const preferred =
      args.siblingOf === undefined && args.destination === undefined
        ? (opts.preferredOrganizationId?.() ?? null)
        : null;
    if (preferred === null) return postAndClassify(args);
    try {
      return await postAndClassify({
        ...args,
        destination: { organization_id: preferred },
      });
    } catch (err) {
      // Every source of this value is a preference rather than an answer: a
      // URL parameter, a document open in an organization reached through a
      // shared project, a choice made before the person left. Each can name
      // an organization the caller no longer has, which the server answers
      // with a plain 404. Drop it and let the server resolve the destination
      // on its own, which routes a multi-organization caller to the picker. A
      // coded rejection (`app_not_installed`) belongs to the caller's own
      // consent flow and passes through untouched, as does the 404 for an
      // organization that exists but denies the app.
      if (err instanceof BrassError && err.status === 404 && !err.code) {
        return postAndClassify(args);
      }
      throw err;
    }
  };

  // One POST plus its classification. Each call mints its own idempotency
  // key inside `postCreateDocument`, so a second call after a rejected
  // first cannot land a second document.
  const postAndClassify = async (
    args: CreateDocumentArgs,
  ): Promise<CreateDocumentResult> => {
    const token = await requireToken();
    // `postCreateDocument` owns the idempotency-keyed write replay
    // (`RETRY_IDEMPOTENT_WRITE`), so a retried create never double-applies.
    const created = await postCreateDocument(args, token);
    if (created.status >= 200 && created.status < 300) {
      const docId =
        typeof created.parsed === 'object' &&
        created.parsed !== null &&
        typeof (created.parsed as { doc_id?: unknown }).doc_id === 'string'
          ? (created.parsed as { doc_id: string }).doc_id
          : null;
      if (!docId) {
        throw new BrassError('Malformed createDocument response', { status: 500 });
      }
      return { kind: 'created', docId };
    }
    if (created.status === 409 && !created.parseFailed) {
      const code = (created.parsed as { code?: unknown })?.code;
      if (code === 'destination_required') return { kind: 'needs-destination' };
      if (code === 'no_organization') return { kind: 'needs-organization' };
    }
    throw brassErrorFromBody(
      created.status,
      created.parseFailed ? undefined : created.parsed,
    );
  };

  async function requireToken(): Promise<string> {
    const token = await opts.getAccessToken();
    if (!token) {
      // Reject before fetch so callers get a deterministic 401 with no
      // network round-trip (matches the projects / users namespaces).
      throw new BrassError('Not signed in', { status: 401 });
    }
    return token;
  }

  // Open one stream LINE: the per-stream sibling of the document open.
  // Joins the line over the same HTTP join (`?include=snapshot&branch=
  // <lineId>`), imports its (usually much smaller) snapshot, and wires
  // the same op transport on the line's own topic. Deliberately lean
  // next to `finalise`: no presence, no branches fetch, no thumbnails /
  // checkpoints / commands, and no park cache; a stream's extra cost
  // over its content is one join + one subscribe, which is what keeps
  // per-stream opens proportional to what an app touches.
  async function openStreamLine(
    docId: string,
    lineId: string,
    // The parent document's open, whose read intent every line of it shares.
    parentOptions: OpenDocumentByIdOptions | undefined,
    credential: OpenCredential = SESSION,
  ): Promise<Document> {
    const lineOptions = rejoinOptions(lineId, parentOptions);
    const result = await joinAs(credential, docId, lineOptions, { rejoin: false });
    const parsed = unwrapJoinResponse(result, isSnapshotResponse, 'snapshot');
    // A stream's write authority is the document's, so the line opens
    // read-only for the same reader the document opens read-only for, and for
    // a caller who asked for a read-only document.
    const asked = parentOptions?.documentOptions;
    const doc = await materialiseAs(
      credential,
      parsed,
      readOnlyForGrant(
        parsed,
        asked?.readOnly === true
          ? { readOnly: true, readOnlyReason: asked.readOnlyReason ?? 'snapshot' }
          : undefined,
      ),
    );
    // A stream line materializes at a historical seq the same way the
    // default line does, so the parent's version preview can bring this
    // stream to a point in time (`doc.stream(name)._previewAt(seq)`). The
    // line's own timeline carries no checkpoints, so its at-version response
    // resolves no `stream_seqs` (only the doc-level preview does).
    doc.setCheckoutFetcher(makeCheckoutFetcher());

    // Transport cursors, the same shape `finalise` keeps for the default
    // line (see the comments there); scoped per line because each stream
    // has its own seq space.
    let currentSeq = Math.max(
      parsed.tail_ops.reduce(
        (acc, entry) => (entry.seq > acc ? entry.seq : acc),
        0,
      ),
      typeof parsed.current_seq === 'number' ? parsed.current_seq : 0,
    );
    const lineTailSeqs = parsed.tail_ops.map((entry) => entry.seq);
    let coveredSeq = joinCoverageFloor(
      snapshotSeqOf(
        parsed.snapshot_seq,
        lineTailSeqs,
        typeof parsed.current_seq === 'number' ? parsed.current_seq : 0,
      ),
      lineTailSeqs,
    );
    const coverageParked = new Set<number>();
    const advanceCoverage = (seq: number): void => {
      if (seq <= coveredSeq) return;
      coverageParked.add(seq);
      while (coverageParked.has(coveredSeq + 1)) {
        coverageParked.delete(coveredSeq + 1);
        coveredSeq += 1;
      }
    };
    const raiseCoverage = (floor: number): void => {
      if (floor > coveredSeq) coveredSeq = floor;
      for (const seq of coverageParked) {
        if (seq <= coveredSeq) coverageParked.delete(seq);
      }
      while (coverageParked.has(coveredSeq + 1)) {
        coverageParked.delete(coveredSeq + 1);
        coveredSeq += 1;
      }
    };
    for (const entry of parsed.tail_ops) advanceCoverage(entry.seq);

    // Re-import the line's join: the reconnect-across-compaction recovery,
    // and the answer to a catch-up prompt. Loro imports are idempotent, so
    // re-applying over live state is a clean merge.
    //
    // Coalesced and delivery-honest for the same reasons the default line
    // is: a prompt during a fetch is the only notice of that op the line
    // gets, and a join's `current_seq` names seqs whose rows the tail query
    // could not see yet.
    let lineResyncRun: Promise<void> | null = null;
    let lineResyncAgain = false;
    const runLineResync = async (): Promise<void> => {
      try {
        do {
          lineResyncAgain = false;
          try {
            const res = await joinAs(credential, docId, lineOptions);
            if (res.status < 200 || res.status >= 300) continue;
            if (!isSnapshotResponse(res.parsed)) continue;
            const applied = await applyJoin(doc, res.parsed, (url) =>
              fetchPresignedSnapshot(url),
            );
            if (applied.kind !== 'applied') return;
            const seqs = applied.tailSeqs;
            for (const seq of seqs) if (seq > currentSeq) currentSeq = seq;
            const joined = res.parsed.current_seq;
            if (typeof joined === 'number' && joined > currentSeq) {
              currentSeq = joined;
            }
            raiseCoverage(
              joinCoverageFloor(
                snapshotSeqOf(res.parsed.snapshot_seq, seqs, currentSeq),
                seqs,
              ),
            );
            for (const seq of seqs) advanceCoverage(seq);
          } catch {
            // Best-effort; the next prompt or doc_init retries.
          }
        } while (lineResyncAgain);
      } finally {
        lineResyncRun = null;
      }
    };
    const resyncFromSnapshot = (): Promise<void> => {
      if (lineResyncRun !== null) {
        lineResyncAgain = true;
        return lineResyncRun;
      }
      lineResyncRun = runLineResync();
      return lineResyncRun;
    };

    // Write an op the socket cannot carry. The op stays one commit and
    // one seq; only the transport differs, and the response carries the
    // seq an `op_ack` would have.
    const postOversizedOp = async (
      opBlobB64: string,
      clientOpId: string,
    ): Promise<OversizedOpResult> => {
      const { status, parsed: opResult } = await postOpAs(
        credential,
        docId,
        lineId,
        opBlobB64,
        clientOpId,
        baseImportSeqField(doc),
      );
      if (status < 200 || status >= 300) {
        return {
          ok: false,
          message: opWriteFailureMessage(status, opResult),
          retryable: opWriteIsRetryable(status),
          atCapacity: isCapacityRefusal(status, opResult),
          ...(isMovedRefusal(opResult) ? { moved: true } : {}),
          ...(isNotImportedRefusal(opResult) ? { notImported: true } : {}),
          ...(status === 413 ? { tooLarge: true } : {}),
          // The route answers 403 when the caller's grant carries no write
          // access, which is the HTTP face of the socket's `role_denied`.
          ...(status === 403 ? { readOnly: 'grant' as const } : {}),
        };
      }
      const seq = (opResult as { seq?: unknown } | undefined)?.seq;
      if (typeof seq !== 'number') {
        return {
          ok: false,
          message: 'The server did not report a version for this change.',
          retryable: false,
        };
      }
      return { ok: true, seq };
    };

    // The durability handshake's ground truth for this line, read from the
    // line's own join so the diff is against this stream's frontier.
    const refetchDurableFrontier = async (): Promise<{
      snapshotVersionVector?: string;
      tailBlobs: Uint8Array[];
    } | null> => {
      const res = await joinAs(credential, docId, lineOptions);
      if (res.status < 200 || res.status >= 300) return null;
      if (!isSnapshotResponse(res.parsed)) return null;
      const out: { snapshotVersionVector?: string; tailBlobs: Uint8Array[] } = {
        tailBlobs: res.parsed.tail_ops.map((entry) => base64ToBytes(entry.op_blob_b64)),
      };
      if (typeof res.parsed.snapshot_version_vector === 'string') {
        out.snapshotVersionVector = res.parsed.snapshot_version_vector;
      }
      return out;
    };

    const lineWsClient = wsClientFor(credential);
    if (lineWsClient) {
      wireDocTransport({
        doc,
        docId,
        branchId: lineId,
        wsClient: lineWsClient,
        postOversizedOp,
        refetchDurableFrontier,
        newClientOpId: opts.newClientOpId ?? defaultClientOpIdMinter,
        getCurrentSeq: () => currentSeq,
        setCurrentSeq: (next) => {
          if (next > currentSeq) currentSeq = next;
        },
        getCoveredSeq: () => coveredSeq,
        advanceCoveredSeq: advanceCoverage,
        resyncFromSnapshot,
        skipPresence: true,
        parkable: false,
        capacityReloadsDocument: false,
      });
    }
    return doc;
  }

  /**
   * A snapshot-only open: the ordinary join, materialised read-only, with no
   * transport wired.
   *
   * It reads the JOIN rather than the at-version route even though the two
   * envelopes match, because the join is what serves a record set as itself.
   * The at-version route materialises a LoroDoc to replay a tail onto, so it
   * converts a record set before answering; a reader asking for the document
   * as it stands has no tail to replay and would pay that conversion for
   * nothing.
   *
   * `readOnly` is what the caller asked for rather than a fact about their
   * grant, which is why it carries its own reason: an app that disables its
   * editor on `doc.readOnly` is right to, and the message a refused `mutate`
   * throws should say the caller opened a snapshot rather than blame a
   * permission they may well hold.
   */
  async function openSnapshotOnly(
    snapshot: { status: number; parsed: unknown; parseFailed: boolean },
    options: OpenDocumentByIdOptions,
  ): Promise<OpenedDocument> {
    const parsed = unwrapJoinResponse(snapshot, isSnapshotResponse, 'snapshot');
    return openParsedSnapshot(parsed, options);
  }

  async function openParsedSnapshot(
    parsed: DocumentSnapshotResponse,
    options: OpenDocumentByIdOptions,
  ): Promise<OpenedDocument> {
    // The grant's own reason wins where there is one. A viewer who asks for a
    // snapshot cannot edit either way, and telling them to reopen without
    // asking for one would be advice that does not work: the refusal has to
    // name the limit they actually have.
    const byGrant = readOnlyForGrant(parsed, options.documentOptions);
    const doc = await materialiseAs(
      SESSION,
      parsed,
      {
        ...byGrant,
        readOnly: true,
        readOnlyReason: byGrant?.readOnlyReason ?? 'snapshot',
      },
      options.onSnapshotProgress,
      { emptyAsFrozen: true },
    );
    // What one load brought: the point it was taken at, fixed until the next
    // load. A live open's provider is the transport's cursor and a
    // version-pinned one answers from its checkout, so this is what makes
    // `doc.currentSeq` mean the same thing on all three: the version the
    // reader is looking at. The change notice compares the document's head
    // against it.
    const takeLoad = (load: DocumentSnapshotResponse): void => {
      const takenAt = load.current_seq;
      if (typeof takenAt === 'number') doc.setCurrentSeqProvider(() => takenAt);
      // Work the join reported over the content it served: work that does not
      // lock readers (a push), or a new version's import that failed and left
      // the content in place. A join carries a status only while work is in
      // flight, so one with none after a pending load is the work having ended.
      if (load.status !== undefined) doc._emitStatus(load.status);
      else if (doc._workStatusNow?.pending === true) doc._emitStatus(WORK_READY_STATUS, { contentLoaded: true });
      doc._setImportReport(importReportOf(load));
      setJoinStamp(doc, (load as { updated_at?: unknown }).updated_at);
      setJoinedName(doc, load);
      watchFrom(load);
    };
    // An import is stored frozen, so a frozen open of a file nobody has
    // imported yet runs the app's importer the way an editable open does.
    doc._awaitsImport = parsed.awaits_import === true;
    if (opts.sourceBlobFetcher) {
      const fetcher = opts.sourceBlobFetcher;
      doc.setSourceBlobFetcher(() => fetcher(doc));
    }
    // A document's other streams open as frozen copies of their own lines,
    // read the same way and watched on their own topics.
    doc.setOpenedStreamName(options.stream ?? DEFAULT_STREAM_NAME);
    if (opts.streamProvider) {
      const provider = opts.streamProvider;
      const docId = parsed.doc_id;
      const openedBranchId = parsed.stream_branch_id ?? parsed.branch_id;
      doc.setStreamRuntime({
        list: async () => (await provider.list(docId, openedBranchId)).streams,
        create: () => Promise.reject(new Error('A read-only copy cannot create a stream.')),
        openLine: (lineId) => openFrozen(docId, frozenLineOptions(lineId)),
      });
    }
    const ws = opts.wsClient;
    const watchFrom = (load: DocumentSnapshotResponse): void => {
      if (!ws) return;
      const topic = `doc:${load.doc_id}:${load.branch_id}`;
      const at = typeof load.current_seq === 'number' ? load.current_seq : 0;
      // The copy reports the work that was in flight when it loaded, through to
      // its outcome, and nothing that starts afterwards: later work describes a
      // version of the document this copy does not hold.
      let following = load.status?.pending === true;
      doc._setChangeNotice((fire) =>
        ws.subscribe(
          topic,
          (frame) => {
            if (following && isDocStatusFrame(frame)) {
              const status = normalizeWorkStatus(frame.status);
              if (!status.pending) following = false;
              doc._emitStatus(status);
              doc._settleChangeNotice();
            }
            if (frameMovesDocument(frame, at)) fire();
          },
          {
            notice: true,
            onSubscribed: ({ currentSeq }) => {
              if (currentSeq !== undefined && currentSeq > at) fire();
              // Work that ends between the join and this subscribe sent its
              // frame to nobody, and may or may not have moved the seq, so a
              // copy taken mid-work asks the row whether it is still running.
              if (load.status?.pending !== true) return;
              void readFrozenWorkStatus(load.doc_id).then((now) => {
                if (now === 'unread' || now?.pending === true) return;
                doc._emitStatus(now ?? { pending: false, message: '' });
                fire();
              });
            },
          },
        ),
      );
    };
    takeLoad(parsed);
    // A frozen copy loads again only when the app asks. The join keeps the
    // open's read intent and names the stored frames whatever the copy holds
    // now, and the result applies in place (`applyJoin`) under the same
    // handles, switching between frozen content and a CRDT when the line has.
    const openedId = parsed.doc_id;
    //
    // A reload follows the open's rule: it waits out an import in flight and
    // loads what the import landed, and rejects (keeping what the copy holds)
    // when the import failed with nothing landed or the file is one only
    // another app imports. The open's progress sink belongs to the open, so
    // the reload's wait reports to none.
    const { onSnapshotProgress: _openProgress, ...reloadOptions } = options;
    doc._setFrozenReloader(async () => {
      const join = (): Promise<JoinAnswer> =>
        paceFrozen(async () => fetchSnapshot(openedId, reloadOptions, await requireToken()));
      const snapshot = await joinPastWork(openedId, reloadOptions, await join(), join);
      const load = unwrapJoinResponse(snapshot, isSnapshotResponse, 'snapshot');
      const applied = await applyJoin(doc, load, (url) => fetchPresignedSnapshot(url));
      if (applied.kind !== 'reloaded') takeLoad(load);
    });
    return doc;
  }

  // The row's work status as it is now, without a snapshot, or 'unread' when
  // the read fails.
  async function readFrozenWorkStatus(docId: string): Promise<DocumentWorkStatus | null | 'unread'> {
    const now = await readWorkStatus(docId);
    return now === 'gone' ? 'unread' : now;
  }

  // As `readFrozenWorkStatus`, with 'gone' for a document the caller can no
  // longer read (403 / 404).
  async function readWorkStatus(docId: string): Promise<DocumentWorkStatus | null | 'unread' | 'gone'> {
    try {
      const token = await requireToken();
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      applyClientVersionHeader(headers);
      await applyAppAssertionHeader(headers, opts.getAppAssertion);
      const response = await fetch(`${baseUrl}/documents/${encodeURIComponent(docId)}`, {
        method: 'GET',
        headers,
      });
      if (response.status === 403 || response.status === 404) return 'gone';
      if (!response.ok) return 'unread';
      const body = (await response.json()) as { status?: unknown };
      return parseWorkStatus(body.status);
    } catch {
      return 'unread';
    }
  }

  // An open joins past an import the join reports (`pendingImportWork`): it
  // waits for the import to end and joins again, so it resolves with what the
  // import landed, and rejects when the import failed with nothing landed.
  async function joinPastWork(
    docId: string,
    options: OpenDocumentByIdOptions | undefined,
    first: JoinAnswer,
    join: () => Promise<JoinAnswer>,
  ): Promise<JoinAnswer> {
    const deadline = Date.now() + OPEN_WAIT_CEILING_MS;
    let answer = first;
    for (;;) {
      const work = pendingImportWork(answer);
      if (work === null) {
        const failed = failedImportOf(answer);
        if (failed !== null) throw failed;
        return answer;
      }
      await waitForWorkToEnd(docId, work.topic, work.status, deadline, options?.onSnapshotProgress);
      answer = await join();
    }
  }

  // Resolves once the work ends: a terminal `doc_status` frame on the
  // document's topic, or a status read that finds it ended (on subscribe, and
  // on a backing-off poll for a frame that never arrives). Rejects when the
  // progress sink says a newer open superseded this one, and at `deadline`.
  async function waitForWorkToEnd(
    docId: string,
    topic: string,
    status: DocumentWorkStatus,
    deadline: number,
    progress: LoadProgress | undefined,
  ): Promise<void> {
    const superseded = (): boolean => progress?.(0, null, 'importing', status.message) === false;
    if (superseded()) throw new BrassError(OPEN_SUPERSEDED_MESSAGE, { status: 0 });
    const ended = (now: DocumentWorkStatus): boolean => !now.pending || now.blocking === false;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;
      const expiry = setTimeout(
        () => end(new BrassError(OPEN_WAIT_EXPIRED_MESSAGE, { status: 0 })),
        Math.max(0, deadline - Date.now()),
      );
      const end = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        clearTimeout(expiry);
        unsubscribe?.();
        if (err) reject(err);
        else resolve();
      };
      const check = async (): Promise<void> => {
        const now = await readWorkStatus(docId);
        if (now === 'unread') return;
        // A document the caller lost is left to the next join to report.
        if (now === 'gone' || now === null || ended(now)) end();
      };
      let delay = IMPORT_WAIT_POLL_MIN_MS;
      const poll = (): void => {
        timer = setTimeout(() => {
          timer = null;
          if (settled) return;
          if (superseded()) {
            end(new BrassError(OPEN_SUPERSEDED_MESSAGE, { status: 0 }));
            return;
          }
          void check().finally(() => {
            if (settled) return;
            delay = Math.min(delay * 2, IMPORT_WAIT_POLL_MAX_MS);
            poll();
          });
        }, delay);
      };
      if (opts.wsClient) {
        unsubscribe = opts.wsClient.subscribe(
          topic,
          (frame) => {
            if (isDocStatusFrame(frame) && ended(normalizeWorkStatus(frame.status))) end();
          },
          { notice: true, onSubscribed: () => void check() },
        );
      }
      poll();
    });
  }

  // A frozen open: a snapshot that watches for the document moving once a
  // listener asks it to. A set is opened as a loop over its ids, so joins
  // are paced here, which is what keeps such a loop fast without letting it
  // flood the api. The pace covers the join alone: the content download
  // goes to storage rather than the api, and holding a lane through it
  // leaves the next join waiting on bytes the api is not serving.
  async function openFrozen(docId: string, options: OpenDocumentByIdOptions): Promise<OpenedDocument> {
    const join = (): Promise<JoinAnswer> =>
      paceFrozen(async () => fetchSnapshot(docId, options, await requireToken()));
    // The wait sits outside the pace, which covers a join and not the time
    // between two of them.
    const snapshot = await joinPastWork(docId, options, await join(), join);
    return openSnapshotOnly(snapshot, options);
  }
  const paceFrozen = createPacer(FROZEN_OPEN_LANES);

  // What a signed-in open reaches beyond the transport.
  function wireSessionCapabilities(
    doc: OpenedDocument,
    docId: string,
    parsed: DocumentSnapshotResponse,
    options: OpenDocumentByIdOptions | undefined,
  ): void {
      // `doc._checkoutVersion(v)` calls back here to materialise historical
      // state, leaving the live subscription untouched.
      doc.setCheckoutFetcher(makeCheckoutFetcher());
      // Wire the branch provider + populate the initial list, so the
      // toolbar's branch chip can name the branch on the next subscribe
      // tick. Branch management is hosted; this list feeds the SDK's own
      // chrome, not an app method.
      if (opts.branchProvider) {
        doc.setBranchProvider(opts.branchProvider);
        void doc._refreshBranches().catch(() => {
          // Best-effort: a failure leaves the chip unnamed until a hosted
          // branch action refreshes the list.
        });
      }
      // `doc.useCanvas(canvas)` captures + uploads after each local commit; the
      // doc handles debounce + readOnly gating internally.
      if (opts.thumbnailUploader) {
        const uploader = opts.thumbnailUploader;
        doc.setThumbnailUploader(async (image, width, height, version) => {
          await uploader(doc, image, width, height, version);
        });
      }
      doc._setThumbnailVersion(parsed.thumbnail?.version ?? null);
      if (opts.checkpointCreator) {
        const creator = opts.checkpointCreator;
        doc.setCheckpointCreator((anchor) => creator(doc, anchor));
      }
      if (opts.drivePusher) {
        const pusher = opts.drivePusher;
        doc.setDrivePusher((input) => pusher(doc, input));
      }
      // `doc.resolveDrive()` opens the hosted resolution surface and, when it
      // names a document to switch onto, re-opens onto it via the same
      // `openSiblingDoc` path the `history` fork uses.
      const hostedForResolve = opts.hostedUiProvider;
      const resolveSurface = hostedForResolve?.driveResolve;
      if (hostedForResolve && resolveSurface) {
        doc.setDriveResolver(async () => {
          const docId = doc.id;
          if (docId === null) return null;
          const result = await resolveSurface(docId);
          if (result?.newDocId && hostedForResolve.openSiblingDoc) {
            await hostedForResolve.openSiblingDoc(result.newDocId, {});
          }
          return result;
        });
      }
      if (opts.sourceBlobFetcher) {
        const fetcher = opts.sourceBlobFetcher;
        doc.setSourceBlobFetcher(() => fetcher(doc));
      }
      setJoinStamp(doc, (parsed as { updated_at?: unknown }).updated_at);
      setJoinedName(doc, parsed);
      const poster = opts.provisionalInputsPoster;
      if (poster) doc._setProvisionalInputsPoster((post, o) => poster(docId, post, o));
      doc.setOpenedStreamName(options?.stream ?? DEFAULT_STREAM_NAME);
      // Streams: manifest list/create over HTTP plus the per-line open
      // (join + WS subscribe). Bound to the BRANCH this Document opened on,
      // which is not the line it materialized when the open named a stream: a
      // manifest belongs to a branch and a line owns none, so binding to the
      // line would leave `doc.stream(name)` resolving against nothing.
      if (opts.streamProvider) {
        const provider = opts.streamProvider;
        const openedBranchId = parsed.stream_branch_id ?? parsed.branch_id;
        doc.setStreamRuntime({
          list: async () =>
            (await provider.list(docId, openedBranchId)).streams,
          create: (name) => provider.create(docId, openedBranchId, name),
          openLine: (lineId) => openStreamLine(docId, lineId, options),
        });
      }
      // Hosted-UI provider backing the doc's built-in `history` / `details` /
      // `share` / `delete` commands.
      if (opts.hostedUiProvider) {
        doc.setHostedUiProvider(opts.hostedUiProvider);
        const refreshName = opts.hostedUiProvider.refreshName;
        if (refreshName && docId) {
          void refreshName(docId).then((name) => {
            if (name !== null) doc._setName(name);
          });
        }
      }
  }

  // What a share link's open reaches beyond the transport: the routes that
  // take the link as the credential, and the link's own stream manifest.
  function wireLinkCapabilities(
    doc: OpenedDocument,
    docId: string,
    parsed: DocumentSnapshotResponse,
    credential: Exclude<OpenCredential, { kind: 'session' }>,
    options: OpenDocumentByIdOptions | undefined,
    writes: boolean,
  ): void {
    const { token } = credential;
    setJoinStamp(doc, (parsed as { updated_at?: unknown }).updated_at);
    setJoinedName(doc, parsed);
    doc.setOpenedStreamName(options?.stream ?? DEFAULT_STREAM_NAME);
    if (writes) {
      doc.setCheckpointCreator(async (anchor) => {
        const version = anchor?.version ?? doc.currentSeq;
        if (version === null) {
          throw new BrassError('createCheckpoint: the document has no resolved version yet', { status: 400 });
        }
        const res = await postWithLink<{
          checkpoint: import('./documents-namespace.js').DocumentCheckpoint;
        }>(token, `/documents/${encodeURIComponent(docId)}/checkpoints`, {
          version,
          ...(doc.branchId !== null ? { branch_id: doc.branchId } : {}),
        });
        return res.checkpoint;
      });
    }
    doc.setStreamRuntime({
      list: () => fetchLinkStreamManifest(token),
      openLine: (lineId) => openStreamLine(docId, lineId, options, credential),
      create: async (name) => {
        if (!writes) {
          throw new BrassError('A shared-link guest cannot create streams.', { status: 403 });
        }
        const info = await postWithLink<{ name: string; format: string; line_id: string }>(
          token,
          `/documents/${encodeURIComponent(docId)}/streams`,
          { name, branch_id: parsed.branch_id },
        );
        return { name: info.name, format: info.format, line_id: info.line_id, created_at: '', created_by: '' };
      },
    });
  }

  async function finalise(
    docId: string,
    snapshot: { status: number; parsed: unknown; parseFailed: boolean },
    options: OpenDocumentByIdOptions | undefined,
    credential: OpenCredential = SESSION,
  ): Promise<OpenedDocument> {
    const parsed = unwrapJoinResponse(snapshot, isSnapshotResponse, 'snapshot');
    // A caller who asked for a read-only document is told so in the words for
    // that, not a share link's.
    const asked = options?.documentOptions;
    const doc = await materialiseAs(
      credential,
      parsed,
      readOnlyForGrant(
        parsed,
        asked?.readOnly === true && asked.readOnlyReason === undefined
          ? { ...asked, readOnlyReason: 'snapshot' }
          : asked,
      ),
      options?.onSnapshotProgress,
    );
    // Populate `doc.status` from the join before the first `doc_status` frame.
    if (parsed.status !== undefined) doc._emitStatus(parsed.status);
    doc._setImportReport(importReportOf(parsed));
    setJoinStamp(doc, (parsed as { updated_at?: unknown }).updated_at);
    doc._awaitsImport = parsed.awaits_import === true;
    // Whether this app is the one to serialize the document, which is what
    // decides whether a push carries bytes. Answered by the server for the
    // caller's own app and only on the join, since the fanout frame is one
    // payload for every subscriber and has no caller to answer for.
    doc._setExportRunsHere(parsed.calling_app_exports === true);
    // Seed `doc.driveStatus` from the join before the first
    // `doc_drive_status` frame.
    if (parsed.drive !== undefined) {
      doc._emitDriveStatus(toDriveStatus(parsed.drive));
    } else {
      // Only for a document that mirrors nothing: a mirror publishes through
      // its link, and `_emitDriveStatus` clears any targets anyway.
      doc._setPublishTarget(toPublishTarget(parsed.drive_publish_target));
    }
    // Highest seq seen; later `doc_op` / `op_ack` frames advance it. Kept in
    // a closure, not on the Document: it is a transport concern, not CRDT
    // state.
    let currentSeq = Math.max(
      parsed.tail_ops.reduce(
        (acc, entry) => (entry.seq > acc ? entry.seq : acc),
        0,
      ),
      typeof parsed.current_seq === 'number' ? parsed.current_seq : 0,
    );

    // Contiguous-coverage floor: every op with seq <= coveredSeq is applied
    // (or never existed). Separate from `currentSeq` (max seq SEEN) because
    // out-of-order fanout can inflate a max-seen cursor past a hole, which
    // then can't tell "caught up" from "missed ops since compacted into the
    // snapshot". The floor never overestimates, so the `doc_init` resync
    // check always detects such a hole (at worst a transient out-of-order
    // arrival costs one idempotent re-fetch).
    //
    // Seeded from what this join DELIVERED, which is its snapshot plus the
    // unbroken run of tail seqs above it, never from `current_seq`: a join
    // read while someone writes in bulk reports a counter above the rows it
    // could see, and seeding from the counter opens the document already
    // claiming ops it does not hold.
    let coveredSeq = joinCoverageFloor(
      snapshotSeqOf(
        parsed.snapshot_seq,
        parsed.tail_ops.map((entry) => entry.seq),
        typeof parsed.current_seq === 'number' ? parsed.current_seq : 0,
      ),
      parsed.tail_ops.map((entry) => entry.seq),
    );
    // Seqs applied above the floor, parked until the gap below fills.
    const coverageParked = new Set<number>();
    const drainCoverage = (): void => {
      while (coverageParked.has(coveredSeq + 1)) {
        coverageParked.delete(coveredSeq + 1);
        coveredSeq += 1;
      }
    };
    const advanceCoverage = (seq: number): void => {
      if (seq <= coveredSeq) return;
      coverageParked.add(seq);
      drainCoverage();
    };
    // Mark everything at or below `floor` covered. The caller owes the
    // guarantee that goes with it: every seq under `floor` is applied, or
    // folded into a snapshot this doc imported. Coverage is what retires a
    // catch-up prompt, so a floor taken from anything looser than that is a
    // reader quietly deciding it holds ops nobody sent it.
    const raiseCoverage = (floor: number): void => {
      if (floor > coveredSeq) coveredSeq = floor;
      for (const seq of coverageParked) {
        if (seq <= coveredSeq) coverageParked.delete(seq);
      }
      drainCoverage();
    };
    for (const entry of parsed.tail_ops) advanceCoverage(entry.seq);

    // Re-fetch the join snapshot and import it into the live doc. Shared by
    // the authoritative reload and the subscribe-time reconcile; returns the
    // refreshed work-status (so reconcile tells pending / failed / succeeded
    // apart) and a failure `reason` naming the broken step. `_applySnapshot`
    // clears the undo stack; the doc was held read-only (empty) while
    // pending, so this is a clean merge. Idempotent: re-importing the same
    // snapshot / ops are no-ops in Loro.
    const refetchAndImport = async (): Promise<
      | { ok: true; status: DocumentWorkStatus | undefined }
      | { ok: false; reason: string }
    > => {
      const endPerf = perfStart('doc: content reload (fetch + import)');
      // Refetch the branch this doc was opened on, not the default. `parsed`
      // is the opened-branch join, so its `branch_id` is authoritative;
      // dropping it would import the default branch's snapshot + tail into a
      // doc open on another branch and silently merge the wrong CRDT state.
      // The open's read intent too: a reader who opened a record set as one
      // re-joins as one, rather than as a writer whose join converts it.
      const result = await joinAs(credential, docId, rejoinOptions(parsed.branch_id, options));
      if (result.status < 200 || result.status >= 300) {
        endPerf({ ok: false, joinStatus: result.status });
        return { ok: false, reason: `join fetch returned ${result.status}` };
      }
      if (!isSnapshotResponse(result.parsed)) {
        endPerf({ ok: false, joinStatus: result.status });
        return { ok: false, reason: 'malformed join response' };
      }
      doc._awaitsImport = result.parsed.awaits_import === true;
      let applied: JoinApplied;
      try {
        // Stream through the same progress sink the initial open uses, so the
        // session surfaces "Downloading... NN%" instead of sitting on the
        // last server phase.
        applied = await applyJoin(doc, result.parsed, (url) =>
          fetchPresignedSnapshot(url, options?.onSnapshotProgress),
        );
      } catch (err) {
        const status = err instanceof BrassError ? err.status ?? 0 : 0;
        endPerf({ ok: false, snapshotStatus: status });
        return {
          ok: false,
          reason:
            status > 0
              ? `snapshot read returned ${status}`
              : `snapshot read failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (applied.kind !== 'applied') {
        endPerf({ ok: true, joinStatus: result.status, reloaded: applied.kind === 'reloaded' });
        return { ok: true, status: result.parsed.status };
      }
      const tailSeqs = applied.tailSeqs;
      let maxTailSeq = 0;
      for (const seq of tailSeqs) {
        if (seq > currentSeq) currentSeq = seq;
        if (seq > maxTailSeq) maxTailSeq = seq;
      }
      const fetchedSeq =
        typeof result.parsed.current_seq === 'number'
          ? result.parsed.current_seq
          : maxTailSeq;
      if (fetchedSeq > currentSeq) currentSeq = fetchedSeq;
      // Coverage moves to what this response DELIVERED, not to the head it
      // reported. The two differ exactly when it matters: the head is the
      // branch's seq counter, bumped when a seq is handed out rather than
      // when its row is written, so a join read during a bulk write names
      // ops the tail query could not see. Crediting the head marks those
      // seqs covered, and the prompts that would fetch them then short
      // circuit, which is a reader left permanently short of a write it
      // watched land.
      //
      // The cost is that a seq allocated and never written (a failed op
      // write leaves a hole rather than a duplicate) now stalls the floor
      // under it. That resolves at the next compaction, which folds the tail
      // past the hole and raises `snapshot_seq` over it; until then the gap
      // pull's own budget is what stops the reader asking forever.
      raiseCoverage(
        joinCoverageFloor(
          snapshotSeqOf(result.parsed.snapshot_seq, tailSeqs, fetchedSeq),
          tailSeqs,
        ),
      );
      for (const seq of tailSeqs) advanceCoverage(seq);
      endPerf({
        ok: true,
        snapshotBytes: applied.content.kind === 'crdt' ? applied.content.bytes.byteLength : 0,
        tailOps: tailSeqs.length,
      });
      return { ok: true, status: result.parsed.status };
    };

    // Fetch just the durability-handshake ground truth from the HTTP join:
    // the persisted snapshot version vector and the durable tail op blobs.
    // Unlike `refetchAndImport` this downloads no snapshot blob and imports
    // nothing (the handshake only needs the frontier to diff against), so it
    // is one cheap JSON round-trip.
    const refetchDurableFrontier = async (): Promise<{
      snapshotVersionVector?: string;
      tailBlobs: Uint8Array[];
    } | null> => {
      // Same-branch as `refetchAndImport`: the durability handshake must diff
      // against the opened branch's frontier, not the default branch's.
      const result = await joinAs(credential, docId, rejoinOptions(parsed.branch_id, options));
      if (result.status < 200 || result.status >= 300) return null;
      if (!isSnapshotResponse(result.parsed)) return null;
      const tailBlobs = result.parsed.tail_ops.map((entry) =>
        base64ToBytes(entry.op_blob_b64),
      );
      const out: { snapshotVersionVector?: string; tailBlobs: Uint8Array[] } = {
        tailBlobs,
      };
      if (typeof result.parsed.snapshot_version_vector === 'string') {
        out.snapshotVersionVector = result.parsed.snapshot_version_vector;
      }
      return out;
    };

    // Coalesced, not skipped. A prompt that lands while a join is in flight
    // is a statement that the document has moved past what that join can
    // possibly carry, so dropping it loses the only notice this reader gets:
    // the server posts each prompt once, and a passive reader has no ack or
    // op of its own to notice the shortfall from. A bulk write is a run of
    // prompts (every op past the frame bound takes the HTTP route and
    // prompts each subscriber), and under a plain skip-if-in-flight the
    // whole run collapses into the one or two joins that happened not to be
    // busy, which is a reader stranded partway through a write it watched.
    //
    // `resyncAgain` is a flag rather than a queue because a join reads the
    // whole document: one more pass answers every prompt that arrived during
    // this one. The loop therefore runs at most one extra fetch after the
    // last prompt, and settles when the writer stops.
    //
    // The returned promise settles when the last pass this call is
    // responsible for has landed, so a caller deciding whether the reader is
    // still short reads the floor after the work rather than during it.
    let resyncRun: Promise<void> | null = null;
    let resyncAgain = false;
    const runResync = async (): Promise<void> => {
      try {
        do {
          resyncAgain = false;
          try {
            const outcome = await refetchAndImport();
            if (!outcome.ok) {
              console.error(
                'Brass: document resync after reconnect failed; state may lag until the next reconnect or reload',
              );
            }
          } catch (err) {
            console.error(
              'Brass: document resync after reconnect failed; state may lag until the next reconnect or reload',
              err,
            );
          }
        } while (resyncAgain);
      } finally {
        resyncRun = null;
      }
    };
    const resyncFromSnapshot = (): Promise<void> => {
      if (resyncRun !== null) {
        resyncAgain = true;
        return resyncRun;
      }
      resyncRun = runResync();
      return resyncRun;
    };

    // When a doc opened mid-load finishes, pull the now-available content
    // into the live doc so it appears without the app reopening. Only ever
    // called on the server's authoritative `reload` hint, so it never has to
    // tell success from failure: a failure carries no `reload`, so no racy
    // read and no loop against a failed hydration.
    let reloadInFlight = false;
    let reconcileInFlight = false;
    // A terminal frame that lands while the subscribe-time reconcile is still
    // fetching waits for it: two concurrent imports each clear the undo stack
    // and race their terminal emits, and dropping the frame would leave a
    // reconcile that read the row too early sitting on the pending overlay.
    let deferredReload: DocumentWorkStatus | null = null;
    // Armed when the pull below gives up. The work is terminal server-side, so
    // no further status frame arrives, and later ops are causally dependent on
    // a snapshot this client never imported (Loro buffers them and the doc
    // stays empty), so the next frame on the topic drives one more attempt.
    let retryPullOnNextFrame = false;
    const reloadAfterHydration = (finalStatus: DocumentWorkStatus): void => {
      if (reloadInFlight) return;
      if (reconcileInFlight) {
        deferredReload = finalStatus;
        return;
      }
      reloadInFlight = true;
      void (async () => {
        const imported = await pullContentWithRetry({
          doc,
          docId,
          finalStatus,
          fetchAndImport: refetchAndImport,
          ...(opts.reportError ? { reportError: opts.reportError } : {}),
        });
        reloadInFlight = false;
        retryPullOnNextFrame = !imported;
      })();
    };

    // The row's work status as it is now, read without a snapshot, for a
    // frame whose claim about the row needs checking.
    const readWorkStatus = async (): Promise<DocumentWorkStatus | null> => {
      const body = (await readStatusAs(credential, docId)) as { status?: unknown };
      return parseWorkStatus(body.status);
    };

    // A `pending` frame that would take a settled document back to loading is
    // checked against the row before it locks anything. A frame is the
    // stream's view of the row at the time of that write, delivered after the
    // stream's own lag, while the reconcile above reads the row directly: a
    // client that reconciles between a hydration's last phase write and the
    // stream delivering it has already imported the content when that
    // phase's frame arrives, and applying it locks a document whose work is
    // done. An importer that ran off the reconcile's own ready status then
    // writes into that lock and is refused. Progress inside a run the
    // document already shows as pending applies without a read; only the
    // regression from settled to pending pays one, and that one read answers
    // for every frame that arrives while it is out. A read that fails applies
    // the frame, since locking is the side that loses nothing.
    let pendingVerifyInFlight = false;
    const verifyPendingStatus = (status: DocumentWorkStatus): void => {
      if (pendingVerifyInFlight) return;
      pendingVerifyInFlight = true;
      void (async () => {
        let current: DocumentWorkStatus | null | 'unread' = 'unread';
        try {
          current = await readWorkStatus();
        } catch {
          // Unread: the frame stands.
        } finally {
          pendingVerifyInFlight = false;
        }
        if (current === 'unread') {
          doc._emitStatus(status);
        } else if (current !== null && current.pending) {
          doc._emitStatus(current);
        }
      })();
    };

    // Evidence the document moved on the server after a give-up: one more
    // pull, which on success imports the content and releases the lock the
    // failed terminal status left in place.
    const retryContentPull = (): void => {
      if (!retryPullOnNextFrame) return;
      retryPullOnNextFrame = false;
      reloadAfterHydration(WORK_READY_STATUS);
    };

    // Reconcile pending work once the live subscription exists (a resubscribe
    // while work runs). The terminal `doc_status` frame is best-effort: if the
    // work finishes while this client has no subscription record, the fan-out
    // finds no subscriber and drops the frame, stranding the app on the pending
    // overlay. `doc_init` is posted only after the subscription record is
    // written, so one re-fetch here closes the gap. Only a pending document
    // pays the extra fetch.
    const reconcileStatusOnInit = (): void => {
      const current = doc._workStatusNow;
      if (!current || !current.pending) return;
      if (reconcileInFlight || reloadInFlight) return;
      reconcileInFlight = true;
      void (async () => {
        let settled = false;
        try {
          const outcome = await refetchAndImport();
          if (!outcome.ok) return;
          // Still pending: leave the overlay up; subscribed now, so the live
          // fan-out delivers the terminal frame when the work finishes.
          if (outcome.status?.pending) return;
          settled = true;
          // Terminal. A status the server still holds is a failure (success
          // clears the row), and its absence is the success this import just
          // pulled the content for, reported as the same terminal frame the
          // platform sends on that transition.
          if (outcome.status) doc._emitStatus(outcome.status);
          else doc._emitStatus(WORK_READY_STATUS, { contentLoaded: true });
        } catch {
          // Best-effort; the live fan-out remains the primary path when
          // the work finishes after this subscribe.
        } finally {
          reconcileInFlight = false;
          const deferred = deferredReload;
          deferredReload = null;
          // A settled reconcile imported the content itself, so the held
          // frame has nothing left to pull.
          if (deferred && !settled) reloadAfterHydration(deferred);
        }
      })();
    };

    // Write an op the socket cannot carry. The op stays one commit and one
    // seq; only the transport differs, and the response carries the seq an
    // `op_ack` would have. Targets the branch this doc was opened on, the
    // same branch the transport's topic is scoped to.
    const postOversizedOp = async (
      opBlobB64: string,
      clientOpId: string,
    ): Promise<OversizedOpResult> => {
      const { status, parsed: opResult } = await postOpAs(
        credential,
        docId,
        parsed.branch_id,
        opBlobB64,
        clientOpId,
        baseImportSeqField(doc),
      );
      if (status < 200 || status >= 300) {
        return {
          ok: false,
          message: opWriteFailureMessage(status, opResult),
          retryable: opWriteIsRetryable(status),
          atCapacity: isCapacityRefusal(status, opResult),
          ...(isMovedRefusal(opResult) ? { moved: true } : {}),
          ...(isNotImportedRefusal(opResult) ? { notImported: true } : {}),
          ...(status === 413 ? { tooLarge: true } : {}),
          // The route answers 403 when the caller's grant carries no write
          // access, which is the HTTP face of the socket's `role_denied`.
          ...(status === 403 ? { readOnly: 'grant' as const } : {}),
        };
      }
      const seq = (opResult as { seq?: unknown } | undefined)?.seq;
      if (typeof seq !== 'number') {
        return {
          ok: false,
          message: 'The server did not report a version for this change.',
          retryable: false,
        };
      }
      return { ok: true, seq };
    };

    const docWsClient = wsClientFor(credential);
    if (docWsClient) {
      wireDocTransport({
        doc,
        docId,
        // Scope the subscription to the branch the server materialized so
        // edits land on the opened branch rather than the default.
        branchId: parsed.branch_id,
        // The park cache keys on the requested branch, not the resolved one,
        // so take/park stay symmetric (see WireDocTransportArgs).
        ...(options?.branch !== undefined
          ? { requestedBranchId: options.branch }
          : {}),
        ...(options?.stream !== undefined ? { requestedStream: options.stream } : {}),
        ...(options?.documentOptions !== undefined
          ? { documentOptions: options.documentOptions }
          : {}),
        ...(opts.identity !== undefined ? { identity: opts.identity } : {}),
        // A link's open is parked under nobody, and a frozen copy hears
        // whole-document notices rather than joining the room.
        ...(credential.kind === 'session' ? {} : { parkable: false, skipPresence: options?.frozen === true }),
        wsClient: docWsClient,
        postOversizedOp,
        newClientOpId: opts.newClientOpId ?? defaultClientOpIdMinter,
        getCurrentSeq: () => currentSeq,
        setCurrentSeq: (next) => {
          if (next > currentSeq) currentSeq = next;
        },
        getCoveredSeq: () => coveredSeq,
        advanceCoveredSeq: advanceCoverage,
        resyncFromSnapshot,
        refetchDurableFrontier,
        reloadAfterHydration,
        reconcileStatusOnInit,
        verifyPendingStatus,
        onDocumentMoved: retryContentPull,
      });
    }
    if (credential.kind === 'session') wireSessionCapabilities(doc, docId, parsed, options);
    else wireLinkCapabilities(doc, docId, parsed, credential, options, doc.readOnly !== true);
    if (opts.reportError) doc.setErrorReporter(opts.reportError);
    // No socket on a document the caller can write to: the write path reaches
    // no server, so the document reports the first attempt rather than
    // discarding it. Outside tests this is `wsBaseUrl` left unset, which
    // naming any other base URL does.
    if (!opts.wsClient && !doc.readOnly) doc.markTransportUnavailable();
    return doc;
  }

  // Open at a historical version: read-only, no transport. The at-version
  // route returns the same snapshot + tail_ops envelope the join uses, so
  // `materialise` builds it; `readOnly` + the effective version thread
  // through `documentOptions` and `wireDocTransport` is skipped (a frozen
  // point has no live op stream).
  async function openAtVersion(
    docId: string,
    version: number,
    options: OpenDocumentByIdOptions,
    token: string,
  ): Promise<OpenedDocument> {
    const parsed = unwrapJoinResponse(
      await fetchAtVersion(docId, version, options.branch, token),
      isAtVersionResponse,
      'at-version',
    );
    return materialiseAs(
      SESSION,
      {
        doc_id: docId,
        branch_id: parsed.branch_id,
        snapshot: parsed.snapshot,
        tail_ops: parsed.tail_ops,
      },
      {
        ...options.documentOptions,
        readOnly: true,
        version: parsed.effective_version,
      },
    );
  }

  // `GET /links/{token}/view?include=snapshot`: the anonymous guest read.
  // Sends NO Authorization header (the token is the credential), so it must
  // not go through the auth-bearing `fetchSnapshot`. The server returns the
  // same snapshot + tail_ops envelope, member-stripped and read-only.
  async function fetchLinkView(
    token: string,
    // The line, and whether this guest will write. A view link's reader never
    // does, and an edit link's may, which is the same question the
    // authenticated join asks with `intent=read` and decides the same thing:
    // whether a document the platform stores frozen is served as it stands or
    // converted first.
    join: OpenDocumentByIdOptions,
    progress?: LoadProgress,
    { rejoin = false }: { rejoin?: boolean } = {},
  ): Promise<JoinAnswer> {
    const once = (): Promise<JoinAnswer> => linkViewOnce(token, join, rejoin);
    // An edit link's guest waits out a conversion as a member's editable open
    // does.
    return opensReadOnly(join) ? once() : waitWhileConverting(once, progress);
  }

  async function linkViewOnce(
    token: string,
    join: OpenDocumentByIdOptions,
    rejoin: boolean,
  ): Promise<JoinAnswer> {
    const search = new URLSearchParams();
    search.set('include', 'snapshot');
    search.set('app_id', opts.appId);
    if (rejoin) search.set('rejoin', '1');
    const headers = await linkViewHeaders();
    // A person signed in here who reaches the document on their own opens it
    // as themselves, with their own role and identity.
    if (!rejoin && headers['authorization'] !== undefined) search.set('as_member', '1');
    if (join.branch !== undefined) search.set('branch', join.branch);
    if (opensReadOnly(join)) search.set('intent', 'read');
    return sendJoin(`/links/${encodeURIComponent(token)}/view`, search, { headers });
  }

  // A link open carries no credential unless the person signed in on this
  // link page, in which case it carries theirs.
  async function linkViewHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    applyClientVersionHeader(headers);
    const credential = (await opts.getLinkCredential?.()) ?? null;
    if (credential !== null) {
      headers['authorization'] = `Bearer ${credential.accessToken}`;
      headers['x-brass-app-assertion'] = credential.appAssertion;
    }
    return headers;
  }

  // `GET /links/{token}/streams`: the anonymous stream manifest, the guest
  // counterpart of the signed-in streams list. No Authorization header (the
  // token is the credential). Returns the manifest entries the guest's
  // `doc.stream(name)` resolves against.
  async function fetchLinkStreamManifest(
    token: string,
  ): Promise<import('./documents-namespace.js').DocumentStreamInfo[]> {
    const url = `${baseUrl}/links/${encodeURIComponent(token)}/streams`;
    const headers: Record<string, string> = {};
    applyClientVersionHeader(headers);
    const response = await fetchWithRetry(() => fetch(url, { method: 'GET', headers }));
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      let parsed: unknown = undefined;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      throw brassErrorFromBody(response.status, parsed);
    }
    const body = (text ? JSON.parse(text) : {}) as {
      streams?: Array<{
        name?: unknown;
        format?: unknown;
        line_id?: unknown;
      }>;
    };
    const streams = Array.isArray(body.streams) ? body.streams : [];
    // `created_at` / `created_by` are stripped from the guest manifest (a
    // guest never learns who a doc's members are); default them so the info
    // shape stays uniform. Apps only need `name`.
    return streams.flatMap((s) =>
      typeof s.name === 'string' &&
      typeof s.format === 'string' &&
      typeof s.line_id === 'string'
        ? [
            {
              name: s.name,
              format: s.format,
              line_id: s.line_id,
              created_at: '',
              created_by: '',
            },
          ]
        : [],
    );
  }

  const openByLink: OpenDocumentByLinkFn = async (token, asked) => {
    const options = withReadIntent(asked);
    const view = await fetchLinkView(
      token,
      rejoinOptions(options?.branch, options),
      options?.onSnapshotProgress,
    );
    if (view.status < 200 || view.status >= 300) {
      throw brassErrorFromBody(view.status, view.parseFailed ? undefined : view.parsed);
    }
    const b = view.parsed as {
      doc_id?: unknown;
      opens_as_member?: unknown;
      link_role?: unknown;
      status?: unknown;
      anonymous?: unknown;
      expires_at?: unknown;
      awaits_import?: unknown;
      can_edit?: unknown;
      read_only_reason?: unknown;
    };
    if (typeof b.doc_id !== 'string') {
      throw new BrassError('Malformed link view response', { status: 500 });
    }
    if (b.opens_as_member === true) {
      return (opts.openAsMember ?? open)(b.doc_id, asked);
    }
    // The link's grant decides read vs write; the view answers `can_edit`
    // as the member join does, so a view link reads as a viewer's grant.
    const canEdit = b.link_role === 'editor' && b.can_edit !== false;
    const askedToRead = canEdit && opensReadOnly(options);
    const linkOptions: OpenDocumentByIdOptions = {
      ...options,
      documentOptions: askedToRead
        ? { ...options?.documentOptions, readOnly: true, readOnlyReason: 'snapshot' }
        : canEdit
          ? { ...options?.documentOptions }
          : { ...options?.documentOptions, readOnly: true, readOnlyReason: 'link' },
    };
    // A document minted without an account names when the platform removes
    // it; every other link carries neither key.
    const expiresAt = anonymousExpiry(b);
    const credential: OpenCredential =
      expiresAt !== null ? { kind: 'temporary', token } : { kind: 'link', token };
    const doc = await finalise(b.doc_id, view, linkOptions, credential);
    if (expiresAt !== null) {
      doc._setExpiresAt(expiresAt);
      // A document the visitor started from a file is imported by this app
      // in this page, so it reads its file through the link as a member's
      // import reads it through the document.
      const imports = guestImports(token, b.doc_id);
      doc.setSourceBlobFetcher(() => imports.sourceBlob());
      doc._awaitsImport = canEdit && b.awaits_import === true;
    }
    return doc;
  };

  // A read through a route a member's open reads, with the link as the
  // credential. A 404 answers null, as the session's reads of the same
  // routes do.
  async function getWithLink(token: string, path: string, query: Record<string, string>): Promise<unknown> {
    const search = new URLSearchParams(query).toString();
    const response = await fetch(`${baseUrl}${search ? `${path}?${search}` : path}`, {
      headers: { authorization: `Link ${token}` },
    });
    if (response.status === 404) return null;
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (response.status < 200 || response.status >= 300) {
      throw brassErrorFromBody(response.status, parsed);
    }
    return parsed;
  }

  // A write through a route a member's open writes, with the link as the
  // credential. Resolves the parsed body, or rejects with the server's
  // refusal.
  async function postWithLink<T>(token: string, path: string, body: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Link ${token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (response.status < 200 || response.status >= 300) {
      throw brassErrorFromBody(response.status, parsed);
    }
    return parsed as T;
  }

  // Write a guest's op over HTTP: `POST /links/{token}/ops`, the anonymous
  // counterpart of `POST /documents/{docId}/ops`. Sends NO Authorization
  // header (the token is the credential) and names the line the guest
  // opened, which is the branch its socket topic is scoped to. An op past
  // what a request body carries is staged first, as a member's is.
  async function postLinkOp(
    token: string,
    docId: string,
    lineId: string,
    opBlobB64: string,
    clientOpId: string,
    base: { base_import_seq?: number } = {},
  ): Promise<{ status: number; parsed: unknown }> {
    const stagedKey = opBlobNeedsStaging(opBlobB64)
      ? await stageOpBlob(docId, opBlobB64, { link: token })
      : undefined;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    applyClientVersionHeader(headers);
    const response = await fetch(
      `${baseUrl}/links/${encodeURIComponent(token)}/ops`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(stagedKey === undefined ? { op_blob: opBlobB64 } : { upload_key: stagedKey }),
          branch_id: lineId,
          client_op_id: clientOpId,
          ...base,
        }),
      },
    );
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: response.status, parsed };
  }



  // Strict open: a 404 propagates as `BrassError`. A `version` option
  // diverts to the read-only at-version path.
  const open: OpenDocumentByIdFn = async (docId, asked) => {
    if (asked?.frozen === true && asked.readOnly === false) {
      throw new TypeError('openDocumentById: a frozen copy is read-only, so `readOnly: false` cannot apply');
    }
    const requested = withReadIntent(asked);
    const options = requested?.frozen === true ? frozenOptions(requested) : requested;
    if (requested?.frozen === true) return openFrozen(docId, options!);
    // Cache hit: return the parked Document. Its subscription stayed alive
    // while parked, and the UndoController + outstanding-op map survived, so
    // undo works as if the user never switched away.
    const parked = takeParkedDocument(docId, options, opts.identity?.() ?? null);
    if (parked) {
      parked._resume();
      return parked as OpenedDocument;
    }
    const endTotal = perfStart('open: openDocumentById total');
    const token = await requireToken();
    if (options?.version !== undefined) {
      const atVersion = await openAtVersion(
        docId,
        options.version,
        options,
        token,
      );
      endTotal({ docId, path: 'at-version' });
      return atVersion;
    }
    // An editable open waits until the document takes edits. One that never
    // will is refused terminally, and is then read as a reader would read it.
    // An import the platform runs holds every open until it lands, the file's
    // first import or a new version's, so the open resolves with its content.
    let snapshot = await fetchSnapshot(docId, options, token);
    snapshot = await joinPastWork(docId, options, snapshot, async () =>
      fetchSnapshot(docId, options, await requireToken()),
    );
    const refused = joinRefusalOf(snapshot);
    if (refused?.kind === 'at_capacity') {
      const held = await openTooLarge(docId, options, refused.error);
      endTotal({ docId, path: 'read-only:at_capacity' });
      return held;
    }
    const opened = await finalise(docId, snapshot, options);
    endTotal({ docId });
    return opened;
  };

  // A writable open of a document too large to edit, joined again as a
  // reader and shown read-only.
  async function openTooLarge(
    docId: string,
    options: OpenDocumentByIdOptions | undefined,
    error: string | undefined,
  ): Promise<OpenedDocument> {
    const readOptions: OpenDocumentByIdOptions = {
      ...options,
      documentOptions: {
        ...options?.documentOptions,
        readOnly: true,
        readOnlyReason: 'too_large',
      },
    };
    const snapshot = await fetchSnapshot(docId, readOptions, await requireToken());
    const doc = await finalise(docId, snapshot, readOptions);
    doc._markAtCapacity();
    if (error !== undefined) doc._emitStatus({ message: error, pending: false, blocking: false });
    return doc;
  }

  // Create a doc and return it fully editable. Two round trips (POST to
  // create + obtain the doc_id, then `open(docId)`); they aren't fused
  // because the create response is metadata-only and the open path already
  // handles the empty-snapshot case via `Document.create()`. This is the
  // low-level path (`Brass.createDocument`): the doc lands in the
  // organization the app is acting in, and otherwise in the caller's single
  // organization; a caller with none is routed to the hosted
  // acquire-organization surface and the create retries; a multi-org caller
  // whose app is acting nowhere rejects with a 409 (no hosted picker here,
  // that is the session's `create()`).
  const create: CreateDocumentFn = async (options) => {
    const args: CreateDocumentArgs = { name: options?.name ?? 'Untitled' };
    if (options?.app_metadata !== undefined) args.app_metadata = options.app_metadata;
    let result = await createDocumentId(args);
    if (result.kind === 'needs-organization') {
      const acquired = await opts.hostedUiProvider?.acquireOrganization?.();
      if (!acquired || typeof acquired.organization_id !== 'string') {
        throw new BrassError('No organization available', { status: 404 });
      }
      result = await createDocumentId({
        ...args,
        destination: { organization_id: acquired.organization_id },
      });
    }
    if (result.kind === 'needs-destination') {
      throw new BrassError('Choose a destination organization', { status: 409 });
    }
    if (result.kind !== 'created') {
      throw new BrassError('Malformed createDocument response', { status: 500 });
    }
    const openOptions = options?.documentOptions
      ? { documentOptions: options.documentOptions }
      : undefined;
    return open(result.docId, openOptions);
  };

  // The mint's answer is the claim secret's only copy, so it is kept as it
  // arrives, in the browser that made the document.
  const rememberClaimSecret = (minted: MintedAnonymousDocument): MintedAnonymousDocument => {
    if (minted.claimSecret !== undefined) {
      storeClaimSecret(opts.appId, minted.linkToken, minted.claimSecret, minted.expiresAt);
    }
    return minted;
  };

  const mintAnonymousDocument: DocumentFactory['mintAnonymousDocument'] =
    async (args) => {
      const body: Record<string, unknown> = { app_id: opts.appId };
      if (args.name !== undefined) body['name'] = args.name;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      applyClientVersionHeader(headers);
      // No idempotency key on this route, so a replay could mint twice;
      // only the gateway's own 503 (the handler never ran) is replayed.
      const response = await fetchWithRetry(
        () =>
          fetch(`${baseUrl}/anonymous-documents`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }),
        { policy: RETRY_WRITE_503, baseDelayMs: 250 },
      );
      const text = await response.text();
      let parsed: unknown = undefined;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      if (response.status < 200 || response.status >= 300) {
        throw brassErrorFromBody(response.status, parsed);
      }
      return rememberClaimSecret(parseMintedAnonymousDocument(parsed));
    };

  // The unauthenticated JSON calls a visitor's file-started document makes.
  const postAnonymous = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    applyClientVersionHeader(headers);
    const response = await fetchWithRetry(
      () =>
        fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      { policy: RETRY_WRITE_503, baseDelayMs: 250 },
    );
    const parsed = await readJsonBody(response);
    if (response.status < 200 || response.status >= 300) {
      throw brassErrorFromBody(response.status, parsed);
    }
    return parsed;
  };

  const anonymousUploadTypes: DocumentFactory['anonymousUploadTypes'] = async () => {
    const headers: Record<string, string> = {};
    applyClientVersionHeader(headers);
    // `refusal=body` answers an app's refusal of signed-out use in a 200 body,
    // which keeps an expected answer out of the visitor's console.
    const response = await fetchWithRetry(
      () =>
        fetch(
          `${baseUrl}/anonymous-documents/upload-types?app_id=${encodeURIComponent(opts.appId)}&refusal=body`,
          { headers },
        ),
      { policy: RETRY_WRITE_503, baseDelayMs: 250 },
    );
    const parsed = await readJsonBody(response);
    if (response.status < 200 || response.status >= 300) {
      throw brassErrorFromBody(response.status, parsed);
    }
    const body = parsed as { refusal?: unknown; offers_new?: unknown } | null;
    const offersNew = body?.offers_new !== false;
    if (body?.refusal !== undefined) {
      return { offersNew, refusal: brassErrorFromBody(409, body.refusal) };
    }
    return { offersNew, accept: acceptFromUploadTypes(parsed) };
  };

  const mintAnonymousDocumentFromFile: DocumentFactory['mintAnonymousDocumentFromFile'] =
    async (args) => {
      const minted = (await postAnonymous('/anonymous-documents/upload-url', {
        app_id: opts.appId,
        file_name: args.file.name,
        byte_size: args.file.size,
      })) as { upload_url?: unknown; upload_key?: unknown } | undefined;
      if (typeof minted?.upload_url !== 'string' || typeof minted.upload_key !== 'string') {
        throw new BrassError('Malformed upload response', { status: 500 });
      }
      await putFile(minted.upload_url, args.file, args.onUploadProgress);
      const body: Record<string, unknown> = {
        app_id: opts.appId,
        upload_key: minted.upload_key,
        file_name: args.file.name,
      };
      if (args.name !== undefined) body['name'] = args.name;
      return rememberClaimSecret(
        parseMintedAnonymousDocument(
          await postAnonymous('/anonymous-documents/from-upload', body),
        ),
      );
    };

  // One client id per page, which is what holds a claim across the calls
  // of one import (the signed-in namespace keeps its own).
  const guestImportClientId = randomToken();
  const guestImports: DocumentFactory['guestImports'] = (token, docId) => {
    const base = `${baseUrl}/documents/${encodeURIComponent(docId)}`;
    const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
      const headers: Record<string, string> = { authorization: `Link ${token}` };
      if (body !== undefined) headers['content-type'] = 'application/json';
      applyClientVersionHeader(headers);
      const response = await fetchWithRetry(
        () =>
          fetch(`${base}${path}`, {
            method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          }),
        { policy: RETRY_WRITE_503, baseDelayMs: 250 },
      );
      const parsed = await readJsonBody(response);
      if (response.status < 200 || response.status >= 300) {
        throw brassErrorFromBody(response.status, parsed);
      }
      return parsed as T;
    };
    return {
      claimImport: () =>
        call<ImportClaimResponse>('POST', '/import-claim', {
          client_id: guestImportClientId,
          stages: true,
        }),
      async stageImport(bundle) {
        const staged = await call<{ upload_key: string; url: string }>(
          'POST',
          '/import-complete/upload',
          { byte_size: bundle.byteLength },
        );
        const put = await fetch(staged.url, {
          method: 'PUT',
          body: bundle.buffer.slice(
            bundle.byteOffset,
            bundle.byteOffset + bundle.byteLength,
          ) as ArrayBuffer,
        });
        if (!put.ok) {
          throw new BrassError('Uploading the import failed', { status: put.status });
        }
        return staged.upload_key;
      },
      completeImport: async (report, uploadKey) =>
        awaitSeal(
          await call<unknown>('POST', '/import-complete', {
            client_id: guestImportClientId,
            ...(report !== undefined ? { report } : {}),
            upload_key: uploadKey,
          }),
          (sealId) => call<SealStatus>('GET', `/seals/${encodeURIComponent(sealId)}`),
        ),
      failImport: (message) =>
        call<ImportFailedResponse>('POST', '/import-failed', {
          client_id: guestImportClientId,
          message,
        }),
      sourceBlob: () => call<DocumentSourceBlob>('GET', '/source-blob'),
    };
  };

  const claimAnonymousDocument: DocumentFactory['claimAnonymousDocument'] =
    async (docId, args) => {
      const token = await requireToken();
      const body: Record<string, unknown> = {
        link_token: args.linkToken,
        claim_secret: args.claimSecret,
      };
      if (args.destination !== undefined) body['destination'] = args.destination;
      if (args.name !== undefined) body['name'] = args.name;
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      };
      applyClientVersionHeader(headers);
      await applyAppAssertionHeader(headers, opts.getAppAssertion);
      const response = await fetchWithRetry(
        () =>
          fetch(`${baseUrl}/documents/${encodeURIComponent(docId)}/claim`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }),
        { policy: RETRY_WRITE_503, baseDelayMs: 250 },
      );
      const text = await response.text();
      let parsed: unknown = undefined;
      let parseFailed = false;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parseFailed = true;
        }
      }
      if (response.status >= 200 && response.status < 300) {
        return { kind: 'claimed', record: selectionFromDetail(parsed) };
      }
      if (response.status === 409 && !parseFailed) {
        const code = (parsed as { code?: unknown })?.code;
        if (code === 'destination_required') return { kind: 'needs-destination' };
        if (code === 'no_organization') return { kind: 'needs-organization' };
      }
      throw brassErrorFromBody(response.status, parseFailed ? undefined : parsed);
    };

  return {
    open,
    create,
    createDocumentId,
    openByLink,
    mintAnonymousDocument,
    anonymousUploadTypes,
    mintAnonymousDocumentFromFile,
    guestImports,
    claimAnonymousDocument,
  };
}

// The claimed document in the picker's shape, read off the claim's
// `DocumentDetail` answer; null when a field the shape needs is missing.
function selectionFromDetail(parsed: unknown): SelectDocumentResult | null {
  const d = parsed as Record<string, unknown> | undefined | null;
  if (!d || typeof d !== 'object') return null;
  const str = (key: string): string | null =>
    typeof d[key] === 'string' ? (d[key] as string) : null;
  const docId = str('doc_id');
  const organizationId = str('organization_id');
  const name = str('name');
  const createdAt = str('created_at');
  const updatedAt = str('updated_at');
  const role = d['role'];
  const projectId = d['project_id'];
  if (
    docId === null ||
    organizationId === null ||
    name === null ||
    createdAt === null ||
    updatedAt === null ||
    (role !== 'owner' && role !== 'editor' && role !== 'viewer') ||
    (projectId !== null && typeof projectId !== 'string')
  ) {
    return null;
  }
  return {
    doc_id: docId,
    organization_id: organizationId,
    project_id: projectId ?? null,
    role,
    name,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

// The expiry a link view carries for a document minted without an account,
// or null for every other link.
function anonymousExpiry(body: {
  anonymous?: unknown;
  expires_at?: unknown;
}): Date | null {
  if (body.anonymous !== true || typeof body.expires_at !== 'string') {
    return null;
  }
  const at = new Date(body.expires_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

interface WireDocTransportArgs {
  doc: Document;
  docId: string;
  // The branch the subscription scopes to; the topic is
  // `doc:<docId>:<branchId>` so op-write / fanout / presence stay
  // branch-scoped server-side.
  branchId: string;
  wsClient: OpenDocumentWsClient;
  newClientOpId: () => string;
  getCurrentSeq: () => number;
  setCurrentSeq: (next: number) => void;
  // Contiguous-coverage floor accessors (see the closure in `finalise`):
  // highest seq below which every op is applied. Distinct from the max-seen
  // cursor, which out-of-order fanout can inflate past a hole.
  getCoveredSeq: () => number;
  advanceCoveredSeq: (seq: number) => void;
  // Re-import the HTTP join. Invoked when a `doc_init` tail starts above the
  // coverage floor (ops missed while disconnected were compacted into the
  // snapshot and the tail cannot bridge the hole) and on every catch-up
  // prompt. Optional only for transport-less paths.
  //
  // A returned promise lets the caller re-read the coverage floor once the
  // import has landed, which is how a reader that is still short asks
  // again. A void return keeps that caller correct, just later: it falls
  // back to whatever the next frame arms.
  resyncFromSnapshot?: () => void | Promise<void>;
  // Re-fetch the durable frontier (version vector + tail blobs) without
  // importing. Invoked by the `doc_ops_dropped` handler so the handshake
  // runs against fresh ground truth the instant the server discards ops, not
  // only at reconnect. Null on a failed fetch; the `doc_init` handshake is
  // the backstop.
  refetchDurableFrontier?: () => Promise<{
    snapshotVersionVector?: string;
    tailBlobs: Uint8Array[];
  } | null>;
  // Write an op the socket cannot carry, over HTTP. Resolves to the
  // server-allocated seq, or a failure the Document surfaces on the op.
  // Absent in transport-only tests, where an oversized op is failed rather
  // than rerouted.
  postOversizedOp?: (
    opBlobB64: string,
    clientOpId: string,
  ) => Promise<OversizedOpResult>;
  // Invoked on a terminal `doc_status` frame: re-fetches once and, on
  // success, imports the now-available snapshot so content appears without
  // the app reopening; on failure leaves the status and does not loop.
  // Absent in transport-only tests.
  reloadAfterHydration?: (finalStatus: DocumentWorkStatus) => void;
  // Invoked on `doc_init`. Posted only after the subscription record is written, so it
  // is the safe point to reconcile a pending open whose terminal
  // `doc_status` frame may have been dropped. Absent in transport-only tests.
  reconcileStatusOnInit?: () => void;
  // Invoked on a `doc_status` frame that would lock a document not currently
  // pending: checks the row before applying it, since such a frame can be
  // the stream's late delivery of a phase the reconcile already read past.
  // Absent in transport-only tests, where the frame applies directly.
  verifyPendingStatus?: (status: DocumentWorkStatus) => void;
  // Invoked on every frame carrying server-side movement (`doc_init`, a
  // remote op). Evidence the document has content to pull for a client whose
  // content pull gave up. Absent in transport-only tests.
  onDocumentMoved?: () => void;
  // True for a stream line's internal Document: presence is a
  // document-level surface (one roster per open doc, on the default
  // line's presence topic), so per-stream transports skip attaching a
  // presence controller rather than multiplying subscriptions per stream.
  skipPresence?: boolean;
  // False for a stream line's internal Document: its lifecycle is owned
  // by the parent Document (closed on parent close), so it bypasses the
  // park cache and `close()` tears down immediately.
  parkable?: boolean;
  // True for the session-owned top-level document: an unhealable capacity
  // refusal tells the user and reloads, because the session reopens the id
  // and rebinds the app to the platform's copy. False for a stream line,
  // which has no such owner and is only one part of a document: it marks
  // itself read-only at capacity and surfaces `stream.atCapacity` instead
  // of alerting the reader and reloading a document the stream is part of.
  capacityReloadsDocument?: boolean;
  // The branch the caller REQUESTED (`options.branch`), undefined for a
  // default-branch open. Distinct from `branchId`, which is the branch the
  // server RESOLVED. The park cache keys on this (symmetric with
  // `takeParkedDocument`, which looks up by the requested branch): keying on
  // the resolved branch instead would park a no-branch open under
  // `<id>/<default>` while a no-branch reopen keys as `null`, so the parked
  // copy (with its live subscription) could never be retrieved and would leak
  // until LRU eviction. This honors the `parkCacheKey` rule that a
  // branch-unknown open skips the cache rather than risk returning a doc for
  // the wrong (possibly since-changed) branch.
  requestedBranchId?: string;
  // The stream the caller REQUESTED (`options.stream`), undefined for an
  // open that named none. Part of the park key for the same reason the
  // branch is: it says which state the parked Document holds.
  requestedStream?: string;
  // The `documentOptions` this Document was built from, recorded on the park
  // entry so a reopen asking for different ones gets its own Document.
  documentOptions?: DocumentOptions;
  // Who this Document was opened for, recorded on the park entry (see
  // `ParkedDocEntry.identity`). Read at close rather than captured at open so
  // the stamp is the identity the page holds when the Document is parked.
  identity?: () => string | null;
}

// Per-process parking cache for opened Documents. `doc.close()` does NOT
// free the LoroDoc / UndoController; it parks the Document keyed on
// (docId, branchId), and the next `openDocumentById` for that key returns it
// with its undo stack intact, so "switch branches and come back" preserves
// per-branch undo without app-side bookkeeping.
//
// LRU eviction past `PARK_CACHE_CAPACITY`; the evicted Document gets its full
// teardown (WS detach, presence leave, LoroDoc free). Version-pinned
// (read-only) opens bypass the cache: they are transient with no editable
// state to keep. Module-scoped so it persists across factory invocations in
// one process; keys are app-supplied so no cross-app leak within a tab.
const PARK_CACHE_CAPACITY = 4;

interface ParkedDocEntry {
  doc: Document;
  // Bound full-teardown closure: detaches WS, leaves presence, drops the
  // local-op hook, runs the underlying `Document.close()`.
  teardown: () => void;
  key: string;
  // The `documentOptions` this Document was built from. A reopen asking for
  // different ones (another root key, another undo depth) describes a
  // different Document, so it gets a fresh one rather than this state.
  optionsSig: string;
  // Who this Document was opened for (`identity`, the signed-in subject), so
  // a take by anyone else misses.
  //
  // A hit skips the join entirely, which is the whole point of parking and
  // also the reason the entry has to name its owner: the SDK reads the
  // person from the token set, and a `/refresh` resolves whichever platform
  // session the browser now holds, so the identity behind an open page can
  // become someone else's between a close and the next open. Without this,
  // the second person's open is answered out of memory, with the first
  // person's content and no request the server could refuse.
  identity: string | null;
}

function documentOptionsSig(options: DocumentOptions | undefined): string {
  return JSON.stringify([
    options?.rootKey ?? null,
    options?.readOnly ?? null,
    options?.undo ?? null,
  ]);
}

const parkedDocs = new Map<string, ParkedDocEntry>();

function parkCacheKey(
  docId: string,
  branchId: string | null | undefined,
  streamName: string | null | undefined,
): string | null {
  // Skip caching when the branch is unknown: the next open() may resolve to
  // a different branch (the server default), and returning the wrong branch
  // is worse than a lost undo stack.
  if (!branchId) return null;
  // The stream is part of the identity of what was opened: a Document
  // opened at `geometry` holds different state from one opened at the same
  // branch's default, so handing either back for the other would swap the
  // caller's document out from under it.
  return `${docId}/${branchId}/${streamName ?? DEFAULT_STREAM_NAME}`;
}

function evictParked(entry: ParkedDocEntry | undefined): void {
  if (!entry) return;
  parkedDocs.delete(entry.key);
  try {
    entry.teardown();
  } catch {
    // Teardown errors must not strand the cache; the evicted Doc is gone
    // from the user's perspective either way.
  }
}

function parkDocument(entry: ParkedDocEntry): void {
  // One Document per key: whatever sat here is unreachable the moment this
  // entry replaces it, so it is torn down rather than left holding a live
  // subscription nothing can close.
  evictParked(parkedDocs.get(entry.key));
  parkedDocs.set(entry.key, entry);
  // Map iteration is insertion order, so evicting the front entry is LRU
  // (a newly parked entry is the most-recent; a hit removes the entry
  // entirely, so there's no bump-on-hit).
  while (parkedDocs.size > PARK_CACHE_CAPACITY) {
    const oldestKey = parkedDocs.keys().next().value;
    if (oldestKey === undefined) break;
    evictParked(parkedDocs.get(oldestKey));
  }
}

function takeParkedDocument(
  docId: string,
  options: OpenDocumentByIdOptions | undefined,
  identity: string | null,
): Document | null {
  // A parked Document is a live, writable session with its subscription still
  // alive. Neither pinned open may take one: it would hand back a document
  // that receives ops and accepts writes, which is the opposite of what both
  // asked for. Parking itself already refuses them (`!doc.readOnly`), so this
  // is the other half of that.
  if (options?.version !== undefined) return null;
  if (options?.frozen === true) return null;
  const key = parkCacheKey(docId, options?.branch, options?.stream);
  if (!key) return null;
  const entry = parkedDocs.get(key);
  if (!entry) return null;
  // A Document the server evicted while it was parked describes a document
  // that is no longer there, one built from different `documentOptions` is
  // not the Document this caller asked for, and one opened for a different
  // person is not this caller's to read. All three take the fresh open, which
  // for the last is the request that establishes the new caller may have it;
  // the parked copy goes with its subscription.
  if (
    entry.doc._goneReason !== null ||
    entry.optionsSig !== documentOptionsSig(options?.documentOptions) ||
    entry.identity !== identity
  ) {
    evictParked(entry);
    return null;
  }
  parkedDocs.delete(key);
  return entry.doc;
}

/** Retire every parked Document. The client calls this as an identity leaves
 *  the page, so what the previous person opened is torn down rather than left
 *  resident for the rest of the tab's life.
 *  @internal */
export function clearParkedDocuments(): void {
  for (const entry of parkedDocs.values()) {
    evictParked(entry);
  }
  parkedDocs.clear();
}

// Test-only: drop the parking cache. Used by unit tests that need
// a clean slate between cases.
export function _resetParkCacheForTesting(): void {
  clearParkedDocuments();
  subscriptionEndedAt.clear();
}

// When each doc topic last had its subscription ended by the server, so a
// copy re-opened after one ends for good on a second inside the window. The
// re-open asks the HTTP join, and a socket gate that keeps refusing what the
// join admits would otherwise re-open the document in a loop.
const SUBSCRIPTION_ENDED_REOPEN_WINDOW_MS = 60_000;
const subscriptionEndedAt = new Map<string, number>();

function endedReasonFor(topic: string): 'moved' | 'deleted' {
  const now = Date.now();
  for (const [key, at] of subscriptionEndedAt) {
    if (now - at >= SUBSCRIPTION_ENDED_REOPEN_WINDOW_MS) subscriptionEndedAt.delete(key);
  }
  const recent = subscriptionEndedAt.has(topic);
  subscriptionEndedAt.set(topic, now);
  return recent ? 'deleted' : 'moved';
}

// Wire the WS transport onto a materialised Document. Three pieces:
//   1. WS subscribe on the doc topic; the server sends `doc_op` (other
//      clients' edits) and `op_ack` (our ops), topic-scoped so the
//      `BrassWsClient` multiplexer routes them to our callback.
//   2. Local-op send hook: `subscribeLocalUpdates` fires per-commit; the
//      hook mints a `client_op_id`, records it on the outstanding-op map (so
//      the server echo reads as self-originated), and sends the frame.
//   3. Teardown: `close()` clears the hook and detaches the subscription via
//      the closure-held unsubscribe handle.

// How often a long-lived connected tab re-fetches the durable frontier and
// re-runs the durability handshake. The handshake also fires on `doc_init`
// (reconnect) and `doc_ops_dropped`, but both are event-driven: a tab
// connected for days that missed its best-effort drop notification would not
// self-heal until it reconnects. This periodic re-verify closes that window.
// Cheap (one JSON round-trip, no snapshot download). Exported for the
// fake-timer test.
export const PERIODIC_REVERIFY_INTERVAL_MS = 5 * 60_000;

// How long a hole below the coverage floor may stand before the transport
// re-imports the join to fill it. An op arriving ahead of its predecessor
// opens a hole that closes within a round trip; one still open after this
// delay is an op the server will not send again. Exported for the
// fake-timer test.
export const MISSED_OP_RESYNC_DELAY_MS = 2_000;

// Per-op resend backoff: 1.5s, ~1.6x per attempt, to a 30s ceiling. The
// ceiling keeps a doc on a dead connection from hammering; the
// reconnect-driven resend (`resendAllOutstanding`) fires the instant
// `doc_init` arrives, so the ceiling never delays recovery past the next
// reconnect. Exported for the fake-timer tests.
export const RESEND_BASE_DELAY_MS = 1_500;
export const RESEND_MAX_DELAY_MS = 30_000;

// How long the oldest op on the socket may go unacked before its resend
// timer spends an attempt even though the connection is answering other
// ops. See `scheduleResend` for what this bounds and why only the oldest op
// reaches it.
//
// The value sits above every latency a working connection produces. Acks
// measured on a deployed environment run 175 ms at p99 and 1.6 s at their
// worst, and an op whose own backoff has grown to `RESEND_MAX_DELAY_MS` is
// still well inside this, so a queue that is merely slow never reaches it and
// the timer keeps re-arming free. Sitting above the backoff ceiling is also
// what makes this value, rather than the backoff, the interval a forced
// resend is paced at: the timer fires several times inside one window, and
// the first expiry past the window is the one that spends.
//
// What a false positive costs bounds the risk of setting it at all: one
// duplicate op per document per window, which is a Loro no-op on import. The
// failure this replaces is unbounded in the other direction, an op the
// server never received and nothing ever sends again.
// Exported for the fake-timer tests.
export const RESEND_FORCE_CEILING_MS = 60_000;

// How long one op may go unacked on the socket before the reader is told,
// through `status`, that their changes are not saved. A server that answers
// an op anonymously every time (an error frame naming no op) draws a resend
// per backoff step, or a forced one per ceiling window, forever, while
// `savingCount` stays above zero with nothing on screen saying why. Three
// ceiling windows is past any loss a resend recovers from, since a lost op
// is answered on its first forced resend. The notice changes nothing about
// how the op is resent, and clears itself once nothing is waiting.
// Exported for the fake-timer tests.
export const UNANSWERED_OP_NOTICE_MS = 3 * RESEND_FORCE_CEILING_MS;

// Server-shed recovery policy, driven by `unavailable` error frames. The
// frame names no op, so a round re-asserts every outstanding op at once and
// any further frame arriving before that round runs is part of the same shed
// batch: coalescing them is what keeps N shed ops from fanning out into N
// rounds of N resends. Backoff is 1s doubling to a 30s ceiling, so the budget
// spans roughly a minute and a half of sustained shedding. An `op_ack` (the
// server taking writes again) or a reconnect returns the budget to full.
//
// Module-scoped because both transports answer a shed on it: the signed-in
// one, the HTTP write for an op past the frame cap, and the guest-link one.
// A shed costs an edit the same nothing whoever wrote it and whichever
// transport carried it.
const UNAVAILABLE_MAX_ROUNDS = 6;
const UNAVAILABLE_BASE_DELAY_MS = 1000;
const UNAVAILABLE_MAX_DELAY_MS = 30_000;
const UNAVAILABLE_GIVE_UP_MESSAGE =
  'The server could not store this change, and re-sending it did not ' +
  'help. Reload to continue from the last saved state.';

/** How long the Nth (1-based) recovery round waits before re-asserting. */
function unavailableDelayMs(round: number): number {
  return Math.min(
    UNAVAILABLE_BASE_DELAY_MS * Math.pow(2, round - 1),
    UNAVAILABLE_MAX_DELAY_MS,
  );
}

// A mutation carrying many records commits as it goes, so the only write
// that reaches this is one record nothing can split.
const TOO_LARGE_MESSAGE =
  'This record is too large to save. A single record must fit in one ' +
  'update; store the bulk of it as a file instead, or split it across ' +
  'several records.';


function wireDocTransport(args: WireDocTransportArgs): void {
  const topic = `doc:${args.docId}:${args.branchId}`;

  // A remote op over frozen content means the document is now a CRDT. The
  // re-join keeps the open's read intent and is served that CRDT, which
  // `applyJoin` swaps in under the same handles. A run that leaves the
  // document on frozen content (the join failed, or the document is showing
  // a version) falls back to the reload. Ops arriving during the run ask the
  // resync for another pass rather than starting a second upgrade.
  const resync = args.resyncFromSnapshot;
  if (resync !== undefined) {
    let upgradeRun: Promise<void> | null = null;
    args.doc._setStorageUpgrader(() => {
      if (upgradeRun !== null) {
        void Promise.resolve(resync()).catch(() => {});
        return;
      }
      upgradeRun = (async () => {
        try {
          await resync();
        } catch {
          // Judged by what the document holds afterwards.
        }
        const doc = args.doc;
        if (doc._holdsRecordSet() && !doc._isClosed && doc._goneReason === null) doc._reopen();
      })().finally(() => {
        upgradeRun = null;
      });
    });
  }

  // Per-op retry tracker. The op-write endpoint can answer with an untyped
  // error frame instead of reaching the handler. That frame has no `type`, so
  // the multiplexer drops it,
  // leaving the op stuck in `Document._outstandingByClientId` and the
  // actor's lamport stream with a gap that blocks other subscribers' Loro
  // imports from converging (Loro requires per-actor causal contiguity).
  //
  // Recovery is retry-forever while the doc is open: a capped backoff plus an
  // immediate resend of every outstanding op on each reconnect (`doc_init`).
  // Re-sends are idempotent (a duplicate seq is a Loro no-op) and loss
  // windows sit inside the server's 15-minute discard window, so the moment a
  // retry lands the dependent chain converges everywhere. `doc.savingCount`
  // stays above zero until the `op_ack` lands (the "Saving…" surface); there
  // is no give-up to surface because the SDK keeps trying.
  // When each op this transport shipped was first committed, keyed the same
  // way the tracker is. The tracker itself carries no commit time (its
  // `dispatchedAt` restarts on every resend, which is the right basis for
  // deciding a resend and the wrong one for reporting how long a reader has
  // been waiting), and an op past the frame cap is never in the tracker at
  // all. Entries are dropped as their op settles, so the map's size is the
  // work outstanding on either transport.
  const opStartedAt = new Map<string, number>();

  // Reconnects the socket had made when this transport last saw a
  // `doc_init`. The frame itself is not a reconnect signal: it rides every
  // `subscribed` ack, including the opening one and the silent re-subscribe
  // a connection grants after a mid-stream eviction, neither of which
  // involved the socket dropping. A report keyed off the frame therefore
  // fires when nothing is wrong, which is the fault this latch exists to
  // avoid, so it is keyed off the socket instead.
  let docInitReconnectCount: number | null = null;

  const outstandingResends = new Map<
    string,
    {
      frame: OpFrame;
      attempts: number;
      timer: ReturnType<typeof setTimeout>;
      // When this op's current timer was armed, compared against the last
      // ack to tell a slow queue from a silent server. See `scheduleResend`.
      armedAt: number;
      // When this op was last put on the socket, or 0 while it is queued.
      // Time on the wire rather than time outstanding, so an op held back by
      // the in-flight budget is not charged for the wait. See
      // `scheduleResend`.
      dispatchedAt: number;
      // Bytes this op is charging to the in-flight budget, or 0 while it is
      // still queued. See `dispatchOp`.
      inFlight: number;
      // Whether this op is waiting in `sendQueue`. Held on the entry so
      // neither queueing nor forgetting an op has to scan the queue, which
      // would be quadratic over a mutation that queues thousands.
      queued: boolean;
      // When this op was first put on the socket, or 0 before then. See
      // `UNANSWERED_OP_NOTICE_MS`.
      firstDispatchedAt: number;
    }
  >();

  // How many bytes of op frames may be on the socket unacked at once.
  //
  // The transport drops the connection when a client pushes at it hard
  // enough, and it takes everything multiplexed onto that socket with it;
  // every op then goes unacked, the reconnect re-asserts them, and that
  // burst drops the connection again, so nothing is ever persisted.
  // Measured against one write, a client pushing 26 frames in 320 ms lost
  // the socket where one spreading 90 frames over 5.3 s did not, so what
  // this bounds is the RATE rather than any one frame's size.
  //
  // Which shape reaches it is worth knowing before tuning it. A bulk write
  // does not: `mutate` batches to a budget far above what a frame carries,
  // so its ops take the HTTP write and never enter this queue. What does is
  // an app issuing many separate mutations that each land under the frame
  // cap, a drag loop or a per-row import, where the op count is set by how
  // often the app calls rather than by how much it writes.
  //
  // A byte budget rather than a rate is what makes this self-tuning: sends
  // resume as acks land, so the client goes exactly as fast as the server
  // is answering and no faster, whatever that speed turns out to be. The
  // budget is generous enough to keep several ops in flight, so an ack's
  // round trip is not serialised into the write.
  const IN_FLIGHT_BUDGET_BYTES = 256 * 1024;
  // Ops committed but not yet on the socket, oldest first.
  const sendQueue: string[] = [];
  let inFlightBytes = 0;

  /** Put an op on the socket if the budget allows, else queue it. */
  function dispatchOp(clientOpId: string): void {
    const entry = outstandingResends.get(clientOpId);
    if (!entry || entry.inFlight > 0) return;
    const size = entry.frame.op_blob.length;
    // An op larger than the whole budget goes on its own rather than
    // waiting for room that can never appear.
    if (inFlightBytes > 0 && inFlightBytes + size > IN_FLIGHT_BUDGET_BYTES) {
      if (!entry.queued) {
        entry.queued = true;
        entry.dispatchedAt = 0;
        sendQueue.push(clientOpId);
      }
      return;
    }
    entry.queued = false;
    entry.inFlight = size;
    entry.dispatchedAt = Date.now();
    if (entry.firstDispatchedAt === 0) entry.firstDispatchedAt = entry.dispatchedAt;
    inFlightBytes += size;
    args.wsClient.send(entry.frame);
    scheduleResend(clientOpId);
  }

  /** The oldest op currently on the socket, which is the one a gap blocks
   *  the rest of this actor's stream behind. Map order is commit order, and
   *  an op waiting on the in-flight budget carries no timer, so the first
   *  dispatched entry is that op. */
  function isOldestDispatchedOp(clientOpId: string): boolean {
    for (const [id, entry] of outstandingResends) {
      if (entry.dispatchedAt === 0) continue;
      return id === clientOpId;
    }
    return false;
  }

  /** Send whatever the freed budget now has room for. */
  function drainSendQueue(): void {
    while (sendQueue.length > 0) {
      const next = sendQueue[0]!;
      const entry = outstandingResends.get(next);
      // An op acked, rejected or abandoned while queued leaves its id behind;
      // dropping it here is what keeps `forgetOp` off a queue scan.
      if (!entry || !entry.queued) {
        sendQueue.shift();
        continue;
      }
      const size = entry.frame.op_blob.length;
      if (inFlightBytes > 0 && inFlightBytes + size > IN_FLIGHT_BUDGET_BYTES) {
        return;
      }
      sendQueue.shift();
      entry.queued = false;
      dispatchOp(next);
    }
  }

  /** Drop one op from the tracker, returning its budget. */
  function forgetOp(clientOpId: string): void {
    const entry = outstandingResends.get(clientOpId);
    if (!entry) return;
    clearTimeout(entry.timer);
    inFlightBytes -= entry.inFlight;
    entry.inFlight = 0;
    entry.queued = false;
    outstandingResends.delete(clientOpId);
    opStartedAt.delete(clientOpId);
    drainSendQueue();
  }

  /** Drop every tracked op and reset the budget with them. */
  function forgetAllOps(): void {
    for (const [clientOpId, entry] of outstandingResends) {
      clearTimeout(entry.timer);
      // Only the ops this tracker holds. An op past the frame cap is
      // travelling over HTTP and is not in here, so clearing the whole
      // timing map would report it settled while its write is still going.
      opStartedAt.delete(clientOpId);
    }
    outstandingResends.clear();
    sendQueue.length = 0;
    inFlightBytes = 0;
  }
  // Ops this client is writing over HTTP, and the highest seq a catch-up
  // prompt named while one was in flight.
  //
  // The server tells a document's subscribers about an op the socket could
  // not carry by prompting them to catch up, and the writer is one of those
  // subscribers: the prompt names the seq of the op this client just wrote,
  // and arrives while the response that would resolve it is still in
  // flight. Answered immediately, the writer re-imports a whole snapshot
  // for an op it already applied, and `_applySnapshot` drops its undo and
  // redo stacks with it. So a prompt that lands mid-write is held and
  // re-judged by the same predicate once the write settles, where the
  // client's own seq is covered and the prompt is answered only if
  // something else moved the head.
  let httpOpWritesInFlight = 0;
  let heldCatchUpSeq = 0;

  function settleHttpOpWrite(): void {
    httpOpWritesInFlight -= 1;
    if (httpOpWritesInFlight > 0) return;
    const seq = heldCatchUpSeq;
    heldCatchUpSeq = 0;
    if (seq > 0 && args.getCoveredSeq() < seq) pullJoin();
  }

  // Pull the join, and ask again if it left the reader short.
  //
  // A join read while a peer writes in bulk is a torn cut: the branch's seq
  // counter has run ahead of the op rows, so the response reports a head it
  // could not deliver the tail for. The reader applies what arrived and its
  // floor lands below that head, and nothing re-sends the difference. So
  // whatever the reader still lacks after an import is a hole it has to ask
  // about itself, which is what a passive reader has instead of the `doc_op`
  // and `op_ack` frames a writing client arms its checks from.
  function pullJoin(): void {
    void Promise.resolve(args.resyncFromSnapshot?.()).then(
      () => {
        scheduleGapCheck();
      },
      () => {
        // `resyncFromSnapshot` reports its own failures and resolves; a
        // rejection is a caller that does not, and asking again is still the
        // right move.
        scheduleGapCheck();
      },
    );
  }

  // Re-import the join for ops this client cannot bridge to from what it
  // holds, deferring the judgement while one of its own HTTP writes is still
  // in flight. Shared by the catch-up prompt and by the reconnect handshake,
  // which reaches the same conclusion off its tail.
  // Re-import when the durable frontier names an author whose changes never
  // came through the op stream. Separate from the coverage check because it
  // answers a different question: not "did I miss an op" but "did what I hold
  // stop being how this document is stored".
  function maybeResyncPastRewrite(vectorB64: string | undefined): void {
    if (!vectorB64) return;
    let unseen = false;
    try {
      unseen = args.doc._snapshotHasUnseenAuthor(base64ToBytes(vectorB64));
    } catch {
      return;
    }
    if (unseen) pullJoin();
  }

  function resyncPastSeq(seq: number): void {
    if (httpOpWritesInFlight > 0) {
      if (seq > heldCatchUpSeq) heldCatchUpSeq = seq;
      return;
    }
    pullJoin();
  }

  function resendDelayMs(attempts: number): number {
    const grown = RESEND_BASE_DELAY_MS * Math.pow(1.6, attempts - 1);
    return Math.min(grown, RESEND_MAX_DELAY_MS);
  }

  // When this connection last proved it was working: any `op_ack`, from any
  // op on this topic.
  //
  // What this timer is for is a server that answered NOTHING, which is a
  // real case (an op frame can draw the opaque `{"message":"Internal server
  // error"}` reply the multiplexer drops). What it must not read as silence
  // is an ack that is merely behind, because with many ops in flight one
  // op's latency is the queue's depth times its service time, not evidence
  // about that op. Resending on that reading writes the op a second time,
  // which deepens the queue, which slows the next ack, which fires more
  // resends.
  //
  // Measured on a 500,000-element write: the same content went through in
  // 1,320 op writes on a run whose acks stayed under 375 ms, and in 3,600 on
  // a run whose acks reached 1,615 ms, just past this backoff's first step.
  // The extra writes are durable duplicates, so they inflate the document's
  // history, and every later compaction pays for them: the run that tripled
  // its ops left a tail compaction could not absorb inside its memory, and
  // the document stopped opening.
  //
  // So the timer fires on silence rather than on slowness: an ack that
  // arrived after this op's timer was armed re-arms it without spending an
  // attempt, within the bound `forceResendDue` puts on how long one op may
  // ride that evidence.
  let lastAckAt = 0;

  function scheduleResend(clientOpId: string): void {
    const entry = outstandingResends.get(clientOpId);
    if (!entry) return;
    entry.armedAt = Date.now();
    entry.timer = setTimeout(() => {
      const current = outstandingResends.get(clientOpId);
      if (!current) return;
      if (
        current.firstDispatchedAt !== 0 &&
        Date.now() - current.firstDispatchedAt > UNANSWERED_OP_NOTICE_MS
      ) {
        args.doc._showConnectionNotice('unanswered');
      }
      const forced = forceResendDue(clientOpId, current);
      if (lastAckAt >= current.armedAt && !forced) {
        scheduleResend(clientOpId);
        return;
      }
      // A forced resend is the transport concluding this op was lost, which
      // is the one condition here the server cannot infer, so it is what the
      // report is pinned to.
      if (forced) reportSyncHealth('op_stuck');
      current.attempts += 1;
      current.dispatchedAt = Date.now();
      args.wsClient.send(current.frame);
      scheduleResend(clientOpId);
    }, resendDelayMs(entry.attempts));
  }

  // The one case where an answering connection is still evidence this op was
  // lost: it is the oldest op on the socket and it has been there longer than
  // any working connection takes to answer.
  //
  // The evidence `lastAckAt` carries is that the connection is working, not
  // that it received this op, so an app committing faster than the backoff
  // supplies that evidence continuously and a dropped op would re-arm free
  // forever. The server's copy of the document then stops at the gap (Loro
  // requires per-actor causal contiguity, so every later op is stored and
  // never applied), the tracker entry never reaches a terminal state, and the
  // app is told nothing.
  //
  // Ack ORDER cannot stand in for that evidence. Acks overtake heavily: 24
  // ops sent back to back on a deployed environment came back with 10 of 23
  // adjacent pairs out of send order, and the op sent first was acked 23rd. A
  // rule reading a later op's ack as proof this one was skipped re-sends ops
  // that are merely in flight, which is the write-it-twice failure the gate
  // above exists to prevent.
  //
  // Restricting this to the oldest dispatched op is what keeps the traffic
  // bounded and is sufficient. Bounded: one op per ceiling window however
  // many ops are outstanding, which matters because this resend hands the
  // frame straight to `wsClient.send` and so spends none of the in-flight
  // budget, and a simultaneous round of them is the burst that drops the
  // socket. Sufficient: the gap at the oldest op is what holds the rest of
  // this actor's stream unapplied, and an op behind it becomes the oldest in
  // its turn as the ops in front retire.
  function forceResendDue(
    clientOpId: string,
    entry: { dispatchedAt: number },
  ): boolean {
    if (entry.dispatchedAt === 0) return false;
    if (Date.now() - entry.dispatchedAt <= RESEND_FORCE_CEILING_MS) return false;
    return isOldestDispatchedOp(clientOpId);
  }

  // What this transport knows about its own sync, for a reader whose save
  // is taking longer than it should. Everything here is closure state the
  // transport already keeps; collecting it costs a walk of the outstanding
  // ops, so it is safe to call from a render.
  function collectDiagnostics(): DocSyncDiagnostics {
    const now = Date.now();
    let oldestClientOpId: string | null = null;
    let oldestStartedAt = 0;
    // Insertion order is commit order, so the first entry is the oldest.
    for (const [clientOpId, startedAt] of opStartedAt) {
      oldestClientOpId = clientOpId;
      oldestStartedAt = startedAt;
      break;
    }
    return {
      unackedOps: opStartedAt.size,
      oldestUnackedMs:
        oldestClientOpId === null ? 0 : Math.max(0, now - oldestStartedAt),
      oldestClientOpId,
      reconnects: args.wsClient.reconnectCount ?? 0,
      lastAckAgeMs: lastAckAt === 0 ? null : Math.max(0, now - lastAckAt),
      inFlightBytes,
      httpOpsInFlight: httpOpWritesInFlight,
      healRounds: divergenceHealRound,
      hidden: args.wsClient.pageHidden ?? false,
    };
  }

  // Push the same picture to the server, so an incident on a device with no
  // console attached leaves a record an operator can find. Sent on the
  // conditions the client can recognise and the server cannot, each of
  // which is already bounded by the machinery that detects it: a forced
  // resend fires at most once per ceiling window, a reconnect is one
  // socket, and a heal round is one push. The server drops the excess
  // anyway.
  //
  // Fire-and-forget by design. The frame carries no `client_op_id` of its
  // own and draws no reply, so it never joins the outstanding-op tracker
  // and a report cannot become one more thing a stuck document is waiting
  // on.
  function reportSyncHealth(reason: ClientReportReason): void {
    // Only worth sending while the socket can carry it. Held through an
    // outage, a report flushes on the re-subscribe describing state from
    // before the outage, and it arrives on the new connection ahead of the
    // accurate one the reconnect itself produces, so the stale figures are
    // what the server's one-per-connection budget accepts.
    if (args.wsClient.connected === false) return;
    const d = collectDiagnostics();
    args.wsClient.send({
      type: 'client_report',
      topic,
      client_report: {
        reason,
        unacked_ops: d.unackedOps,
        oldest_unacked_ms: d.oldestUnackedMs,
        ...(d.oldestClientOpId === null
          ? {}
          : { oldest_client_op_id: d.oldestClientOpId }),
        reconnects: d.reconnects,
        last_ack_age_ms: d.lastAckAgeMs,
        in_flight_bytes: d.inFlightBytes,
        http_ops_in_flight: d.httpOpsInFlight,
        heal_rounds: d.healRounds,
        hidden: d.hidden,
      },
    });
  }

  args.doc._setDiagnosticsProvider(collectDiagnostics);

  // A network that refuses WebSocket upgrades opens the document over HTTP
  // and then carries none of its edits: they apply locally and queue, and the
  // reconnect loop reports only after its full budget (about five minutes),
  // so a reload inside that window loses them with nothing said. When edits
  // have waited `NEVER_OPENED_NOTICE_MS` on a client that has never opened a
  // socket, the document says so on `status`. Never-opened rather than
  // currently-closed, because a connection that has worked recovers through
  // the resend machinery and a drop there is ordinarily brief.
  let neverOpenedTimer: ReturnType<typeof setTimeout> | null = null;
  function armNeverOpenedNotice(): void {
    if (neverOpenedTimer !== null || args.wsClient.everOpened !== false) return;
    neverOpenedTimer = setTimeout(() => {
      neverOpenedTimer = null;
      if (args.wsClient.everOpened !== false || outstandingResends.size === 0) return;
      args.doc._showConnectionNotice();
    }, NEVER_OPENED_NOTICE_MS);
    (neverOpenedTimer as { unref?: () => void }).unref?.();
  }

  // Resend every outstanding op now and restart its backoff. Called on
  // reconnect (`doc_init`): a dropped-and-restored connection is the most
  // common reason an op went unacked, and the backoff may have grown to its
  // ceiling while the socket was down, so re-asserting immediately is the
  // fast recovery path.
  function resendAllOutstanding(): void {
    // Nothing is on the wire any more, whether this follows a reconnect or a
    // shed, so the budget starts empty and every op re-enters through it.
    // Sending them all at once is what turns one dropped connection into a
    // loop that never persists anything: the burst that lost the socket is
    // exactly the burst the reconnect would repeat.
    inFlightBytes = 0;
    sendQueue.length = 0;
    // Insertion order is the order the ops were committed in, so a round
    // re-asserts them oldest-first.
    for (const [clientOpId, entry] of outstandingResends) {
      clearTimeout(entry.timer);
      entry.attempts += 1;
      entry.inFlight = 0;
      entry.queued = false;
      dispatchOp(clientOpId);
    }
  }

  let unavailableRounds = 0;
  let unavailableTimer: ReturnType<typeof setTimeout> | null = null;

  function clearUnavailableRecovery(): void {
    if (unavailableTimer !== null) {
      clearTimeout(unavailableTimer);
      unavailableTimer = null;
    }
    unavailableRounds = 0;
  }

  // Every outstanding op is dead: drop the tracker entries and tell the
  // Document, which stops counting them in `savingCount` and reports each
  // through the error channel the app reads (`Brass.onError`). The ids are
  // taken first because `_failOutstandingOp` re-enters app code.
  //
  // Dropping the ops is what opens the divergence, so the heal is armed here
  // rather than at the call site: the local doc keeps the abandoned ops and
  // keeps accepting edits that depend on them, and only the handshake can
  // hand the server the slice it needs to apply any of it.
  function failAllOutstanding(message: string): void {
    const clientOpIds = [...outstandingResends.keys()];
    forgetAllOps();
    for (const clientOpId of clientOpIds) {
      args.doc._failOutstandingOp(clientOpId, message);
    }
    if (clientOpIds.length > 0) {
      divergenceHealRound = 0;
      scheduleDivergenceHeal();
    }
  }

  // One op is dead: report it and arm the heal, for the same reason
  // `failAllOutstanding` does. The op stays applied locally and every edit
  // made after it depends on it, so the server holds a stream it can store
  // and never apply, and its own escape for an op nothing can apply is to
  // discard it. Most refusals do not change that: the handshake pushes
  // whatever slice the durable frontier is missing and splits it under the
  // frame cap, so it heals the dependents of an op a transient refusal
  // dropped.
  //
  // `healable: false` is for the refusal where pushing again is asking the
  // same question. A full document refuses every op whatever its size, so
  // the handshake's own chunks come back refused, and the counter reset
  // below turns that into a loop rather than a bounded retry. What recovers
  // that document is the periodic re-verify, once the server can take a
  // write at all. An op too large for any transport this writer has is the
  // same: a split runs between changes, never inside one, so the slice the
  // handshake would push still carries the whole op, and every edit after it
  // waits on an op the server will never hold.
  // A refusal the heal cannot work around leaves the writer holding a change
  // that reached no database and no other reader, so the writer is the only
  // copy of the document that shows it. Left editable it reads as applied: the
  // element is on screen, the count includes it, every later edit builds on
  // it, and a reader who opens the document sees none of it. Nothing local
  // removes it either, because a CRDT merges rather than replaces and an undo
  // inverts an operation instead of discarding it, so the only state holding
  // exactly what is durable is one built from the server.
  //
  // Stopping the divergence and resolving it are separated, because they cost
  // different things and doing them in one silent step is what made a refusal
  // read as the platform losing work. Stopping is free and immediate:
  // `readOnly` turns true, which closes an app's existing edit gate, so the
  // copy cannot drift further. Resolving discards the refused work and swaps
  // the document under whoever was working in it, so the user is told first
  // and the reload follows their acknowledgement.
  //
  // The telling is the SDK's job rather than each app's. A copy left showing a
  // change nothing else has is the failure being closed, so an app that
  // renders no surface for this cannot be the reason a user stays on one.
  //
  // Once per document. The first refusal is what diverged this copy, so the
  // later ones describe the same state and have nothing to add.
  let lockedForRefusal = false;
  function lockForUnhealableRefusal(message: string): void {
    if (lockedForRefusal) return;
    lockedForRefusal = true;
    // Torn down in the order the `doc_gone` handler uses, and for the same
    // reason: every one of these keeps working against a copy that is now
    // read-only, and the resync push in particular would re-offer the refused
    // op this exists to stop.
    forgetAllOps();
    clearUnavailableRecovery();
    if (reverifyTimer !== null) {
      clearInterval(reverifyTimer);
      reverifyTimer = null;
    }
    clearDivergenceHeal();
    if (gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
    // A stream line reaches this only at capacity, and it has no owner to
    // reopen it: the session reopens the top-level id, but a stream is one
    // part of a document nothing reloads on its behalf. So it stops the
    // divergence (above) and marks itself read-only at capacity, which
    // `stream.readOnly` / `stream.atCapacity` already surface to the app,
    // rather than alerting the reader and reloading a document it is part
    // of. The diverged edit stays visible until the app reopens the stream;
    // it reached no other reader, so nothing is lost by leaving it.
    if (args.capacityReloadsDocument === false) {
      args.doc._markReadOnly('capacity');
      return;
    }
    args.doc._markReadOnly('unsaved');
    // The user is told by the SDK, not by each app, because an app that
    // renders nothing is exactly the case this has to cover: a document that
    // reloaded and a document that reloaded for a reason look the same
    // otherwise. `alert` holds the main thread until it is acknowledged, so
    // the reason cannot be missed and the reload lands on a page the user
    // is looking at. A browser that suppresses the dialog returns from it
    // immediately, which reloads rather than skipping, and a caller outside
    // a browser (a worker, a test) has nobody to tell and does the same.
    //
    // The reload survives a dialog that throws, which is the one way telling
    // the user could cost them the fix: `alert` is a page-global an app is
    // free to replace, and the copy this leaves behind is the diverged one
    // the reload exists to discard.
    try {
      if (typeof alert === 'function') alert(message);
    } catch {
      // Told or not, the copy is resolved.
    }
    args.doc._reopen();
  }

  function markGone(reason: 'moved' | 'deleted'): void {
    // Cancel every resend timer FIRST so a doc that was saving when delete
    // landed stops re-trying ops the server will only reject as `forbidden`
    // (the subscription record was evicted at fanout). Draining before the `_markGone`
    // listeners keeps the lifecycle observably clean.
    forgetAllOps();
    clearUnavailableRecovery();
    // Stop re-verifying durability against an evicted doc: a resync push
    // would only bounce as `forbidden`, and a gap pull would only 404.
    if (reverifyTimer !== null) {
      clearInterval(reverifyTimer);
      reverifyTimer = null;
    }
    clearDivergenceHeal();
    if (gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
    args.doc._markGone(reason);
  }

  function failOpTerminally(
    clientOpId: string,
    message: string,
    opts: { healable?: boolean; report?: boolean } = {},
  ): void {
    // Read before `_failOutstandingOp`, which clears the id from the
    // resync-push set on its way out.
    const wasHealPush = args.doc._isResyncPushOp(clientOpId);
    opStartedAt.delete(clientOpId);
    // A refusal the heal cannot answer is about the document, so it answers
    // every op in flight the same way and is reported once, by the lock. Per
    // op, a bulk write's outstanding ops each produce an identical error, so
    // the reader watches the same message arrive dozens of times before the
    // one dialog that explains it.
    args.doc._failOutstandingOp(clientOpId, message, {
      report: opts.report ?? true,
    });
    if (opts.healable === false) {
      lockForUnhealableRefusal(message);
      return;
    }
    // Restart the backoff only for a failure the heal did not itself
    // produce. A refused heal chunk that zeroed the round count would keep
    // the bound from ever binding: each round pushes, each push is refused,
    // and each refusal buys another round. Leaving the count alone lets the
    // rounds run out the way an unanswered handshake already does.
    if (!wasHealPush) divergenceHealRound = 0;
    scheduleDivergenceHeal();
  }

  function onServerUnavailable(): void {
    if (outstandingResends.size === 0) return;
    if (unavailableTimer !== null) return;
    unavailableRounds += 1;
    if (unavailableRounds > UNAVAILABLE_MAX_ROUNDS) {
      clearUnavailableRecovery();
      failAllOutstanding(UNAVAILABLE_GIVE_UP_MESSAGE);
      return;
    }
    const delay = unavailableDelayMs(unavailableRounds);
    unavailableTimer = setTimeout(() => {
      unavailableTimer = null;
      resendAllOutstanding();
    }, delay);
    (unavailableTimer as { unref?: () => void }).unref?.();
  }

  // The ops the durability handshake leaves to this transport: those still
  // queued behind the in-flight budget, and those first sent too recently for
  // their resend timer to have doubted them. An op past its first resend step
  // is fair game for the handshake, since the resend path does not promise it
  // arrives.
  function deliveringOpBlobs(): Uint8Array[] {
    const now = Date.now();
    const blobs: Uint8Array[] = [];
    for (const entry of outstandingResends.values()) {
      if (
        entry.firstDispatchedAt === 0 ||
        now - entry.firstDispatchedAt < RESEND_BASE_DELAY_MS
      ) {
        blobs.push(base64ToBytes(entry.frame.op_blob));
      }
    }
    return blobs;
  }

  // Durability handshake, run on every `doc_init`. The persisted version
  // vector + durable tail ops define the durable frontier; if the local doc
  // holds CRDT knowledge beyond it (an op acked then discarded by the
  // aged-orphan escape), resync-push the missing slice. Import is idempotent,
  // so what the server has no-ops and only the holes fill. The loop guard +
  // compute-and-push live on the Document (`maybeResyncPush`) so the
  // `doc_ops_dropped` path shares them; here we decode the vector and
  // delegate, skipping a missing vector (nothing to verify against).
  function maybeResyncPush(
    snapshotVersionVectorB64: string | undefined,
    durableTailBlobs: Uint8Array[],
  ): void {
    if (!snapshotVersionVectorB64) return;
    const outcome = args.doc.maybeResyncPush(
      base64ToBytes(snapshotVersionVectorB64),
      durableTailBlobs,
      deliveringOpBlobs(),
    );
    // Reported here as well as from the re-verify, or the record holds only
    // the heals that took the slower route and an operator reading it cannot
    // tell that the ordinary reconnect handshake is missing from the set.
    if (outcome === 'pushed') reportSyncHealth('divergence_healed');
  }

  // Re-fetch the durable frontier from the HTTP join and run the handshake.
  // Shared by the `doc_ops_dropped` prompt path and the periodic re-verify:
  // both need the post-discard frontier, which only a fresh fetch carries,
  // not the `doc_init` frame in hand. Cheap (version-vector-and-tail JSON,
  // no snapshot blob).
  //
  // Coalesced, not just guarded: a request arriving mid-fetch sets
  // `reverifyAgain` so exactly one more fetch runs after this one settles. A
  // plain skip-if-in-flight would drop a `doc_ops_dropped` that landed while
  // a tick read the pre-discard frontier (the discard seals the new snapshot
  // then fans out), deferring the heal to the next tick or reconnect.
  let reverifyInFlight = false;
  let reverifyAgain = false;
  // Armed after the subscription is wired, cleared on `doc_gone` and teardown.
  let reverifyTimer: ReturnType<typeof setInterval> | null = null;
  // The last run's verdict, so a caller healing a known divergence can tell a
  // finished handshake from one that fetched nothing.
  async function reverifyDurability(): Promise<ResyncPushOutcome | 'no-fetch'> {
    if (reverifyInFlight) {
      reverifyAgain = true;
      return 'in-flight';
    }
    reverifyInFlight = true;
    let outcome: ResyncPushOutcome | 'no-fetch' = 'no-fetch';
    try {
      do {
        reverifyAgain = false;
        try {
          const frontier = await args.refetchDurableFrontier?.();
          if (frontier && frontier.snapshotVersionVector) {
            outcome = args.doc.maybeResyncPush(
              base64ToBytes(frontier.snapshotVersionVector),
              frontier.tailBlobs,
              deliveringOpBlobs(),
            );
            // The handshake having work to do means the server's copy was
            // behind this client's, which is the state a lost op leaves and
            // which nothing on the server side reports.
            if (outcome === 'pushed') reportSyncHealth('divergence_healed');
          }
        } catch {
          // Best-effort: a failed re-fetch defers the check to the next tick
          // or reconnect's `doc_init` handshake. Swallowed so the timer's
          // fire-and-forget never surfaces an unhandled rejection and one
          // failed tick does not wedge the loop guard. The `no-fetch` verdict
          // is what keeps a divergence heal asking.
          outcome = 'no-fetch';
        }
      } while (reverifyAgain);
    } finally {
      reverifyInFlight = false;
    }
    return outcome;
  }

  // Divergence heal. Giving up on an op leaves the local doc holding CRDT
  // knowledge the server does not, and Loro requires per-actor causal
  // contiguity, so every op the app writes afterwards reaches the server as
  // causally unapplyable and stays that way until the missing slice arrives.
  // The server's own escape for an op nothing can apply is to discard it, so
  // the window between the give-up and the next handshake is a window where
  // the app writes into a document that keeps none of it.
  //
  // The periodic re-verify would eventually close that window, but on its own
  // schedule: a bulk write finishes and the reader reloads well inside one
  // tick. A give-up is the moment the client knows it has diverged, so it
  // drives the handshake itself, and keeps driving it on a backoff until one
  // run reports the durable frontier covering the local doc. The first delay
  // is not zero because the give-up follows sustained shedding, so the fetch
  // this schedules would join the burst it is recovering from.
  const DIVERGENCE_HEAL_BASE_DELAY_MS = 2_000;
  const DIVERGENCE_HEAL_MAX_DELAY_MS = 30_000;
  // Roughly four minutes of attempts, after which the periodic re-verify is
  // the remaining backstop and the tab has long since reported the failure.
  const DIVERGENCE_HEAL_MAX_ROUNDS = 12;
  let divergenceHealRound = 0;
  let divergenceHealTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleDivergenceHeal(): void {
    if (divergenceHealTimer !== null) return;
    if (divergenceHealRound >= DIVERGENCE_HEAL_MAX_ROUNDS) return;
    divergenceHealRound += 1;
    const delay = Math.min(
      DIVERGENCE_HEAL_BASE_DELAY_MS * Math.pow(2, divergenceHealRound - 1),
      DIVERGENCE_HEAL_MAX_DELAY_MS,
    );
    divergenceHealTimer = setTimeout(() => {
      divergenceHealTimer = null;
      void reverifyDurability().then((outcome) => {
        // `covered` is the only verdict that proves the hole is closed. A
        // push that just went out is not yet durable, so the next round
        // re-checks it rather than assuming its acks land, and the backoff
        // it comes back on is what keeps a push settling from being polled.
        if (outcome !== 'covered') scheduleDivergenceHeal();
        else divergenceHealRound = 0;
      });
    }, delay);
    (divergenceHealTimer as { unref?: () => void }).unref?.();
  }

  function clearDivergenceHeal(): void {
    if (divergenceHealTimer !== null) {
      clearTimeout(divergenceHealTimer);
      divergenceHealTimer = null;
    }
    divergenceHealRound = 0;
  }

  // A coverage floor below the highest seq seen records ops this client
  // applied nothing for, and the server posts each op once, so nothing
  // re-sends them. Pull the join instead, after a delay long enough for an
  // out-of-order arrival to close the hole itself.
  //
  // The delay is only meaningful against the hole this check was ARMED on,
  // which is why the seq it waits to reach is captured here rather than read
  // again when it fires. Holes are the ordinary state of a client that is
  // writing: acks overtake heavily, so the newest acked seq sits above the
  // contiguous floor almost continuously, and each such hole closes as the ack
  // below it lands. Asking on expiry whether ANY hole exists reads a
  // brand-new one, opened by ops sent since, as the original persisting, and a
  // client that keeps writing always has one. That answer costs a join
  // re-import, which discards the undo and redo stacks, so the reader loses
  // their history every couple of seconds while nothing is wrong.
  //
  // Rounds that move nothing back off and then stop, and any advance in the
  // floor starts the budget over. What separates the two cases is exactly
  // that: a hole left by a write still in flight fills as the rows land, so
  // each pull delivers more and earns the next one, while a seq the server
  // allocated and never wrote (a failed op write leaves a hole rather than a
  // duplicate) delivers nothing however often it is asked for. Without the
  // budget that second hole is a join re-import every couple of seconds for
  // the life of the tab, each one discarding the reader's undo history. It
  // clears at the next compaction, which folds the tail past the hole.
  const GAP_PULL_MAX_ROUNDS = 6;
  const GAP_PULL_MAX_DELAY_MS = 30_000;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;
  let gapPullRounds = 0;
  let gapPullFloor = -1;
  function scheduleGapCheck(): void {
    if (gapTimer !== null) return;
    const awaited = args.getCurrentSeq();
    const floor = args.getCoveredSeq();
    if (floor >= awaited) {
      gapPullRounds = 0;
      return;
    }
    if (floor > gapPullFloor) gapPullRounds = 0;
    if (gapPullRounds >= GAP_PULL_MAX_ROUNDS) return;
    gapPullRounds += 1;
    gapPullFloor = floor;
    const delay = Math.min(
      MISSED_OP_RESYNC_DELAY_MS * Math.pow(2, gapPullRounds - 1),
      GAP_PULL_MAX_DELAY_MS,
    );
    gapTimer = setTimeout(() => {
      gapTimer = null;
      // Covered up to where the hole was: it closed on its own, whatever has
      // been sent since. Anything newer arms its own check.
      if (args.getCoveredSeq() >= awaited) {
        gapPullRounds = 0;
        return;
      }
      // The head can be this client's own op still being written over HTTP,
      // so the judgement waits for that write as a catch-up prompt does.
      resyncPastSeq(awaited);
    }, delay);
    (gapTimer as { unref?: () => void }).unref?.();
  }

  // The server ended this subscription: it refused the subscribe (access
  // that ended between the HTTP join and the subscribe, which no eviction can
  // reach because no subscription row exists yet), or evicted it again after
  // the one silent re-subscribe a connection grants. The client detaches this
  // transport from the topic as it reports that, so no ack, no fanout and no
  // reconnect reaches it again.
  //
  // That is the same fact a `doc_gone` reports, so the copy ends the same
  // way: `moved`, which a session answers by re-opening the id, so the
  // current gate re-admits a reader who still reaches the document and
  // refuses one who does not. A second end inside the window is `deleted`,
  // which ends the copy without the re-open.
  let subscriptionEnded = false;
  function endSubscription(): void {
    if (subscriptionEnded) return;
    subscriptionEnded = true;
    markGone(endedReasonFor(topic));
  }

  // 1. Subscribe to the doc topic. Frame routing:
  //    - `doc_init`: bridge the join-vs-fanout race. Ops committed between
  //      the HTTP join (T0) and the WS subscribe (T1) miss the HTTP tail and
  //      can race the subscription record so the first `doc_op` fanout may arrive BEFORE
  //      doc_init (separate server invocations, no wire ordering). tail_ops
  //      apply unconditionally: filtering on `seq > currentSeq` would mask
  //      tail_ops a racing `doc_op` inflated the cursor past, leaving lamport
  //      gaps Loro cannot converge across (re-applying is an idempotent
  //      no-op).
  //    - `doc_catch_up`: the document moved past this client's coverage on
  //      an op the socket could not carry; re-import the join and nothing
  //      more (see the branch).
  //    - `doc_op`: apply, advance cursor.
  //    - `op_ack`: resolve the outstanding-op tracker, advance cursor, cancel
  //      that op's resend timer.
  //    - everything else: handled by `BrassWsClient`.
  const unsub = args.wsClient.subscribe(
    topic,
    (frame) => {
      const init = parseDocInitFrame(frame);
      if (init) {
        // A new version replaced the line while this copy was away (the
        // `doc_gone` naming it went to a socket that was down). Its tail is
        // the new version's, and nothing this copy holds or would re-assert
        // applies to it, so it reopens before applying or resending anything.
        if (importSeqMoved(args.doc, init.import_seq)) {
          markGone('moved');
          return;
        }
        // Recorded as the frame arrives rather than after the tail applies.
        // Importing a tail op can throw, and the client swallows it, so a
        // latch written further down would stay behind and read the NEXT
        // reconnect as the opening subscribe, suppressing the report this
        // exists to make.
        const reconnects = args.wsClient.reconnectCount ?? 0;
        const wasSubscribed = docInitReconnectCount !== null;
        const socketDropped =
          docInitReconnectCount !== null && reconnects > docInitReconnectCount;
        docInitReconnectCount = reconnects;
        // Resync check BEFORE applying. The tail covers (snapshot_seq,
        // current_seq]; if the coverage floor sits below the tail's lower edge
        // (or below current_seq when the tail is empty), ops in between were
        // compacted into the snapshot while disconnected and exist nowhere in
        // this tail or future fanout, so re-import the join's snapshot. The
        // initial subscribe never trips this (the floor was just seeded), so
        // the cost is paid only on a reconnect that crossed a compaction.
        const snapshotFloor = snapshotSeqOf(
          init.snapshot_seq,
          init.tail_ops.map((entry) => entry.seq),
          init.current_seq,
        );
        const needsResync = args.getCoveredSeq() < snapshotFloor;
        const tailBlobs: Uint8Array[] = [];
        // Whether the frame's own entries can describe the durable frontier.
        // An entry the server withheld the bytes of still NAMES an op the
        // server holds, so a frontier folded from the inline entries alone
        // reports every withheld op as missing from the server. See the
        // handshake call below.
        let tailComplete = true;
        for (const entry of init.tail_ops) {
          // An op with no inline bytes is deliberately left uncovered: it
          // has not been applied, so marking it covered would retire the
          // very resync that fetches it.
          if (entry.op_blob_b64 === undefined) {
            tailComplete = false;
            continue;
          }
          const blob = base64ToBytes(entry.op_blob_b64);
          tailBlobs.push(blob);
          args.doc.applyRemoteOp(blob);
          if (entry.seq > args.getCurrentSeq()) args.setCurrentSeq(entry.seq);
          args.advanceCoveredSeq(entry.seq);
        }
        // The frame also has to ACCOUNT for every seq the head names, not
        // merely carry bytes for the entries it lists. The server drops an
        // oversized or spilled tail from this frame ENTIRELY rather than
        // listing it byte-less (`document.tail.dropped`), so an empty tail on
        // a branch whose head sits above its snapshot is not a branch with
        // nothing in flight: it is the whole tail withheld. Measured on a
        // real document: snapshot_seq 565, current_seq 1089, 524 ops dropped
        // from the frame and every one of them already imported by the HTTP
        // join, so a frontier folded from this frame alone sat 524 ops behind
        // the local doc and pushed them back on every open.
        if (
          typeof init.snapshot_seq === 'number' &&
          tailBlobs.length < init.current_seq - init.snapshot_seq
        ) {
          tailComplete = false;
        }
        if (init.current_seq > args.getCurrentSeq()) {
          args.setCurrentSeq(init.current_seq);
        }
        if (needsResync) {
          resyncPastSeq(init.current_seq);
        } else {
          // A frame that named a head it did not carry the tail for leaves
          // the reader short with nothing further coming: the server drops an
          // oversized or spilled tail from this frame and posts each op once.
          // For a reader that never writes, this and the catch-up prompt are
          // the only two places a gap gets noticed at all.
          scheduleGapCheck();
        }
        // `doc_init` is the reconnect signal the retry-forever recovery hangs
        // off: re-assert every outstanding op and run the durability handshake
        // now, so a client holding work the server lost re-asserts it on
        // reconnect rather than waiting out the per-op backoff. A fresh
        // connection also returns the shed budget to full: this re-assert is
        // the round the pending one would have run.
        clearUnavailableRecovery();
        // A reconnect, rather than the initial subscribe: the socket dropped
        // while this document held work, which is the condition the server
        // has no way to see. The first `doc_init` arrives on the opening
        // subscribe, and an app that writes as soon as it opens already has
        // ops outstanding by then, so reporting on every `doc_init` would
        // fire routinely on a healthy first open and train a reader of the
        // log to discount the event.
        //
        // Before the round rather than after, so the counters describe the
        // work the reconnect found rather than the work it has just put back
        // on the wire.
        if (socketDropped && outstandingResends.size > 0) {
          reportSyncHealth('reconnected_unsaved');
        }
        resendAllOutstanding();
        // A nudge posted while the topic was down is gone, so every status
        // this document holds asks what moved since its revision.
        if (wasSubscribed) args.doc._inputStatusNudged(null, null);
        // The handshake needs the WHOLE durable tail, and this frame carries
        // it only when every entry came inline. A spilled op is named here
        // with its bytes withheld, and the HTTP join the reader already ran
        // resolves and imports it, so a frontier built from the inline
        // entries alone sits behind the local doc by exactly the ops that
        // spilled, and the handshake pushes the reader's copy of the server's
        // own tail back at it. On a branch at capacity every chunk is refused
        // and reported, which is an error on screen for someone who only
        // reopened the document; on any other branch it lands, writing a
        // second durable copy of every spilled op and growing the document
        // toward the ceiling on each open. `reverifyDurability` fetches
        // through `fetchSnapshot`, which resolves spilled entries, so the
        // frontier it diffs against is complete.
        if (tailComplete) {
          maybeResyncPush(init.snapshot_version_vector, tailBlobs);
        } else {
          void reverifyDurability();
        }
        // The tail has applied, so every author this client can hear from is
        // in its doc. An author left in the durable frontier is one whose
        // changes exist only inside the snapshot, which is the platform having
        // rewritten how the document stores what it stores. A client cannot
        // undo across that: its stack inverts the operations it made, and the
        // values those operations wrote have moved, so an undo would remove
        // nothing and report success. Re-import instead, which drops both
        // stacks and leaves the reader on fresh state with undo honestly
        // unavailable.
        //
        // Coverage does not catch this on its own, and the case it misses is
        // the ordinary one: the fold runs on a branch nobody has open, so the
        // client that returns to it missed no ops and has no gap to notice.
        if (!needsResync) maybeResyncPastRewrite(init.snapshot_version_vector);
        // Posted after the subscription record exists, so this is the safe point to
        // reconcile a pending open whose terminal status frame was dropped.
        args.reconcileStatusOnInit?.();
        args.onDocumentMoved?.();
        return;
      }
      if (isDocCatchUpFrame(frame)) {
        // The document moved past what this client can bridge to, so pull the
        // join. Nothing else: the prompt describes the document rather than
        // this subscription, and every subscriber gets one on each op the
        // socket could not carry. Re-asserting outstanding ops here writes a
        // second durable copy of each of them (the server allocates a fresh
        // seq per send) for every such op any writer makes, and cancelling
        // the shed recovery here parks a shed op on its per-op backoff
        // instead of the schedule the shed armed.
        if (frame.current_seq > args.getCurrentSeq()) {
          args.setCurrentSeq(frame.current_seq);
        }
        if (args.getCoveredSeq() < frame.current_seq) {
          resyncPastSeq(frame.current_seq);
        }
        return;
      }
      if (isDocOpFrame(frame)) {
        // Apply unconditionally. A `seq <= currentSeq` short-circuit looks safe
        // (import is idempotent) but permanently drops ops on out-of-order
        // fanout: seq=14 before seq=13 inflates the cursor past 13, after which
        // seq=13 is skipped forever, leaving a lamport gap Loro cannot converge
        // across.
        const bytes = base64ToBytes(frame.op_blob);
        args.doc.applyRemoteOp(bytes);
        if (frame.seq > args.getCurrentSeq()) args.setCurrentSeq(frame.seq);
        args.advanceCoveredSeq(frame.seq);
        scheduleGapCheck();
        args.onDocumentMoved?.();
        return;
      }
      if (isOpAckFrame(frame)) {
        // Evidence the connection is working through its queue, which is what
        // the resend timers read to tell a slow ack from a silent server.
        lastAckAt = Date.now();
        args.doc.resolveOutstandingOp(frame.client_op_id, frame.seq);
        args.setCurrentSeq(frame.seq);
        args.advanceCoveredSeq(frame.seq);
        // An ack for a local op sits above any remote op this client never
        // received, so the user's own next edit is a second chance to notice.
        scheduleGapCheck();
        forgetOp(frame.client_op_id);
        // The server is durably accepting writes again, so the shed budget
        // starts over. A round already scheduled still runs: the ops it
        // re-asserts are the ones this ack did not cover.
        unavailableRounds = 0;
        return;
      }
      if (isServerUnavailableFrame(frame)) {
        onServerUnavailable();
        return;
      }
      if (isOpRejectedFrame(frame)) {
        // Terminal, not transient: cancel this op's resend (retrying would only
        // draw the same rejection forever and pin `savingCount`) and fail it on
        // the Document so the app hears "could not be saved" instead of a silent
        // wedge. Scoped to this one op; the topic subscription stays live.
        forgetOp(frame.client_op_id);
        // A new version replaced the line under this copy. Not healable and
        // not this op's alone: every op it holds names the replaced version,
        // so the copy reopens, which drops them all.
        if (frame.reason === OP_REJECTED_MOVED) {
          markGone('moved');
          return;
        }
        // The flip is the one moment the refusal is worth reporting: every op
        // in flight draws the same sentence, and a bulk write has as many of
        // those as it has unacked writes.
        const atCapacity = isCapacityRejection(frame);
        const firstCapacityRefusal = atCapacity && args.doc._markAtCapacity();
        // A refusal that names the writer rather than the op applies to
        // every op this reader will send, so it turns the whole Document
        // read-only before the failure is reported: the app's own
        // `doc.readOnly` gate then disables the editor in the same tick the
        // reader hears why, rather than letting them keep typing into a
        // surface nothing will save.
        const readOnly = readOnlyReasonForRejection(frame);
        if (readOnly !== null) args.doc._markReadOnly(readOnly);
        // NO capacity refusal is healable, whichever kind it is. The refused
        // work sits on this copy and nowhere else, and the heal is the only
        // thing that could place it: when it runs out of rounds it stops
        // silently, so a copy the handshake could not settle is one showing
        // work that a reload will not, with nothing said. Both kinds therefore
        // lock, tell and reload, which is what the server's own wording for
        // each of them already promises.
        //
        // The other refusals here stay healable: the handshake splits the
        // slice under the frame cap, which is what reaches the dependents of
        // an op that is itself too large to re-send.
        failOpTerminally(frame.client_op_id, opRejectedMessage(frame), {
          healable: !atCapacity && frame.reason !== OP_REJECTED_NOT_IMPORTED,
          report: !atCapacity || firstCapacityRefusal,
        });
        return;
      }
      if (isDocGoneFrame(frame)) {
        markGone(goneReasonOf(frame));
        return;
      }
      if (isDocStatusFrame(frame)) {
        const status = normalizeWorkStatus(frame.status);
        // `reload` is the server's authoritative "succeeded, content ready"
        // hint: pull the content in and emit the terminal status only AFTER the
        // import lands, so an app re-reading on `onStatus` sees content present.
        // A failure frame has no `reload`, so emit immediately and fetch
        // nothing (no racy read, no loop).
        if (frame.reload && args.reloadAfterHydration) {
          args.reloadAfterHydration(status);
        } else if (
          status.pending &&
          status.blocking !== false &&
          args.doc._workStatusNow?.pending !== true &&
          args.verifyPendingStatus
        ) {
          args.verifyPendingStatus(status);
        } else {
          args.doc._emitStatus(status);
        }
        return;
      }
      if (isDocMetaFrame(frame)) {
        // `_setName` de-dupes, so a re-emit of the current name is a no-op.
        args.doc._setName(frame.name);
        return;
      }
      const nudge = parseInputStatusNudge(frame);
      if (nudge !== null) {
        // The frame names the key and its new revision alone; the status
        // fetches what moved.
        args.doc._inputStatusNudged(nudge.key, nudge.rev);
        return;
      }
      if (isDocDriveStatusFrame(frame)) {
        // The signal de-dupes a no-op re-emit, so forwarding every frame is safe.
        args.doc._emitDriveStatus(toDriveStatus(frame.drive));
        return;
      }
      if (isDocDrivePublishFrame(frame)) {
        args.doc._emitPublishState({
          publishing: frame.publish.publishing === true,
          failed: frame.publish.failed === true,
          detail:
            typeof frame.publish.detail === 'string' ? frame.publish.detail : null,
        });
        return;
      }
      if (isDocOpsDroppedFrame(frame)) {
        // Prompt durability re-check: the discard sealed a new snapshot, so
        // re-fetch the moved frontier and run the handshake now instead of at
        // the author's next reconnect. The handshake self-selects: the author
        // finds local ahead and resync-pushes under a new seq, others no-op.
        // Covered by the `doc_init` handshake / periodic re-verify if missed.
        void reverifyDurability();
        return;
      }
      // Unknown frame: ignore, so server-side schema growth doesn't break
      // older SDK builds.
    },
    {
      // `resendAllOutstanding` on the `doc_init` that follows every
      // `subscribed` ack IS this topic's re-assertion, so the client drops an
      // op frame it cannot send now rather than buffering a second copy.
      ownsFrameRetry: true,
      onEnded: endSubscription,
    },
  );

  // Arm the periodic durability re-verify (the long-lived-tab backstop).
  // `unref` so the interval never keeps a Node host alive (no-op in the
  // browser); cleared on `doc_gone` and teardown either way.
  reverifyTimer = setInterval(() => {
    void reverifyDurability();
  }, PERIODIC_REVERIFY_INTERVAL_MS);
  (reverifyTimer as { unref?: () => void }).unref?.();

  // 2. Install the local-op hook, called by `subscribeLocalUpdates` after
  //    every successful `commit()`. Each frame is registered in the resend
  //    tracker so a silently-dropped server response triggers a retry.
  args.doc.setLocalOpHook((opBlob) => {
    const clientOpId = args.newClientOpId();
    opStartedAt.set(clientOpId, Date.now());
    const opBlobB64 = bytesToBase64(opBlob);
    const sendFrame: OpFrame = {
      type: 'op',
      topic,
      op_blob: opBlobB64,
      client_op_id: clientOpId,
      ...baseImportSeqField(args.doc),
    };

    // A frame past the transport's cap is not delivered and takes the
    // connection down with it, so it must never reach the socket OR the
    // resend tracker: re-sending it on each reconnect is what turns one
    // bulk mutation into a reconnect loop that persists nothing and churns
    // presence. Route it to the HTTP op write instead, which shares the
    // durable path and tells other subscribers to catch up.
    if (opFrameExceedsWsLimit(sendFrame)) {
      void writeOversizedOp(opBlobB64, clientOpId);
      return clientOpId;
    }

    outstandingResends.set(clientOpId, {
      frame: sendFrame,
      attempts: 1,
      // Placeholders, overwritten by `dispatchOp` and `scheduleResend` once
      // the op is actually on the socket.
      timer: setTimeout(() => undefined, 0),
      armedAt: 0,
      dispatchedAt: 0,
      inFlight: 0,
      queued: false,
      firstDispatchedAt: 0,
    });
    dispatchOp(clientOpId);
    armNeverOpenedNotice();
    return clientOpId;
  });

  async function writeOversizedOp(
    opBlobB64: string,
    clientOpId: string,
  ): Promise<void> {
    // Counted before the first await, so a catch-up prompt for this op
    // cannot arrive between the frame going out and the count going up.
    httpOpWritesInFlight += 1;
    try {
      await writeOversizedOpInner(opBlobB64, clientOpId);
    } finally {
      settleHttpOpWrite();
    }
  }

  async function writeOversizedOpInner(
    opBlobB64: string,
    clientOpId: string,
  ): Promise<void> {
    // Yield before any outcome resolves the op. The hook's caller records
    // the outstanding op AFTER the hook returns, and an async function body
    // runs synchronously up to its first await, so an exit taken inline
    // would find nothing tracked and leave the entry behind with
    // `savingCount` stuck above zero.
    await Promise.resolve();

    // The size is known here, so refuse without spending a round trip on a
    // blob that can only come back 400.
    if (opBlobExceedsDurableLimit(opBlobB64)) {
      failOpTerminally(clientOpId, TOO_LARGE_MESSAGE, { healable: false });
      return;
    }

    if (!args.postOversizedOp) {
      failOpTerminally(clientOpId, TOO_LARGE_MESSAGE, { healable: false });
      return;
    }
    // An oversized op is deliberately kept out of `outstandingResends` (a
    // frame past the cap must never reach the socket), so the shed recovery
    // that re-asserts the tracker cannot reach this one. It runs its own
    // round of the same policy instead, on the same budget and backoff, so a
    // capacity refusal costs an op the same nothing whichever transport
    // carried it.
    let result: OversizedOpResult | undefined;
    for (let round = 0; round <= UNAVAILABLE_MAX_ROUNDS; round += 1) {
      if (round > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, unavailableDelayMs(round));
          (timer as { unref?: () => void }).unref?.();
        });
      }
      try {
        result = await args.postOversizedOp(opBlobB64, clientOpId);
      } catch (err) {
        result = {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          // Staging the blob runs strictly before the op write, so a failure
          // there wrote nothing and the op is still the client's to send: it
          // is priced the way the write prices its own refusals. Any other
          // throw leaves it unknown whether the handler ran, and this op
          // carries no idempotency the server dedupes on, so replaying it
          // could double-apply.
          retryable:
            err instanceof OpStagingError && opStagingIsRetryable(err),
        };
      }
      if (result.ok || !result.retryable) break;
    }
    if (result === undefined) {
      opStartedAt.delete(clientOpId);
      return;
    }
    if (!result.ok && result.moved === true) {
      opStartedAt.delete(clientOpId);
      markGone('moved');
      return;
    }
    if (!result.ok) {
      // Terminal for this op, the same way `op_rejected` is: the local
      // commit stays applied but never persists, so the app hears about it
      // instead of watching `savingCount` sit above zero forever. A refusal
      // about the writer turns the Document read-only first, so the app's
      // own gate closes the editor as the reader is told why.
      const firstCapacityRefusal =
        result.atCapacity === true && args.doc._markAtCapacity();
      if (result.readOnly) args.doc._markReadOnly(result.readOnly);
      failOpTerminally(
        clientOpId,
        result.retryable ? UNAVAILABLE_GIVE_UP_MESSAGE : result.message,
        {
          healable:
            result.atCapacity !== true &&
            result.notImported !== true &&
            result.tooLarge !== true,
          report: result.atCapacity !== true || firstCapacityRefusal,
        },
      );
      return;
    }
    // Same bookkeeping an `op_ack` does: resolve the outstanding entry and
    // advance both cursors past the seq the server allocated.
    opStartedAt.delete(clientOpId);
    args.doc.resolveOutstandingOp(clientOpId, result.seq);
    args.setCurrentSeq(result.seq);
    args.advanceCoveredSeq(result.seq);
  }

  // 2b. Expose the live-head-seq cursor so `Brass.documents.setThumbnail` can
  //     anchor a screenshot to the version it depicts.
  args.doc.setCurrentSeqProvider(args.getCurrentSeq);

  // 3. Attach the presence controller. It subscribes to the sibling
  //    `presence:doc:<docId>:<branchId>` topic on the same shared client, so
  //    presence and ops are independent fanout channels on one connection,
  //    both scoped to the opened branch. Exposed as `doc.presence`.
  //    Presence is document-level (one roster per open doc), so a stream
  //    line's transport skips it.
  if (args.skipPresence !== true) {
    args.doc.presence = createPresenceController(
      args.wsClient,
      args.docId,
      args.branchId,
    );
  }

  // 4. Tear-down hook. Patch `Document.close` once (rather than have Document
  //    accept a teardown callback) so `Document` stays free of WS knowledge:
  //    the first close detaches the subscription, drops the hook, tears down
  //    presence, then runs the original close.
  const originalClose = args.doc.close.bind(args.doc);
  // Set once `fullTeardown` has run (via the unparkable close path OR a park
  // cache eviction). Guards both `fullTeardown` (so its intermediate steps
  // don't run twice) and the patched close below (so a double-close of an
  // already-evicted, already-closed Document does not re-park it, which would
  // hand a later open a closed Document whose every method throws).
  let tornDown = false;
  // Captured so it can run from either the patched close (unparkable case) or
  // the park cache's eviction.
  const fullTeardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    try {
      unsub();
    } catch {
      // unsub failure is non-fatal (already-detached); closing the Document
      // below is what matters.
    }
    try {
      args.doc.presence?.leave();
    } catch {
      // Best-effort; never block the Document close below.
    }
    args.doc.setLocalOpHook(null);
    args.doc.setCurrentSeqProvider(null);
    if (reverifyTimer !== null) {
      clearInterval(reverifyTimer);
      reverifyTimer = null;
    }
    if (neverOpenedTimer !== null) {
      clearTimeout(neverOpenedTimer);
      neverOpenedTimer = null;
    }
    clearDivergenceHeal();
    if (gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
    forgetAllOps();
    clearUnavailableRecovery();
    originalClose();
  };
  (args.doc as Document & { close: () => void }).close = () => {
    // Already fully torn down (an LRU eviction closed this Document while it
    // was parked): a second close must not re-park a closed Document.
    if (tornDown) return;
    // Read-only previews bypass parking: no undo stack to preserve, and a
    // stale preview would shadow a later live-head open. Same for a doc with
    // no stable branchId to key on, and for a stream line's internal doc
    // (its lifecycle is the parent Document's). Keying on the REQUESTED branch
    // (not the resolved one) keeps park and take symmetric; a default-branch
    // open has no requested branch and so skips the cache.
    //
    // A doc with work still running skips it too: parking clears the status
    // listeners, and the SDK's own waiters on that work (the import runner
    // waits for the phase that produces the file it imports) are keyed to
    // this instance, so a reopen would hand back a Document whose wait can
    // never fire. A fresh open re-attaches everything.
    //
    // So does one the server has evicted. `takeParkedDocument` refuses such an
    // entry, so parking it buys nothing and costs everything parking keeps
    // alive: the topic subscription (which goes on delivering every op of a
    // document nobody is reading) and the LoroDoc's heap, until some later
    // open or eviction reaches that key. A move is the case that makes this
    // routine rather than terminal, because the session follows it by
    // reopening the same id, so the evicted copy is retired on every move.
    const parkable =
      !args.doc.readOnly &&
      args.parkable !== false &&
      args.doc._workStatusNow?.pending !== true &&
      args.doc._goneReason === null;
    const cacheKey = parkable
      ? parkCacheKey(args.docId, args.requestedBranchId, args.requestedStream)
      : null;
    if (cacheKey === null) {
      fullTeardown();
      return;
    }
    args.doc._suspend();
    parkDocument({
      doc: args.doc,
      teardown: fullTeardown,
      key: cacheKey,
      optionsSig: documentOptionsSig(args.documentOptions),
      identity: args.identity?.() ?? null,
    });
  };
}

/**
 * Fetch a presigned snapshot, streaming the body so download progress
 * can be reported as bytes arrive. The total is the decompressed size
 * from the object's `x-amz-meta-raw-bytes` metadata header (snapshots
 * are stored gzip-compressed; the browser decompresses transparently,
 * so the streamed chunk sizes sum to the decompressed total). Falls
 * back to a non-streamed read when the body stream or progress sink is
 * unavailable.
 */
async function fetchPresignedSnapshot(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new BrassError('Presigned snapshot fetch failed', {
      status: response.status,
    });
  }
  const rawHeader = response.headers.get('x-amz-meta-raw-bytes');
  const total =
    rawHeader !== null && Number.isFinite(Number(rawHeader))
      ? Number(rawHeader)
      : null;
  if (!onProgress || !response.body) {
    const buf = await response.arrayBuffer();
    onProgress?.(buf.byteLength, total);
    return new Uint8Array(buf);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// A snapshot delivery `kind` this build does not implement means the server is
// serving a document in a shape newer than this pinned SDK can read. Surface a
// legible upgrade prompt (rendered verbatim through `session.error`), never an
// empty document: treating an unreadable snapshot as "no snapshot" would let
// the user edit and overwrite content that is actually there.
/** Whether the server names a head above the seq its snapshot was sealed at,
 *  which is state the payload has not delivered. Read beside `tail_ops`, so a
 *  response that dropped its tail entries for budget is still seen as having
 *  one rather than as a document that stops at its base. A server that sends
 *  neither seq answers by its entries alone, which is all it ever had. */
function coversMoreThanSnapshot(
  body: Pick<DocumentSnapshotResponse, 'current_seq' | 'snapshot_seq'>,
): boolean {
  const { current_seq: current, snapshot_seq: sealed } = body;
  return current !== undefined && sealed !== undefined && current > sealed;
}

/** The open with its top-level `readOnly` folded into `documentOptions`,
 *  which is where every path below reads the intent from. The top-level
 *  value wins over `documentOptions.readOnly` when both are set. */
function withReadIntent(
  options: OpenDocumentByIdOptions | undefined,
): OpenDocumentByIdOptions | undefined {
  if (options?.readOnly === undefined) return options;
  const { readOnly, ...rest } = options;
  const { readOnly: _alias, ...documentOptions } = rest.documentOptions ?? {};
  return {
    ...rest,
    documentOptions: readOnly ? { ...documentOptions, readOnly: true } : documentOptions,
  };
}

/** Whether this open will never write: the caller asked for a snapshot, or
 *  for a read-only Document. The grant is not consulted, because a caller who
 *  may edit and says nothing is one that may edit. */
function opensReadOnly(options: OpenDocumentByIdOptions | undefined): boolean {
  return options?.frozen === true || options?.documentOptions?.readOnly === true;
}

/** The options every re-join of `branch` sends, a member's and a guest's
 *  alike: the line it names, and the read intent of the open it serves, so a
 *  document opened read-only is re-joined read-only and one opened to write
 *  is re-joined to write. */
function rejoinOptions(
  branch: string | undefined,
  open: OpenDocumentByIdOptions | undefined,
): OpenDocumentByIdOptions {
  const base = branch !== undefined ? { branch } : {};
  return opensReadOnly(open) ? { ...base, documentOptions: { readOnly: true } } : base;
}

/** What re-joining an open document did to it. */
type JoinApplied =
  /** The join's content and tail were imported into the document. */
  | { kind: 'applied'; content: JoinContent; tailSeqs: number[] }
  /** The document holds the frozen content the join serves. */
  | { kind: 'unchanged' }
  /** The join serves content the document cannot take in place, so it was
   *  reloaded. */
  | { kind: 'reloaded' };

/**
 * Apply a re-join to an open document: the reload, a line's resync and a
 * guest's pull all end here.
 *
 * CRDT content over a CRDT document merges in place. Over frozen content it is
 * a storage upgrade (`Document._upgradeStorage`), and frozen content sealed at
 * another seq replaces the frozen content; both keep the app's handles and
 * their subscribers. Frozen content served to a CRDT document, or content the
 * document cannot take in place, reloads it.
 */
// The seal of frozen content that holds nothing yet: no join's seq matches it.
const NO_SEAL = -1;

// The `import_seq` each CRDT copy was opened at. A new version's import
// replaces a line's content with a CRDT authored by the same pinned peer as
// the one it replaces, so merging the new content into an old copy dedupes it
// away and leaves the old copy's ops pointing at containers the line no
// longer has. A copy that sees the line under a different import reopens
// instead, and names its base on every op so the server refuses one that
// raced the import (`moved`).
const openedImportSeq = new WeakMap<Document, number>();

function recordImportSeq(doc: Document, importSeq: unknown): void {
  if (typeof importSeq === 'number') openedImportSeq.set(doc, importSeq);
}

function importSeqMoved(doc: Document, importSeq: unknown): boolean {
  const base = openedImportSeq.get(doc);
  return base !== undefined && typeof importSeq === 'number' && importSeq !== base;
}

function baseImportSeqField(doc: Document): { base_import_seq?: number } {
  const base = openedImportSeq.get(doc);
  return base === undefined ? {} : { base_import_seq: base };
}

async function applyJoin(
  doc: Document,
  body: {
    snapshot: unknown;
    tail_ops: Array<{ seq: number; op_blob_b64: string }>;
    snapshot_seq?: number;
    current_seq?: number;
    import_seq?: number;
  },
  fetchBody: ContentFetch,
): Promise<JoinApplied> {
  // Decided off the wire's own statement of the encoding, so content the
  // document will not keep is never downloaded.
  const encoding = joinEncoding(body.snapshot);
  // Frozen content replaces a reader's CRDT rather than merging into it, so a
  // new version's import is taken in place below.
  const replacesCrdt = encoding === 'frozen' && !doc._holdsRecordSet();
  if (!replacesCrdt && importSeqMoved(doc, body.import_seq)) {
    doc._reopen();
    return { kind: 'reloaded' };
  }
  if (doc._holdsRecordSet()) {
    const tail = [...body.tail_ops].sort((a, b) => a.seq - b.seq);
    const tailSeqs = tail.map((entry) => entry.seq);
    if (encoding === 'frozen') {
      const held = doc._frozenSealSeq;
      const sameSeal =
        held === null || body.snapshot_seq === undefined || held === body.snapshot_seq;
      if (tail.length === 0 && sameSeal) return { kind: 'unchanged' };
      if (tail.length === 0 && !coversMoreThanSnapshot(body)) {
        const content = await decodeJoinContent(body.snapshot, fetchBody);
        if (
          content.kind === 'frozen' &&
          doc._replaceSealedContent(content.content, body.snapshot_seq ?? null)
        ) {
          return { kind: 'applied', content, tailSeqs };
        }
      }
      doc._reopen();
      return { kind: 'reloaded' };
    }
    const content = await decodeJoinContent(body.snapshot, fetchBody);
    await ensureWasmReady();
    const upgraded = doc._upgradeStorage(
      content.kind === 'crdt' ? content.bytes : null,
      tail.map((entry) => base64ToBytes(entry.op_blob_b64)),
    );
    if (!upgraded) {
      doc._reopen();
      return { kind: 'reloaded' };
    }
    return { kind: 'applied', content, tailSeqs };
  }
  // A line a reader holds as a CRDT and the server now stores frozen (a new
  // version of its file was imported over it) is taken as stored, in place.
  // An editable open asks as a writer and is never served frozen content.
  if (encoding === 'frozen') {
    if (
      doc._openMode !== 'edit' &&
      body.tail_ops.length === 0 &&
      !coversMoreThanSnapshot(body)
    ) {
      const content = await decodeJoinContent(body.snapshot, fetchBody);
      if (
        content.kind === 'frozen' &&
        doc._downgradeStorage(content.content, body.snapshot_seq ?? null)
      ) {
        openedImportSeq.delete(doc);
        return { kind: 'applied', content, tailSeqs: [] };
      }
    }
    doc._reopen();
    return { kind: 'reloaded' };
  }
  const content = await decodeJoinContent(body.snapshot, fetchBody);
  if (content.kind === 'crdt') doc._applySnapshot(content.bytes);
  const tail = [...body.tail_ops].sort((a, b) => a.seq - b.seq);
  for (const entry of tail) doc.applyRemoteOp(base64ToBytes(entry.op_blob_b64));
  return { kind: 'applied', content, tailSeqs: tail.map((entry) => entry.seq) };
}

async function materialise(
  body: DocumentSnapshotResponse,
  documentOptions?: DocumentOptions,
  onSnapshotProgress?: (loaded: number, total: number | null) => void,
  // A frozen copy of a document whose import has not landed yet starts as
  // empty frozen content sealed at nothing, so the reload that follows the
  // import asks for the content as stored and swaps it in place, where an
  // empty CRDT would ask the server to convert the line for it.
  { emptyAsFrozen = false }: { emptyAsFrozen?: boolean } = {},
): Promise<OpenedDocument> {
  const endFetch = perfStart('open: snapshot fetch + decode');
  const content = await decodeJoinContent(body.snapshot, (url) =>
    fetchPresignedSnapshot(url, onSnapshotProgress),
  );
  endFetch({ kind: content.kind });
  if (content.kind === 'none' && emptyAsFrozen && body.tail_ops.length === 0) {
    return Document.openFromSealedContent(SealedContent.fromJSON({}), {
      ...documentOptions,
      readOnly: true,
      readOnlyReason: documentOptions?.readOnlyReason ?? 'snapshot',
      docId: body.doc_id,
      branchId: body.branch_id,
      frozenSeal: NO_SEAL,
    }) as OpenedDocument;
  }
  // Frozen content is read with no CRDT engine: no engine is built and the
  // WASM is not waited on.
  //
  // It is served to a reader and never to a writer. Converting it to a CRDT
  // is the SERVER's, because the conversion's output depends on the paging
  // constants, the mutation batching budget and loro's encoding, and two
  // clients on different builds would produce documents that merge into each
  // other with no error and no agreement. The tail is empty for the same
  // reason: the conversion is what makes a branch writable, so the ops it
  // takes are authored after it and against the converted document.
  if (content.kind === 'frozen') {
    // Frozen content with state above it is a document the server should not
    // have been able to build, and the content alone is the document as it
    // stood before those ops. Refused rather than read, because nothing here
    // would say so.
    if (body.tail_ops.length > 0 || coversMoreThanSnapshot(body)) {
      throw new BrassError(
        'This could not be opened: its stored records do not ' +
          'account for every change made to it. Reopen it in a moment.',
        { status: 500 },
      );
    }
    return Document.openFromSealedContent(content.content, {
      ...documentOptions,
      // A property of the content, which holds no op log for an edit to be
      // written into.
      readOnly: true,
      readOnlyReason: documentOptions?.readOnlyReason ?? 'snapshot',
      docId: body.doc_id,
      branchId: body.branch_id,
      ...(body.snapshot_seq !== undefined ? { frozenSeal: body.snapshot_seq } : {}),
    }) as OpenedDocument;
  }
  // Constructing the document is the first thing in this package that runs the
  // WASM, and `Brass.init` only starts the fetch, so this is where it is
  // waited on. Usually it resolved during the auth round-trip and this costs
  // nothing.
  await ensureWasmReady();
  // Stamp the server-minted doc_id onto the Document (via DocumentOptions, so
  // it threads through the LoroDoc constructor without changing the static
  // factory signatures) so callers can read `doc.id` to correlate.
  const optionsWithId: DocumentOptions = {
    ...documentOptions,
    docId: body.doc_id,
    branchId: body.branch_id,
  };
  let doc: Document;
  if (content.kind === 'none') {
    doc = Document.create(optionsWithId);
  } else {
    const endImport = perfStart('open: loro import');
    doc = Document.openFromSnapshot(content.bytes, optionsWithId);
    endImport({ snapshotBytes: content.bytes.byteLength });
  }

  // Apply tail ops in seq order. The server delivers them sorted; we sort
  // defensively (Loro dedupes by lamport, so out-of-order is safe) rather
  // than let a misbehaving server produce divergent state.
  const endTail = perfStart('open: apply tail ops');
  const tail = [...body.tail_ops].sort((a, b) => a.seq - b.seq);
  for (const entry of tail) {
    doc.applyRemoteOp(base64ToBytes(entry.op_blob_b64));
  }
  endTail({ count: tail.length });
  recordImportSeq(doc, body.import_seq);

  // `doc.id` is non-null at runtime (stamped above); the cast closes the type
  // gap without weakening the class's `string | null` signature.
  return doc as OpenedDocument;
}

/** How many frozen opens run at once. */
export const FROZEN_OPEN_LANES = 8;

/** Runs at most `lanes` of the tasks handed to it at once, in the order given. */
export function createPacer(lanes: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return (task) =>
    new Promise((resolve, reject) => {
      const start = (): void => {
        running += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            waiting.shift()?.();
          });
      };
      if (running < lanes) start();
      else waiting.push(start);
    });
}

function frozenOptions(options: OpenDocumentByIdOptions): OpenDocumentByIdOptions {
  // Reading as data: a schema this app did not declare is read rather than
  // refused, since nothing written through this copy can misread it.
  return {
    ...options,
    acceptSchemaConflict: true,
    documentOptions: { ...options.documentOptions, readOnly: true },
  };
}

// A stream line opened for a frozen copy: the same reading as the copy
// itself, of the line its manifest names.
function frozenLineOptions(lineId: string): OpenDocumentByIdOptions {
  return {
    branch: lineId,
    frozen: true,
    acceptSchemaConflict: true,
    documentOptions: { readOnly: true },
  };
}

function importReportOf(parsed: DocumentSnapshotResponse): ImportReport | null {
  const report = (parsed as { import_report?: unknown }).import_report;
  return report !== null && typeof report === 'object' && Array.isArray((report as ImportReport).findings)
    ? (report as ImportReport)
    : null;
}

/**
 * Whether a frame on a document's topic says the document moved past the
 * point a frozen copy was taken at: a later op, work that locked the
 * document finishing (an import landing or failing), or the document going.
 */
export function frameMovesDocument(frame: unknown, takenAt: number): boolean {
  if (frame === null || typeof frame !== 'object') return false;
  const f = frame as {
    type?: unknown;
    seq?: unknown;
    current_seq?: unknown;
    reload?: unknown;
    status?: { pending?: unknown; blocking?: unknown };
  };
  switch (f.type) {
    // The server fans a `doc_op` out to every subscriber but the writer's
    // connection, so an edit made through another copy on this page's socket
    // reaches the topic only as that copy's `op_ack`.
    case 'doc_op':
    case 'op_ack':
      return typeof f.seq === 'number' && f.seq > takenAt;
    case 'doc_init':
    case 'doc_catch_up':
      return typeof f.current_seq === 'number' && f.current_seq > takenAt;
    case 'doc_status':
      // `reload` is work that replaced the content (an import landing); a
      // terminal status still blocking is work that failed.
      return (
        f.reload === true ||
        (f.status?.pending === false && f.status.blocking !== false)
      );
    case 'doc_gone':
      return true;
    default:
      return false;
  }
}

// The document's name as the join that opened it read it, so a copy opened by
// id carries it from its first frame as a session open does.
function setJoinedName(doc: Document, parsed: unknown): void {
  const name = (parsed as { name?: unknown }).name;
  if (typeof name === 'string') doc._setName(name);
}
