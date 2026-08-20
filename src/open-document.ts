// SDK `Brass.openDocumentById(id, options?)`: the editable join path.
//
// Cold-load contract: `Document.openFromSnapshot` must stay within 2x of
// raw Loro import at 50k entities, so the materialisation path adds no
// full-snapshot logging or deep cloning of decoded bytes.

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
  type ReadOnlyReason,
  type ResyncPushOutcome,
} from './documents.js';
import { createPresenceController } from './presence.js';
import type { WsTopicCallback } from './ws-client.js';
import { applyAppAssertionHeader, applyClientVersionHeader } from './api-headers.js';
import { brassErrorFromBody } from './api-fetch.js';
import { fetchWithRetry, RETRY_IDEMPOTENT_WRITE } from './fetch-retry.js';
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
import { joinCoverageFloor, snapshotSeqOf } from './join-coverage.js';
import { declaredTailBytes, resolveTailOps, type WireTailOp } from './tail-ops.js';
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
   * dialog, or for every open when the app passes
   * `openIncompatibleDocuments` at init.
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
   * SDK-internal load-progress sink. The session threads it through to
   * surface a progress state before the Document exists; apps read that via
   * `Brass.session`, never this.
   *
   * Both phases count BYTES, so a reader watching a load sees one figure
   * rather than two bars filling in turn. `phase` says which stretch is on
   * the wire, because the two are paced by different things and a document
   * can spend the whole of the first in what looks like silence: `tail` is
   * the spilled ops the join fetches, `snapshot` the snapshot itself, and
   * absent means `snapshot`.
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
  phase?: 'snapshot' | 'tail',
) => void;

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
  snapshot:
    | { kind: 'inline'; data_b64: string }
    | { kind: 'presigned'; url: string }
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
  snapshot:
    | { kind: 'inline'; data_b64: string }
    | { kind: 'presigned'; url: string }
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
}

export interface OpenDocumentFactoryOptions {
  appId: string;
  apiBaseUrl: string;
  getAccessToken: () => Promise<string | null>;
  // Forwarded as `X-Brass-App-Assertion` on the Brass-API fetches only; the
  // presigned snapshot downloads carry no Brass headers.
  getAppAssertion?: () => Promise<string | null>;
  // The shared WS client. When provided (production), the factory wires a
  // doc-topic subscription + local-op send hook so the Document is editable.
  // When absent (tests / snapshot reads), the local-op hook is inert: state
  // still mutates locally but nothing leaves the process.
  wsClient?: OpenDocumentWsClient;
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
  ) => Promise<unknown>;
  // Routes `doc.createCheckpoint(...)`. When absent (tests), it throws.
  checkpointCreator?: (
    doc: Document,
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
  // The organization this page was launched from (`?brass_org=`), read
  // through a getter because `init` resolves it after the factory's
  // options are written. See `createDocumentId`.
  launchOrganizationId?: () => string | null;
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
// `DocumentDriveStatus`. `canPush` is derived once here (unbroken, two-way,
// and ahead/diverged) so apps don't re-derive it.
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
    // `broken` gates the Publish affordance, so read it explicitly rather
    // than by truthiness: a frame that OMITS it (a future partial drive
    // update) must not be treated as unbroken and offered a push the server
    // would reject. Require an explicit `false` to enable, and an explicit
    // `true` to flag broken. Behaviour is unchanged for today's frames, which
    // always carry the boolean. Whether the file is written server-side or
    // from the app's own serializer is a REQUEST SHAPE the push path resolves
    // for itself, so it says nothing about whether this document can publish.
    canPush:
      wire.broken === false &&
      mirrorDirection === 'two_way' &&
      (state === 'ahead' || state === 'diverged'),
    label: wire.tracking_label,
    detail: wire.tracking_detail,
    broken: wire.broken === true,
    pushReplacesRemote: wire.push_replaces_remote,
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
      readOnly?: ReadOnlyReason;
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
  return 'A change could not be saved and will not be retried. Reload the document to continue.';
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
const READ_ONLY_REJECTION_REASONS = new Map<string, ReadOnlyReason>([
  ['role_denied', 'grant'],
  ['scope_denied', 'app'],
]);

function readOnlyReasonForRejection(
  frame: OpRejectedFrame,
): ReadOnlyReason | null {
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

// Uses `atob` (present in modern browsers, Node 20+, and jsdom) rather than
// Node-only `Buffer`, which would force a browser-bundle polyfill.
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
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

// Fold the join's write verdict into the Document options, so a reader the
// server will not accept writes from opens read-only instead of learning it
// from the first refused op. Only ever ADDS the restriction: a caller that
// asked for a read-only Document keeps it whatever the grant says.
function readOnlyForGrant(
  body: DocumentSnapshotResponse,
  options: DocumentOptions | undefined,
): DocumentOptions | undefined {
  if (body.can_edit !== false) return options;
  return { ...options, readOnly: true, readOnlyReason: 'grant' };
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

  async function fetchSnapshot(
    docId: string,
    options: OpenDocumentByIdOptions | undefined,
    token: string,
  ): Promise<{ status: number; parsed: unknown; parseFailed: boolean }> {
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
    const url = `${baseUrl}/documents/${encodeURIComponent(docId)}?${search.toString()}`;
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    applyClientVersionHeader(headers);
    await applyAppAssertionHeader(headers, opts.getAppAssertion);
    const endFetch = perfStart('open: GET /documents (http + read body)');
    // Idempotent read: ride out a transient 5xx / 429 instead of failing the
    // open on something that clears on its own.
    //
    // Longer than the default handful of attempts because of what a 503 means
    // on this route: the document is intact and its storage is busy. Every op
    // row a document has shares one partition, so the document most likely to
    // answer 503 is one that was just written hard, which is exactly the
    // moment a person reloads to see their work. That pressure clears over
    // tens of seconds, not the one second the default budget spans, and the
    // cost of giving up early is telling someone their document will not open
    // when waiting would have opened it.
    //
    // A thrown request gets a short budget of its own: it never reached the
    // API, so the busy partition is not what is wrong, and a blocked origin
    // or a host that does not resolve answers the seventh attempt as it
    // answered the first, with the reader watching a loading surface
    // throughout.
    const response = await fetchWithRetry(
      () =>
        fetch(url, {
          method: 'GET',
          headers,
        }),
      { maxAttempts: 7, baseDelayMs: 700, maxNetworkAttempts: 3 },
    );
    const text = await response.text();
    endFetch({ status: response.status, responseChars: text.length });
    let parsed: unknown = undefined;
    let parseFailed = false;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parseFailed = true;
      }
    }
    await resolveParsedTailOps(parsed, options?.onSnapshotProgress);
    return { status: response.status, parsed, parseFailed };
  }

  // `GET /documents/{docId}/at/{version}`: read-only materialization at a
  // historical version. Same auth + parse shape as `fetchSnapshot`.
  async function fetchAtVersion(
    docId: string,
    version: number,
    branch: string | undefined,
    token: string,
  ): Promise<{ status: number; parsed: unknown; parseFailed: boolean }> {
    const search = new URLSearchParams();
    if (branch !== undefined) search.set('branch', branch);
    const qs = search.toString();
    const url =
      `${baseUrl}/documents/${encodeURIComponent(docId)}` +
      `/at/${encodeURIComponent(String(version))}` +
      (qs ? `?${qs}` : '');
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    applyClientVersionHeader(headers);
    await applyAppAssertionHeader(headers, opts.getAppAssertion);
    const response = await fetch(url, {
      method: 'GET',
      headers,
    });
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
    await resolveParsedTailOps(parsed);
    return { status: response.status, parsed, parseFailed };
  }

  // The historical-materialise fetcher `doc._checkoutVersion(v)` calls back
  // to, shared by the default Document and each opened stream line (both
  // materialize a branch at a version through `GET .../at/{version}`). The
  // `stream_seqs` in the response (present only on a default/branch preview
  // that resolved a checkpoint, absent on a line's own preview) rides
  // through so the parent can preview every opened stream at the same point.
  function makeCheckoutFetcher(): (
    id: string,
    version: number,
    branchId: string,
  ) => Promise<{
    snapshotBytes: Uint8Array | null;
    tailOpBlobs: Uint8Array[];
    effectiveVersion: number;
    streamSeqs?: Record<string, number>;
  }> {
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
      let snapshotBytes: Uint8Array | null = null;
      const snap = result.parsed.snapshot;
      if (snap !== null) {
        if (snap.kind === 'inline') {
          snapshotBytes = base64ToBytes(snap.data_b64);
        } else if (snap.kind === 'presigned') {
          const snapResponse = await fetch(snap.url, { method: 'GET' });
          if (!snapResponse.ok) {
            throw new BrassError('Presigned snapshot fetch failed', {
              status: snapResponse.status,
            });
          }
          const buf = await snapResponse.arrayBuffer();
          snapshotBytes = new Uint8Array(buf);
        } else {
          // A delivery kind this build does not implement; refuse rather than
          // preview an empty version (same rationale as `materialise`).
          throw snapshotKindTooNewError();
        }
      }
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
        snapshotBytes,
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
  // names the actual refusal (too large for the durable row, a revoked
  // role); the status-shaped fallbacks cover a response that carries none.
  function opWriteFailureMessage(status: number, parsed: unknown): string {
    const serverMessage = (parsed as { error?: unknown } | undefined)?.error;
    if (typeof serverMessage === 'string' && serverMessage.length > 0) {
      return serverMessage;
    }
    if (status === 403) return 'You do not have permission to edit this document.';
    if (status === 404) return 'This document is no longer available.';
    return `This change could not be saved (${status}).`;
  }

  // Write one op over HTTP. The socket carries an op only up to API
  // Gateway's message cap; past it the message is not delivered and the
  // connection is closed, so `wireDocTransport` sends the large ones here.
  // Not retried on a transient failure: the caller holds the op in its
  // outstanding tracker and re-asserts it, and a blind replay would write a
  // second durable row for the same edit.
  // Mint a presigned PUT and upload the blob to it, returning the staging
  // key the op write names. The PUT carries no Brass headers: the URL is
  // signed, and an extra header falls outside that signature.
  async function stageOpBlob(
    docId: string,
    opBlobB64: string,
    token: string,
  ): Promise<string> {
    // Everything in here happens before the op write, so every failure it
    // can take is tagged as one: what the tag buys the writer is the right
    // to send the op again, which a failure of the write itself does not
    // carry.
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      };
      applyClientVersionHeader(headers);
      await applyAppAssertionHeader(headers, opts.getAppAssertion);
      const mint = await fetchWithDeadline(
        `${baseUrl}/documents/${encodeURIComponent(docId)}/ops/upload`,
        { method: 'POST', headers, body: '{}' },
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
  ): Promise<{ status: number; parsed: unknown }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    applyClientVersionHeader(headers);
    await applyAppAssertionHeader(headers, opts.getAppAssertion);
    // Past what a durable row holds, the blob goes to storage directly
    // and the write names the staged object, so a multi-megabyte op
    // never travels through a request body.
    let stagedKey: string | undefined;
    if (opBlobNeedsStaging(opBlobB64)) {
      stagedKey = await stageOpBlob(docId, opBlobB64, token);
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
  // A create that names no placement of its own inherits the organization
  // the page was launched from, so a member of several organizations who
  // opened this app from one of them is not asked to name a destination
  // they already chose. An explicit `siblingOf` / `destination` outranks it:
  // placing a document beside the open one is the more specific answer.
  const createDocumentId = async (
    args: CreateDocumentArgs,
  ): Promise<CreateDocumentResult> => {
    const launchOrganizationId =
      args.siblingOf === undefined && args.destination === undefined
        ? (opts.launchOrganizationId?.() ?? null)
        : null;
    if (launchOrganizationId === null) return postAndClassify(args);
    try {
      return await postAndClassify({
        ...args,
        destination: { organization_id: launchOrganizationId },
      });
    } catch (err) {
      // The launch organization is a hint carried on a URL, so it can name
      // an organization the person has since left, which the server answers
      // with a plain 404. Drop the hint and let the server resolve the
      // destination on its own, which routes a multi-organization caller to
      // the picker. A coded rejection (`app_not_installed`) belongs to the
      // caller's own consent flow and passes through untouched, as does the
      // 404 for an organization that exists but denies the app.
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
  ): Promise<Document> {
    const token = await requireToken();
    const { status, parsed, parseFailed } = await fetchSnapshot(
      docId,
      { branch: lineId },
      token,
    );
    if (status < 200 || status >= 300) {
      throw brassErrorFromBody(status, parseFailed ? undefined : parsed);
    }
    if (!isSnapshotResponse(parsed)) {
      throw new BrassError('Malformed document snapshot response', {
        status: 500,
      });
    }
    // A stream's write authority is the document's, so the line opens
    // read-only for the same reader the document opens read-only for.
    const doc = await materialise(parsed, readOnlyForGrant(parsed, undefined));
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
            const t = await requireToken();
            const res = await fetchSnapshot(docId, { branch: lineId }, t);
            if (res.status < 200 || res.status >= 300) continue;
            if (!isSnapshotResponse(res.parsed)) continue;
            const snap = res.parsed.snapshot;
            if (snap !== null) {
              const bytes =
                snap.kind === 'inline'
                  ? base64ToBytes(snap.data_b64)
                  : await fetchPresignedSnapshot(snap.url);
              doc._applySnapshot(bytes);
            }
            const seqs: number[] = [];
            for (const entry of res.parsed.tail_ops) {
              doc.applyRemoteOp(base64ToBytes(entry.op_blob_b64));
              if (entry.seq > currentSeq) currentSeq = entry.seq;
              seqs.push(entry.seq);
            }
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
      const token = await requireToken();
      const { status, parsed: opResult } = await postDocumentOp(
        docId,
        lineId,
        opBlobB64,
        clientOpId,
        token,
      );
      if (status < 200 || status >= 300) {
        return {
          ok: false,
          message: opWriteFailureMessage(status, opResult),
          retryable: opWriteIsRetryable(status),
          atCapacity: isCapacityRefusal(status, opResult),
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

    if (opts.wsClient) {
      wireDocTransport({
        doc,
        docId,
        branchId: lineId,
        wsClient: opts.wsClient,
        postOversizedOp,
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
      });
    }
    return doc;
  }

  async function finalise(
    docId: string,
    snapshot: { status: number; parsed: unknown; parseFailed: boolean },
    options: OpenDocumentByIdOptions | undefined,
  ): Promise<OpenedDocument> {
    const { status, parsed, parseFailed } = snapshot;
    if (status < 200 || status >= 300) {
      throw brassErrorFromBody(status, parseFailed ? undefined : parsed);
    }
    if (!isSnapshotResponse(parsed)) {
      throw new BrassError('Malformed document snapshot response', { status: 500 });
    }
    const doc = await materialise(
      parsed,
      readOnlyForGrant(parsed, options?.documentOptions),
      options?.onSnapshotProgress,
    );
    // Populate `doc.status` from the join before the first `doc_status` frame
    // (a stub opened mid-hydration returns `snapshot: null` + a `pending`
    // status).
    if (parsed.status !== undefined) doc._emitStatus(parsed.status);
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
      const token = await requireToken();
      // Refetch the branch this doc was opened on, not the default. `parsed`
      // is the opened-branch join, so its `branch_id` is authoritative;
      // dropping it would import the default branch's snapshot + tail into a
      // doc open on another branch and silently merge the wrong CRDT state.
      const result = await fetchSnapshot(docId, { branch: parsed.branch_id }, token);
      if (result.status < 200 || result.status >= 300) {
        endPerf({ ok: false, joinStatus: result.status });
        return { ok: false, reason: `join fetch returned ${result.status}` };
      }
      if (!isSnapshotResponse(result.parsed)) {
        endPerf({ ok: false, joinStatus: result.status });
        return { ok: false, reason: 'malformed join response' };
      }
      const snap = result.parsed.snapshot;
      let snapshotBytes: Uint8Array | null = null;
      if (snap !== null && snap.kind === 'inline') {
        snapshotBytes = base64ToBytes(snap.data_b64);
      } else if (snap !== null && snap.kind === 'presigned') {
        // Stream through the same progress sink the initial open uses, so the
        // session surfaces "Downloading... NN%" instead of sitting on the
        // last server phase.
        try {
          snapshotBytes = await fetchPresignedSnapshot(
            snap.url,
            options?.onSnapshotProgress,
          );
        } catch (err) {
          const status = err instanceof BrassError ? err.status ?? 0 : 0;
          endPerf({ ok: false, snapshotStatus: status });
          return {
            ok: false,
            reason:
              status > 0
                ? `presigned snapshot fetch returned ${status}`
                : `presigned snapshot fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      if (snapshotBytes) doc._applySnapshot(snapshotBytes);
      const sortedTail = [...result.parsed.tail_ops].sort(
        (a, b) => a.seq - b.seq,
      );
      let maxTailSeq = 0;
      for (const entry of sortedTail) {
        doc.applyRemoteOp(base64ToBytes(entry.op_blob_b64));
        if (entry.seq > currentSeq) currentSeq = entry.seq;
        if (entry.seq > maxTailSeq) maxTailSeq = entry.seq;
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
      const tailSeqs = sortedTail.map((entry) => entry.seq);
      // A snapshot only counts as a floor once its bytes are in: a shape this
      // pin does not decode leaves `snapshot_seq` describing content the doc
      // never received, and the tail alone is then what it holds.
      if (snapshotBytes !== null || result.parsed.snapshot === null) {
        raiseCoverage(
          joinCoverageFloor(
            snapshotSeqOf(result.parsed.snapshot_seq, tailSeqs, fetchedSeq),
            tailSeqs,
          ),
        );
      }
      for (const seq of tailSeqs) advanceCoverage(seq);
      endPerf({
        ok: true,
        snapshotBytes: snapshotBytes?.byteLength ?? 0,
        tailOps: sortedTail.length,
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
      const token = await requireToken();
      // Same-branch as `refetchAndImport`: the durability handshake must diff
      // against the opened branch's frontier, not the default branch's.
      const result = await fetchSnapshot(docId, { branch: parsed.branch_id }, token);
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

    // Evidence the document moved on the server after a give-up: one more
    // pull, which on success imports the content and releases the lock the
    // failed terminal status left in place.
    const retryContentPull = (): void => {
      if (!retryPullOnNextFrame) return;
      retryPullOnNextFrame = false;
      reloadAfterHydration(WORK_READY_STATUS);
    };

    // Reconcile a pending open once the live subscription exists. The
    // terminal `doc_status` frame is best-effort: if hydration finishes
    // before this client's subscription record exists, the fan-out finds no subscriber
    // and drops the frame, stranding the app on the pending overlay. `doc_init`
    // is posted only after the subscription record is written, so one re-fetch here
    // closes the gap for a completion that landed before the row existed.
    // Only a pending open pays the extra fetch.
    const reconcileStatusOnInit = (): void => {
      const current = doc.status;
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
      const token = await requireToken();
      const { status, parsed: opResult } = await postDocumentOp(
        docId,
        parsed.branch_id,
        opBlobB64,
        clientOpId,
        token,
      );
      if (status < 200 || status >= 300) {
        return {
          ok: false,
          message: opWriteFailureMessage(status, opResult),
          retryable: opWriteIsRetryable(status),
          atCapacity: isCapacityRefusal(status, opResult),
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

    if (opts.wsClient) {
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
        wsClient: opts.wsClient,
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
        onDocumentMoved: retryContentPull,
      });
    }
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
      doc.setThumbnailUploader(async (image, width, height) => {
        await uploader(doc, image, width, height);
      });
    }
    doc._setThumbnailVersion(parsed.thumbnail?.version ?? null);
    if (opts.checkpointCreator) {
      const creator = opts.checkpointCreator;
      doc.setCheckpointCreator(() => creator(doc));
    }
    if (opts.drivePusher) {
      const pusher = opts.drivePusher;
      doc.setDrivePusher((input) => pusher(doc, input));
    }
    // `doc.resolveDrive()` opens the hosted resolution surface and, when it
    // mints a new mirror doc (take-source / keep-both), re-opens onto it via
    // the same `openSiblingDoc` path the `history` fork uses.
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
        openLine: (lineId) => openStreamLine(docId, lineId),
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
    if (opts.reportError) doc.setErrorReporter(opts.reportError);
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
    const { status, parsed, parseFailed } = await fetchAtVersion(
      docId,
      version,
      options.branch,
      token,
    );
    if (status < 200 || status >= 300) {
      throw brassErrorFromBody(status, parseFailed ? undefined : parsed);
    }
    if (!isAtVersionResponse(parsed)) {
      throw new BrassError('Malformed document at-version response', {
        status: 500,
      });
    }
    return materialise(
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
    branch: string | undefined,
  ): Promise<{ status: number; parsed: unknown; parseFailed: boolean }> {
    const search = new URLSearchParams();
    search.set('include', 'snapshot');
    if (branch !== undefined) search.set('branch', branch);
    const url = `${baseUrl}/links/${encodeURIComponent(token)}/view?${search.toString()}`;
    const response = await fetchWithRetry(() => fetch(url, { method: 'GET' }));
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
    // A tail op whose bytes spilled to storage arrives as a signed URL, and
    // a guest join carries them exactly as a signed-in one does. The URL
    // carries its own signature, so an anonymous reader fetches it with the
    // same call. Resolving here is what lets `materialise` see one shape.
    await resolveParsedTailOps(parsed);
    return { status: response.status, parsed, parseFailed };
  }

  // `GET /links/{token}/streams`: the anonymous stream manifest, the guest
  // counterpart of the signed-in streams list. No Authorization header (the
  // token is the credential). Returns the manifest entries the guest's
  // `doc.stream(name)` resolves against.
  async function fetchLinkStreamManifest(
    token: string,
  ): Promise<import('./documents-namespace.js').DocumentStreamInfo[]> {
    const url = `${baseUrl}/links/${encodeURIComponent(token)}/streams`;
    const response = await fetchWithRetry(() => fetch(url, { method: 'GET' }));
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

  const openByLink: OpenDocumentByLinkFn = async (token, options) => {
    const { status, parsed, parseFailed } = await fetchLinkView(
      token,
      options?.branch,
    );
    if (status < 200 || status >= 300) {
      throw brassErrorFromBody(status, parseFailed ? undefined : parsed);
    }
    const b = parsed as {
      doc_id?: unknown;
      branch_id?: unknown;
      snapshot?: unknown;
      tail_ops?: unknown;
      current_seq?: unknown;
      name?: unknown;
      link_role?: unknown;
      status?: unknown;
    };
    if (
      typeof b.doc_id !== 'string' ||
      typeof b.branch_id !== 'string' ||
      !Array.isArray(b.tail_ops)
    ) {
      throw new BrassError('Malformed link view response', { status: 500 });
    }
    // The link's grant decides read vs write. An `editor` link is anonymous
    // EDIT: a live Document (not read-only) whose local mutations ship over
    // the same token-authenticated socket, with the server admitting the
    // op-write because the guest's subscription record carries `role: editor`. A
    // `viewer` link (the default) is read-only: mutate throws and only
    // inbound frames apply.
    const canEdit = b.link_role === 'editor';
    const doc = await materialise(
      {
        doc_id: b.doc_id,
        branch_id: b.branch_id,
        snapshot: b.snapshot as DocumentSnapshotResponse['snapshot'],
        tail_ops: b.tail_ops as DocumentSnapshotResponse['tail_ops'],
      },
      { ...options?.documentOptions, readOnly: !canEdit },
      options?.onSnapshotProgress,
    );
    // The view carries the document's display name; set it so the guest
    // sees the title (the signed-in open gets this from `finalise`).
    if (typeof b.name === 'string') doc._setName(b.name);
    // A link opened while the platform is still preparing the document
    // carries the same opaque work status the signed-in join does, and the
    // guest's own topic delivers the phases after it. Seeded before the
    // transport so the app renders the wait rather than an empty document.
    const linkStatus = parseWorkStatus(b.status);
    if (linkStatus) doc._emitStatus(linkStatus);
    // An edit link's writes fail the same ways a member's do (a shed the
    // budget outlived, a link revoked mid-edit), and the app hears those
    // through the same channel it hears a member's, so the reporter is
    // wired here as `finalise` wires it for a signed-in open.
    if (opts.reportError) doc.setErrorReporter(opts.reportError);

    wireGuestTransport(doc, token, b.doc_id, b.branch_id, canEdit);

    // Streams: a guest resolves `doc.stream(name)` through the token
    // routes. `list` hits the anonymous manifest; `openLine` joins the
    // line read/write exactly like the default stream above, over the same
    // token-authenticated socket. `create` is refused (a guest cannot mint
    // a line). Absent when there is no WS client (a snapshot-only guest),
    // matching the default stream having no live transport there.
    doc.setStreamRuntime({
      list: () => fetchLinkStreamManifest(token),
      openLine: async (lineId) => {
        const view = await fetchLinkView(token, lineId);
        if (view.status < 200 || view.status >= 300) {
          throw brassErrorFromBody(
            view.status,
            view.parseFailed ? undefined : view.parsed,
          );
        }
        const lb = view.parsed as {
          doc_id?: unknown;
          branch_id?: unknown;
          snapshot?: unknown;
          tail_ops?: unknown;
        };
        if (
          typeof lb.doc_id !== 'string' ||
          typeof lb.branch_id !== 'string' ||
          !Array.isArray(lb.tail_ops)
        ) {
          throw new BrassError('Malformed link stream view response', {
            status: 500,
          });
        }
        const inner = await materialise(
          {
            doc_id: lb.doc_id,
            branch_id: lb.branch_id,
            snapshot: lb.snapshot as DocumentSnapshotResponse['snapshot'],
            tail_ops: lb.tail_ops as DocumentSnapshotResponse['tail_ops'],
          },
          { readOnly: !canEdit },
        );
        if (opts.reportError) inner.setErrorReporter(opts.reportError);
        wireGuestTransport(inner, token, lb.doc_id, lb.branch_id, canEdit);
        return inner;
      },
      create: () => {
        throw new BrassError('A shared-link guest cannot create streams.', {
          status: 403,
        });
      },
    });
    return doc;
  };

  // Write a guest's op over HTTP: `POST /links/{token}/ops`, the anonymous
  // counterpart of `POST /documents/{docId}/ops`. Sends NO Authorization
  // header (the token is the credential) and names the line the guest
  // opened, which is the branch its socket topic is scoped to.
  async function postLinkOp(
    token: string,
    lineId: string,
    opBlobB64: string,
    clientOpId: string,
  ): Promise<{ status: number; parsed: unknown }> {
    const response = await fetch(
      `${baseUrl}/links/${encodeURIComponent(token)}/ops`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op_blob: opBlobB64,
          branch_id: lineId,
          client_op_id: clientOpId,
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

  // Wire a guest Document (the default stream or a stream line) to the
  // token-authenticated socket. Inbound frames (`doc_init` / `doc_op`)
  // apply for both link kinds; an edit link ALSO wires the outbound path
  // (`op_ack` resolves the outstanding-op tracker, `setLocalOpHook` ships
  // each local commit). Best-effort on the read side (no resync / durability
  // handshake, which need a signed-in token); a guest that misses ops
  // re-opens. The WRITE side answers a refusal the way the signed-in
  // transport does, because a guest editor's edit is the same person's work
  // as a member's and the same two things can happen to it: a frame the
  // socket cannot carry takes the HTTP route, and a capacity shed is
  // re-asserted on the shared backoff and reported once the budget is out.
  // Patches `close` to detach, mirroring `wireDocTransport`, so `Document`
  // stays free of WS knowledge. A no-op with no WS client (a snapshot-only
  // guest).
  function wireGuestTransport(
    doc: Document,
    token: string,
    docId: string,
    lineId: string,
    canEdit: boolean,
  ): void {
    const wsClient = opts.wsClient;
    if (!wsClient) return;
    const topic = `doc:${docId}:${lineId}`;

    // Ops on the socket awaiting an answer, keyed by `client_op_id`. An
    // `unavailable` shed names no op, so re-asserting one needs the frames
    // in hand. Scoped to what the socket carried: an op that took the HTTP
    // write must never reach the socket, and that write re-asserts itself.
    const outstanding = new Map<string, OpFrame>();
    let shedRounds = 0;
    let shedTimer: ReturnType<typeof setTimeout> | null = null;

    function clearShedRecovery(): void {
      if (shedTimer !== null) {
        clearTimeout(shedTimer);
        shedTimer = null;
      }
      shedRounds = 0;
    }

    // Every outstanding op is dead: drop the tracker entries and tell the
    // Document, which stops counting them in `savingCount` and reports each
    // through the error channel the app reads. The ids are taken first
    // because `_failOutstandingOp` re-enters app code.
    function failAllOutstanding(message: string): void {
      const clientOpIds = [...outstanding.keys()];
      outstanding.clear();
      for (const clientOpId of clientOpIds) {
        doc._failOutstandingOp(clientOpId, message);
      }
    }

    // Put every op still awaiting an answer back on the wire. The client
    // DROPS an op frame it cannot send right now rather than buffering one
    // (`ownsFrameRetry` below), so this is the only thing that carries a
    // shed or reconnect-orphaned op across the window, and it is also what
    // keeps a frame from being written twice: a copy the client held would
    // flush on the `subscribed` ack while this re-asserts on the `doc_init`
    // behind it, and the server allocates a fresh seq per send.
    const resendAllOutstanding = (): void => {
      for (const frame of outstanding.values()) wsClient.send(frame);
    };

    const onServerUnavailable = (): void => {
      if (outstanding.size === 0) return;
      if (shedTimer !== null) return;
      shedRounds += 1;
      if (shedRounds > UNAVAILABLE_MAX_ROUNDS) {
        clearShedRecovery();
        failAllOutstanding(UNAVAILABLE_GIVE_UP_MESSAGE);
        return;
      }
      shedTimer = setTimeout(() => {
        shedTimer = null;
        resendAllOutstanding();
      }, unavailableDelayMs(shedRounds));
      (shedTimer as { unref?: () => void }).unref?.();
    };

    const unsub = wsClient.subscribe(
      topic,
      (frame) => {
        const init = parseDocInitFrame(frame);
        if (init) {
          for (const entry of init.tail_ops) {
            if (entry.op_blob_b64 === undefined) continue;
            doc.applyRemoteOp(base64ToBytes(entry.op_blob_b64));
          }
          // `doc_init` follows every `subscribed` ack, so this is the point
          // the topic can carry frames again. A fresh connection also returns
          // the shed budget to full: this re-assert is the round a pending
          // one would have run.
          clearShedRecovery();
          resendAllOutstanding();
          return;
        }
        if (isDocOpFrame(frame)) {
          doc.applyRemoteOp(base64ToBytes(frame.op_blob));
        } else if (isDocGoneFrame(frame)) {
          // The server fans `doc_gone` to EVERY subscriber on the branched
          // content topic, guest-link connections included, on a soft-delete /
          // move of the opened doc.
          // Without this branch the guest keeps showing removed content and
          // `doc.onGone(...)` never fires; for an edit link the next local op
          // would ship onto the evicted subscription record and bounce as a misleading
          // `forbidden`. Drop the shed recovery first so nothing re-asserts an
          // op onto an evicted subscription record, then mark the doc gone (mapping the
          // reason like the signed-in transport).
          clearShedRecovery();
          outstanding.clear();
          doc._markGone(goneReasonOf(frame));
        } else if (isDocStatusFrame(frame)) {
          // A guest can open a document whose inbound work is still running,
          // and hydration writes a SNAPSHOT rather than ops, so nothing on the
          // op stream would ever fill the view in. Same split as the signed-in
          // transport: the `reload` hint pulls the content and emits the
          // terminal status after the import, and anything else renders.
          const status = normalizeWorkStatus(frame.status);
          if (frame.reload) pullGuestContent(doc, token, lineId, status);
          else doc._emitStatus(status);
        } else if (isDocMetaFrame(frame)) {
          // `_setName` de-dupes, so a re-emit of the current name is a no-op.
          doc._setName(frame.name);
        } else if (canEdit && isOpAckFrame(frame)) {
          outstanding.delete(frame.client_op_id);
          doc.resolveOutstandingOp(frame.client_op_id);
          // The server is durably accepting writes again, so the shed budget
          // starts over. A round already scheduled still runs: the ops it
          // re-asserts are the ones this ack did not cover.
          shedRounds = 0;
        } else if (canEdit && isServerUnavailableFrame(frame)) {
          onServerUnavailable();
        } else if (canEdit && isOpRejectedFrame(frame)) {
          // Terminal, not transient: stop re-asserting this op (retrying
          // would only draw the same rejection) and fail it on the Document
          // so "could not be saved" surfaces instead of a stuck saving count.
          // A refusal naming the writer (an edit link downgraded or revoked
          // while the guest had it open) turns the Document read-only, the
          // same way it does for a signed-in reader.
          outstanding.delete(frame.client_op_id);
          if (isCapacityRejection(frame)) doc._markAtCapacity();
          const readOnly = readOnlyReasonForRejection(frame);
          if (readOnly !== null) doc._markReadOnly(readOnly);
          doc._failOutstandingOp(frame.client_op_id, opRejectedMessage(frame));
        }
      },
      // The guest owns its outstanding ops: `resendAllOutstanding` on the
      // `doc_init` behind every `subscribed` ack IS this topic's
      // re-assertion, so the client drops an op frame it cannot send now
      // rather than buffering a second copy of it.
      { ownsFrameRetry: true },
    );

    // An op the socket cannot carry, written over HTTP on the same policy
    // the signed-in path runs: refuse locally what no write can hold, and
    // re-assert a capacity refusal on the shared backoff before reporting it.
    async function writeOversizedGuestOp(
      opBlobB64: string,
      clientOpId: string,
    ): Promise<void> {
      // Yield before any outcome resolves the op. The hook's caller records
      // the outstanding op AFTER the hook returns, and an async function body
      // runs synchronously up to its first await, so an exit taken inline
      // would find nothing tracked and leave the entry behind with
      // `savingCount` stuck above zero.
      await Promise.resolve();

      // Both sizes are known here, so refuse without spending a round trip
      // on a blob that can only come back 400.
      if (opBlobExceedsDurableLimit(opBlobB64)) {
        doc._failOutstandingOp(clientOpId, TOO_LARGE_MESSAGE);
        return;
      }
      if (opBlobNeedsStaging(opBlobB64)) {
        doc._failOutstandingOp(clientOpId, LINK_OP_TOO_LARGE_MESSAGE);
        return;
      }

      let status = 0;
      let parsed: unknown = undefined;
      for (let round = 0; round <= UNAVAILABLE_MAX_ROUNDS; round += 1) {
        if (round > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, unavailableDelayMs(round));
            (timer as { unref?: () => void }).unref?.();
          });
        }
        try {
          ({ status, parsed } = await postLinkOp(
            token,
            lineId,
            opBlobB64,
            clientOpId,
          ));
        } catch (err) {
          // A throw leaves it unknown whether the handler ran, and this op
          // carries no idempotency the server dedupes on, so replaying it
          // could double-apply.
          doc._failOutstandingOp(
            clientOpId,
            err instanceof Error ? err.message : String(err),
          );
          return;
        }
        if (status >= 200 && status < 300) break;
        if (!opWriteIsRetryable(status)) break;
      }
      if (status < 200 || status >= 300) {
        doc._failOutstandingOp(
          clientOpId,
          opWriteIsRetryable(status)
            ? UNAVAILABLE_GIVE_UP_MESSAGE
            : opWriteFailureMessage(status, parsed),
        );
        return;
      }
      doc.resolveOutstandingOp(clientOpId);
    }

    if (canEdit) {
      const minter = opts.newClientOpId ?? defaultClientOpIdMinter;
      doc.setLocalOpHook((opBlob) => {
        const clientOpId = minter();
        const opBlobB64 = bytesToBase64(opBlob);
        const sendFrame: OpFrame = {
          type: 'op',
          topic,
          op_blob: opBlobB64,
          client_op_id: clientOpId,
        };
        // A frame past the transport's cap is not delivered and takes the
        // connection down with it, so it must never reach the socket: a
        // guest's document, presence and every other op ride that one
        // connection. `mutate` batches to a budget well above what a frame
        // carries, so an ordinary bulk edit arrives here.
        if (opFrameExceedsWsLimit(sendFrame)) {
          void writeOversizedGuestOp(opBlobB64, clientOpId);
          return clientOpId;
        }
        outstanding.set(clientOpId, sendFrame);
        wsClient.send(sendFrame);
        return clientOpId;
      });
    }
    const originalClose = doc.close.bind(doc);
    (doc as Document & { close: () => void }).close = () => {
      clearShedRecovery();
      try {
        unsub();
      } catch {
        // Already detached; closing the Document is what matters.
      }
      originalClose();
    };
  }

  // Guest documents with a content pull running, so a repeated terminal frame
  // does not stack a second pull on one document.
  const guestPullInFlight = new WeakSet<Document>();

  function pullGuestContent(
    doc: Document,
    token: string,
    lineId: string,
    finalStatus: DocumentWorkStatus,
  ): void {
    if (guestPullInFlight.has(doc)) return;
    guestPullInFlight.add(doc);
    void (async () => {
      await pullContentWithRetry({
        doc,
        docId: doc.id ?? '',
        finalStatus,
        fetchAndImport: () => importLinkView(doc, token, lineId),
        ...(opts.reportError ? { reportError: opts.reportError } : {}),
      });
      guestPullInFlight.delete(doc);
    })();
  }

  // Re-read the link view and import it into the live guest Document: the
  // anonymous counterpart of the signed-in `refetchAndImport`, over the same
  // envelope. Named on the line the guest opened, which is the line its topic
  // is scoped to.
  async function importLinkView(
    doc: Document,
    token: string,
    lineId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await fetchLinkView(token, lineId);
    if (result.status < 200 || result.status >= 300) {
      return { ok: false, reason: `link view returned ${result.status}` };
    }
    const b = result.parsed as {
      snapshot?: unknown;
      tail_ops?: unknown;
    };
    if (!Array.isArray(b.tail_ops)) {
      return { ok: false, reason: 'malformed link view response' };
    }
    const snap = b.snapshot as DocumentSnapshotResponse['snapshot'];
    let snapshotBytes: Uint8Array | null = null;
    if (snap !== null && snap !== undefined && snap.kind === 'inline') {
      snapshotBytes = base64ToBytes(snap.data_b64);
    } else if (snap !== null && snap !== undefined && snap.kind === 'presigned') {
      try {
        snapshotBytes = await fetchPresignedSnapshot(snap.url);
      } catch (err) {
        const status = err instanceof BrassError ? err.status ?? 0 : 0;
        return {
          ok: false,
          reason:
            status > 0
              ? `presigned snapshot fetch returned ${status}`
              : `presigned snapshot fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (snapshotBytes) doc._applySnapshot(snapshotBytes);
    const tail = b.tail_ops as DocumentSnapshotResponse['tail_ops'];
    for (const entry of [...tail].sort((x, y) => x.seq - y.seq)) {
      doc.applyRemoteOp(base64ToBytes(entry.op_blob_b64));
    }
    return { ok: true };
  }

  // Strict open: a 404 propagates as `BrassError`. A `version` option
  // diverts to the read-only at-version path.
  const open: OpenDocumentByIdFn = async (docId, options) => {
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
    const snapshot = await fetchSnapshot(docId, options, token);
    const opened = await finalise(docId, snapshot, options);
    endTotal({ docId });
    return opened;
  };

  // Create a doc and return it fully editable. Two round trips (POST to
  // create + obtain the doc_id, then `open(docId)`); they aren't fused
  // because the create response is metadata-only and the open path already
  // handles the empty-snapshot case via `Document.create()`. This is the
  // low-level path (`Brass.createDocument`): the server places the doc in
  // the caller's single organization; a caller with none is routed to the
  // hosted acquire-organization surface and the create retries; a multi-org
  // caller rejects with a 409 (no hosted picker here, that is the session's
  // `create()`).
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

  return { open, create, createDocumentId, openByLink };
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
  if (options?.version !== undefined) return null;
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
  'help. Reload the document to continue from the last saved state.';

// Reported for every op left behind when the server ends this document's
// subscription (it refused the subscribe, or evicted it again after the one
// silent re-subscribe a connection grants). The ops can never be acked on a
// subscription that is over, and a fresh one arrives only with a fresh open,
// so the app's cue is to reload.
const SUBSCRIPTION_ENDED_MESSAGE =
  'The live connection to this document ended, so this change was not ' +
  'saved. Reload the document to continue from the last saved state.';

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

// What a guest hears for an op no request body can carry. A signed-in
// editor stages such an op to storage first; that route is behind the
// sign-in gate, so the anonymous tier writes ops that fit one request.
const LINK_OP_TOO_LARGE_MESSAGE =
  'This change is too large to save over a shared link. Sign in to the ' +
  'document to make a change this size.';

function wireDocTransport(args: WireDocTransportArgs): void {
  const topic = `doc:${args.docId}:${args.branchId}`;

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
      frame: { type: 'op'; topic: string; op_blob: string; client_op_id: string };
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
  // frame cap, so it heals the dependents even where the op itself is
  // irreducibly too large to re-send.
  //
  // `healable: false` is for the refusal where pushing again is asking the
  // same question. A full document refuses every op whatever its size, so
  // the handshake's own chunks come back refused, and the counter reset
  // below turns that into a loop rather than a bounded retry. What recovers
  // that document is the periodic re-verify, once the server can take a
  // write at all.
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
    args.doc.reload();
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
      pullJoin();
    }, delay);
    (gapTimer as { unref?: () => void }).unref?.();
  }

  // The server ended this subscription: it refused the subscribe (a revoked
  // grant), or evicted it again after the one silent re-subscribe a
  // connection grants. The client detaches this transport from the topic as
  // it reports that, so no ack, no fanout and no reconnect reaches it again.
  //
  // Everything the transport is waiting on is therefore dead. The ops it
  // holds can never be acked, and re-sending them puts frames on a
  // subscription the server has refused while `savingCount` climbs and the
  // app hears nothing, so they are failed here and every later edit fails
  // the same way: the app reads one actionable error per unsaved change and
  // its cue to reload, rather than a document that looks like it is saving
  // forever. The ids are taken before the reports because
  // `_failOutstandingOp` re-enters app code.
  let subscriptionEnded = false;
  function endSubscription(): void {
    if (subscriptionEnded) return;
    subscriptionEnded = true;
    const clientOpIds = [...outstandingResends.keys()];
    forgetAllOps();
    clearUnavailableRecovery();
    // The heal and the gap pull both work through this transport, so they
    // are stopped rather than armed: what they would push or fetch has no
    // subscription left to travel on.
    clearDivergenceHeal();
    if (reverifyTimer !== null) {
      clearInterval(reverifyTimer);
      reverifyTimer = null;
    }
    if (gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
    for (const clientOpId of clientOpIds) {
      args.doc._failOutstandingOp(clientOpId, SUBSCRIPTION_ENDED_MESSAGE);
    }
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
        // Recorded as the frame arrives rather than after the tail applies.
        // Importing a tail op can throw, and the client swallows it, so a
        // latch written further down would stay behind and read the NEXT
        // reconnect as the opening subscribe, suppressing the report this
        // exists to make.
        const reconnects = args.wsClient.reconnectCount ?? 0;
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
        args.doc.resolveOutstandingOp(frame.client_op_id);
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
          healable: !atCapacity,
          report: !atCapacity || firstCapacityRefusal,
        });
        return;
      }
      if (isDocGoneFrame(frame)) {
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
        args.doc._markGone(goneReasonOf(frame));
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
    // Nothing carries an op once the subscription is over, so it is failed
    // instead of tracked: an entry nothing can ack pins `savingCount` and
    // its resends reach a topic the server refused. The caller records the
    // entry AFTER this hook returns, so the failure waits a microtask for
    // there to be one to fail.
    //
    // Taken before the op is timed, because this path fails the op through
    // the Document directly rather than through `failOpTerminally`, so a
    // timing entry written here is one nothing ever drops.
    if (subscriptionEnded) {
      void Promise.resolve().then(() => {
        args.doc._failOutstandingOp(clientOpId, SUBSCRIPTION_ENDED_MESSAGE);
      });
      return clientOpId;
    }
    opStartedAt.set(clientOpId, Date.now());
    const opBlobB64 = bytesToBase64(opBlob);
    const sendFrame: {
      type: 'op';
      topic: string;
      op_blob: string;
      client_op_id: string;
    } = {
      type: 'op',
      topic,
      op_blob: opBlobB64,
      client_op_id: clientOpId,
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
    });
    dispatchOp(clientOpId);
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
      failOpTerminally(clientOpId, TOO_LARGE_MESSAGE);
      return;
    }

    if (!args.postOversizedOp) {
      failOpTerminally(clientOpId, TOO_LARGE_MESSAGE);
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
          healable: result.atCapacity !== true,
          report: result.atCapacity !== true || firstCapacityRefusal,
        },
      );
      return;
    }
    // Same bookkeeping an `op_ack` does: resolve the outstanding entry and
    // advance both cursors past the seq the server allocated.
    opStartedAt.delete(clientOpId);
    args.doc.resolveOutstandingOp(clientOpId);
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
      args.doc.status?.pending !== true &&
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
function snapshotKindTooNewError(): BrassError {
  return new BrassError(
    'This document needs a newer version of this app. Update to the latest @brass-build/client to open it.',
    { status: 426 },
  );
}

async function materialise(
  body: DocumentSnapshotResponse,
  documentOptions?: DocumentOptions,
  onSnapshotProgress?: (loaded: number, total: number | null) => void,
): Promise<OpenedDocument> {
  // Stamp the server-minted doc_id onto the Document (via DocumentOptions, so
  // it threads through the LoroDoc constructor without changing the static
  // factory signatures) so callers can read `doc.id` to correlate.
  const optionsWithId: DocumentOptions = {
    ...documentOptions,
    docId: body.doc_id,
    branchId: body.branch_id,
  };
  let doc: Document;
  const snap = body.snapshot;
  if (snap === null) {
    doc = Document.create(optionsWithId);
  } else if (snap.kind === 'inline') {
    const endDecode = perfStart('open: base64 decode (inline snapshot)');
    const bytes = base64ToBytes(snap.data_b64);
    endDecode({ base64Chars: snap.data_b64.length, snapshotBytes: bytes.byteLength });
    const endImport = perfStart('open: loro import (inline snapshot)');
    doc = Document.openFromSnapshot(bytes, optionsWithId);
    endImport({ snapshotBytes: bytes.byteLength });
  } else if (snap.kind === 'presigned') {
    const endPresigned = perfStart('open: presigned snapshot fetch');
    const bytes = await fetchPresignedSnapshot(snap.url, onSnapshotProgress);
    endPresigned({ snapshotBytes: bytes.byteLength });
    const endImport = perfStart('open: loro import (presigned snapshot)');
    doc = Document.openFromSnapshot(bytes, optionsWithId);
    endImport({ snapshotBytes: bytes.byteLength });
  } else {
    throw snapshotKindTooNewError();
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

  // `doc.id` is non-null at runtime (stamped above); the cast closes the type
  // gap without weakening the class's `string | null` signature.
  return doc as OpenedDocument;
}
