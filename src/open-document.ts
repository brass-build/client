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
  type DocumentDriveTrackingState,
  type DriveMirrorDirection,
  type HostedUiProvider,
} from './documents.js';
import { createPresenceController } from './presence.js';
import type { WsTopicCallback } from './ws-client.js';
import { applyAppAssertionHeader, applyClientVersionHeader } from './api-headers.js';
import { brassErrorFromBody } from './api-fetch.js';
import { fetchWithRetry, RETRY_IDEMPOTENT_WRITE } from './fetch-retry.js';
import { BrassError } from './errors.js';
import { perfStart } from './perf.js';
import { resolveTailOps, type WireTailOp } from './tail-ops.js';
import {
  opBlobExceedsDurableLimit,
  opFrameExceedsWsLimit,
  opBlobNeedsStaging,
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
   * SDK-internal snapshot-download progress sink (`total` is the decompressed
   * byte count from `x-amz-meta-raw-bytes`, or null). The session threads it
   * through to surface a "Downloading... NN%" state before the Document
   * exists; apps read that via `Brass.session`, never this.
   * @internal
   */
  onSnapshotProgress?: (loaded: number, total: number | null) => void;
}

// `Brass.createDocument(options?)` creates a new document and returns it
// fully editable. `projectId` creates inside a project; `organizationId`
// alone creates a loose doc in that org; both create a project-parented doc
// in an explicit org. With neither and one org, the SDK picks it; with
// multiple orgs it 409s. `name` defaults to "Untitled".
export interface CreateDocumentOptions {
  name?: string;
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
  // The branch's seq counter at join time. The consistent-read join means
  // snapshot + tail cover every op at or below it; the SDK seeds its
  // coverage cursor from it. Optional (older fixtures omit it).
  current_seq?: number;
  // Base64 version vector of the persisted snapshot (durability-handshake
  // ground truth). The handshake runs off the `doc_init` frame's copy; this
  // is carried for wire parallelism. Absent until the branch is compacted.
  snapshot_version_vector?: string;
  // Opaque status of slow server-side work (e.g. a drive stub hydrating on
  // first open, with `snapshot` then `null`). Surfaced on `doc.status`;
  // phases stream in via `doc_status` frames.
  status?: DocumentWorkStatus;
  // Drive provenance + tracking state, present only on drive-linked docs.
  // Seeds `doc.driveStatus`; live changes stream in via `doc_drive_status`.
  drive?: DocumentDriveSummaryWire;
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
  subscribe(topic: string, callback: WsTopicCallback): () => void;
  send(frame: unknown): void;
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

// Wire shapes on the `doc:` topic. Server schemas live in
// `infra/lambda/ws/default.ts`; frame names match exactly so the CONTRACT.md
// type tests stay synced.
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
async function resolveParsedTailOps(parsed: unknown): Promise<void> {
  if (typeof parsed !== 'object' || parsed === null) return;
  const body = parsed as { tail_ops?: unknown };
  if (!Array.isArray(body.tail_ops)) return;
  body.tail_ops = await resolveTailOps(body.tail_ops as WireTailOp[]);
}

// Post-subscribe server frame mirroring the HTTP join payload. Shape pinned
// in `infra/lib/document-snapshot.ts`; the SDK needs the tail_ops +
// current_seq to cover the join-vs-fanout race (see `wireDocTransport`).
interface DocInitTailOp {
  seq: number;
  // Absent when the op's blob spilled to storage. The server withholds
  // such a tail from this frame (see `isDocInitFrame`), so a reader that
  // finds one skips it and picks the op up on the HTTP re-import.
  op_blob_b64?: string;
  op_blob_url?: string;
}
interface DocInitFrame {
  type: 'doc_init';
  topic: string;
  tail_ops: DocInitTailOp[];
  current_seq: number;
  // Base64 version vector of the persisted snapshot, stamped at seal time.
  // Drives the durability handshake: fold the tail ops in for the durable
  // frontier and resync-push anything local holds beyond it. Absent on
  // never-compacted docs; the handshake is skipped (nothing to verify).
  snapshot_version_vector?: string;
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

// Server-pushed frame fired when the compaction worker's aged-orphan escape
// discards causally unapplyable ops. The prompt half of the durability
// handshake: the SDK re-checks durability against ground truth now rather
// than waiting for the author's next reconnect, and resync-pushes anything
// it holds. Best-effort and connected-only; the `doc_init` handshake is the
// correctness backstop. `dropped_seqs` / `actor` are informational (the
// handshake self-selects the author via the version-vector diff).
interface DocOpsDroppedFrame {
  type: 'doc_ops_dropped';
  topic: string;
  dropped_seqs: number[];
  actor: string;
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
    // always carry the boolean.
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

function isDocInitFrame(frame: unknown): frame is DocInitFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  if (f.type !== 'doc_init' || typeof f.topic !== 'string') return false;
  if (typeof f.current_seq !== 'number') return false;
  // `snapshot_version_vector` is an optional durability-handshake input, read
  // defensively at its use site. A present-but-non-string value (a future
  // server retyping it) is tolerated as absent rather than rejecting the whole
  // frame, which would silently break the reconnect / durability path.
  if (!Array.isArray(f.tail_ops)) return false;
  for (const entry of f.tail_ops) {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.seq !== 'number') return false;
    // A tail op is normally inline here: the server withholds a tail
    // carrying a signed URL from this frame, because fetching one needs
    // an await this reader does not have, and sends `current_seq` alone
    // so the client re-imports the join over HTTP instead. Tolerating
    // the shape anyway keeps such a frame's `current_seq` usable rather
    // than dropping the whole frame and with it the resync trigger.
    if (typeof e.op_blob_b64 !== 'string' && typeof e.op_blob_url !== 'string') {
      return false;
    }
  }
  return true;
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

function isDocMetaFrame(frame: unknown): frame is DocMetaFrame {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return (
    f.type === 'doc_meta' &&
    typeof f.topic === 'string' &&
    typeof f.name === 'string'
  );
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
  return (
    f.type === 'doc_ops_dropped' &&
    typeof f.topic === 'string' &&
    Array.isArray(f.dropped_seqs) &&
    typeof f.actor === 'string'
  );
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
    // Idempotent read: ride out a cold-API transient 5xx / 429 (a 503
    // while the API scales into a concurrent open burst is the common
    // one) instead of failing the open on a blip that clears in a second.
    const response = await fetchWithRetry(() =>
      fetch(url, {
        method: 'GET',
        headers,
      }),
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
    await resolveParsedTailOps(parsed);
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
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    applyClientVersionHeader(headers);
    await applyAppAssertionHeader(headers, opts.getAppAssertion);
    const mint = await fetch(
      `${baseUrl}/documents/${encodeURIComponent(docId)}/ops/upload`,
      { method: 'POST', headers, body: '{}' },
    );
    if (!mint.ok) {
      const text = await mint.text();
      let parsed: unknown = undefined;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      throw brassErrorFromBody(mint.status, parsed);
    }
    const body = (await mint.json()) as { upload_key?: unknown; url?: unknown };
    if (typeof body.upload_key !== 'string' || typeof body.url !== 'string') {
      throw new BrassError('Malformed op upload response', { status: 500 });
    }
    const endUpload = perfStart('op: PUT staged op blob');
    const put = await fetch(body.url, { method: 'PUT', body: opBlobB64 });
    endUpload({ status: put.status, opChars: opBlobB64.length });
    if (!put.ok) {
      throw new BrassError('Could not upload the update', { status: put.status });
    }
    return body.upload_key;
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
    const response = await fetch(
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
    );
    const text = await response.text();
    endFetch({ status: response.status, opChars: opBlobB64.length });
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
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
    const doc = await materialise(parsed);
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
    let coveredSeq =
      typeof parsed.current_seq === 'number' ? parsed.current_seq : 0;
    const coverageParked = new Set<number>();
    const advanceCoverage = (seq: number): void => {
      if (seq <= coveredSeq) return;
      coverageParked.add(seq);
      while (coverageParked.has(coveredSeq + 1)) {
        coverageParked.delete(coveredSeq + 1);
        coveredSeq += 1;
      }
    };
    for (const entry of parsed.tail_ops) advanceCoverage(entry.seq);

    // Reconnect-across-compaction recovery: re-import the line's join.
    // Loro imports are idempotent, so re-applying over live state is a
    // clean merge.
    const resyncFromSnapshot = (): void => {
      void (async () => {
        try {
          const t = await requireToken();
          const res = await fetchSnapshot(docId, { branch: lineId }, t);
          if (res.status < 200 || res.status >= 300) return;
          if (!isSnapshotResponse(res.parsed)) return;
          const snap = res.parsed.snapshot;
          if (snap !== null) {
            const bytes =
              snap.kind === 'inline'
                ? base64ToBytes(snap.data_b64)
                : await fetchPresignedSnapshot(snap.url);
            doc._applySnapshot(bytes);
          }
          for (const entry of res.parsed.tail_ops) {
            doc.applyRemoteOp(base64ToBytes(entry.op_blob_b64));
            if (entry.seq > currentSeq) currentSeq = entry.seq;
            advanceCoverage(entry.seq);
          }
          const joined = res.parsed.current_seq;
          if (typeof joined === 'number') {
            if (joined > currentSeq) currentSeq = joined;
            if (joined > coveredSeq) {
              coveredSeq = joined;
              for (const seq of coverageParked) {
                if (seq <= coveredSeq) coverageParked.delete(seq);
              }
            }
          }
        } catch {
          // Best-effort; the next doc_init retries.
        }
      })();
    };

    // Write an op the socket cannot carry. The op stays one commit and
    // one seq; only the transport differs, and the response carries the
    // seq an `op_ack` would have.
    const postOversizedOp = async (
      opBlobB64: string,
      clientOpId: string,
    ): Promise<{ ok: true; seq: number } | { ok: false; message: string }> => {
      const token = await requireToken();
      const { status, parsed: opResult } = await postDocumentOp(
        docId,
        lineId,
        opBlobB64,
        clientOpId,
        token,
      );
      if (status < 200 || status >= 300) {
        return { ok: false, message: opWriteFailureMessage(status, opResult) };
      }
      const seq = (opResult as { seq?: unknown } | undefined)?.seq;
      if (typeof seq !== 'number') {
        return { ok: false, message: 'The server did not report a version for this change.' };
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
      options?.documentOptions,
      options?.onSnapshotProgress,
    );
    // Populate `doc.status` from the join before the first `doc_status` frame
    // (a stub opened mid-hydration returns `snapshot: null` + a `pending`
    // status).
    if (parsed.status !== undefined) doc._emitStatus(parsed.status);
    // Seed `doc.driveStatus` from the join before the first
    // `doc_drive_status` frame.
    if (parsed.drive !== undefined) {
      doc._emitDriveStatus(toDriveStatus(parsed.drive));
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
    // arrival costs one idempotent re-fetch). Seeded from the consistent-read
    // join's `current_seq`.
    let coveredSeq =
      typeof parsed.current_seq === 'number' ? parsed.current_seq : 0;
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
    // Mark everything at or below `floor` covered (a full consistent join was
    // imported). Also steps the floor past any abandoned server-side seq
    // (allocated, never written) that `advanceCoverage` would stall under.
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
      // Raise both cursors so the floor reflects the import (this clears a
      // detected missed-compaction hole).
      const fetchedSeq =
        typeof result.parsed.current_seq === 'number'
          ? result.parsed.current_seq
          : maxTailSeq;
      if (fetchedSeq > currentSeq) currentSeq = fetchedSeq;
      raiseCoverage(fetchedSeq);
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

    let resyncInFlight = false;
    const resyncFromSnapshot = (): void => {
      if (resyncInFlight) return;
      resyncInFlight = true;
      void (async () => {
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
        } finally {
          resyncInFlight = false;
        }
      })();
    };

    // When a doc opened mid-load finishes, pull the now-available content
    // into the live doc so it appears without the app reopening. Only ever
    // called on the server's authoritative `reload` hint, so it never has to
    // tell success from failure: a failure carries no `reload`, so no racy
    // read and no loop against a failed hydration.
    //
    // A failed fetch here is transient (network, dropped presigned download)
    // and is retried with backoff: a silent give-up would strand the doc
    // empty-but-editable, reading as "the model never loaded" and invisible
    // in every log. On exhaustion the failure is reported and the terminal
    // status is an honest failure, not the server's success copy.
    let reloadInFlight = false;
    const RELOAD_ATTEMPTS = 5;
    const RELOAD_BACKOFF_MS = 1000;
    const reloadAfterHydration = (finalStatus: DocumentWorkStatus): void => {
      if (reloadInFlight) return;
      reloadInFlight = true;
      void (async () => {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= RELOAD_ATTEMPTS; attempt += 1) {
          try {
            const outcome = await refetchAndImport();
            if (outcome.ok) {
              reloadInFlight = false;
              // Emit the terminal status AFTER the import settles, so an app
              // re-reading on `onStatus` sees the content present and (with
              // `readOnly` now false) clears its loading overlay.
              doc._emitStatus(finalStatus);
              return;
            }
            lastError = new Error(outcome.reason);
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
          }
          // A retrying attempt is exceptional, so this warn is quiet in
          // normal operation and decisive in a bug report; without it a
          // failure here is undiagnosable from any log.
          console.warn(
            `[Brass] document content reload attempt ${attempt}/${RELOAD_ATTEMPTS} failed (doc ${docId}): ${lastError.message}`,
          );
          if (attempt < RELOAD_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, RELOAD_BACKOFF_MS * attempt));
          }
        }
        reloadInFlight = false;
        const error = new BrassError(
          `Document content reload failed after ${RELOAD_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
          { status: 0 },
        );
        if (opts.reportError) opts.reportError(error);
        else console.error('[Brass]', error);
        doc._emitStatus({
          message: 'The model could not be loaded. Reload to try again.',
          pending: false,
        });
      })();
    };

    // Reconcile a pending open once the live subscription exists. The
    // terminal `doc_status` frame is best-effort: if hydration finishes
    // before this client's SUB# row exists, the fan-out finds no subscriber
    // and drops the frame, stranding the app on the pending overlay. `doc_init`
    // is posted only after the SUB# row is written, so one re-fetch here
    // closes the gap for a completion that landed before the row existed.
    // Only a pending open pays the extra fetch.
    let reconcileInFlight = false;
    const reconcileStatusOnInit = (): void => {
      const current = doc.status;
      if (!current || !current.pending) return;
      if (reconcileInFlight || reloadInFlight) return;
      reconcileInFlight = true;
      void (async () => {
        try {
          const outcome = await refetchAndImport();
          if (!outcome.ok) return;
          // Still pending: leave the overlay up; subscribed now, so the live
          // fan-out delivers the terminal frame when the work finishes.
          if (outcome.status?.pending) return;
          // Terminal. A present status is a failure (server message,
          // pending:false); an absent status is success. On success retain
          // the last server message and flip pending so the overlay clears.
          doc._emitStatus(
            outcome.status ?? { message: current.message, pending: false },
          );
        } catch {
          // Best-effort; the live fan-out remains the primary path when
          // the work finishes after this subscribe.
        } finally {
          reconcileInFlight = false;
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
    ): Promise<{ ok: true; seq: number } | { ok: false; message: string }> => {
      const token = await requireToken();
      const { status, parsed: opResult } = await postDocumentOp(
        docId,
        parsed.branch_id,
        opBlobB64,
        clientOpId,
        token,
      );
      if (status < 200 || status >= 300) {
        return { ok: false, message: opWriteFailureMessage(status, opResult) };
      }
      const seq = (opResult as { seq?: unknown } | undefined)?.seq;
      if (typeof seq !== 'number') {
        return {
          ok: false,
          message: 'The server did not report a version for this change.',
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
    // op-write because the guest's SUB# row carries `role: editor`. A
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

    wireGuestTransport(doc, b.doc_id, b.branch_id, canEdit);

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
        wireGuestTransport(inner, lb.doc_id, lb.branch_id, canEdit);
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

  // Wire a guest Document (the default stream or a stream line) to the
  // token-authenticated socket. Inbound frames (`doc_init` / `doc_op`)
  // apply for both link kinds; an edit link ALSO wires the outbound path
  // (`op_ack` resolves the outstanding-op tracker, `setLocalOpHook` ships
  // each local commit as an `op` frame). Best-effort (no resync / durability
  // handshake, which need a signed-in token); a guest that misses ops
  // re-opens. Patches `close` to detach, mirroring `wireDocTransport`, so
  // `Document` stays free of WS knowledge. A no-op with no WS client (a
  // snapshot-only guest).
  function wireGuestTransport(
    doc: Document,
    docId: string,
    lineId: string,
    canEdit: boolean,
  ): void {
    const wsClient = opts.wsClient;
    if (!wsClient) return;
    const topic = `doc:${docId}:${lineId}`;
    const unsub = wsClient.subscribe(topic, (frame) => {
      if (isDocInitFrame(frame)) {
        for (const entry of frame.tail_ops) {
          if (entry.op_blob_b64 === undefined) continue;
          doc.applyRemoteOp(base64ToBytes(entry.op_blob_b64));
        }
      } else if (isDocOpFrame(frame)) {
        doc.applyRemoteOp(base64ToBytes(frame.op_blob));
      } else if (isDocGoneFrame(frame)) {
        // The server fans `doc_gone` to EVERY subscriber on the branched
        // content topic, guest-link connections included (`fanoutDocGone` /
        // `fanoutBranchGone`), on a soft-delete / move of the opened doc.
        // Without this branch the guest keeps showing removed content and
        // `doc.onGone(...)` never fires; for an edit link the next local op
        // would ship onto the evicted SUB# row and bounce as a misleading
        // `forbidden`. Mark the doc gone (mapping the reason like the
        // signed-in transport); the guest path has no resend / reverify
        // timers to drain.
        doc._markGone(goneReasonOf(frame));
      } else if (canEdit && isOpAckFrame(frame)) {
        doc.resolveOutstandingOp(frame.client_op_id);
      } else if (canEdit && isOpRejectedFrame(frame)) {
        // A guest edit the server terminally rejected. No resend tracker here
        // (guest transport is best-effort), so just fail the op on the doc so
        // "could not be saved" surfaces instead of a stuck saving count.
        doc._failOutstandingOp(frame.client_op_id, opRejectedMessage(frame));
      }
    });
    if (canEdit) {
      const minter = opts.newClientOpId ?? defaultClientOpIdMinter;
      doc.setLocalOpHook((opBlob) => {
        const clientOpId = minter();
        wsClient.send({
          type: 'op',
          topic,
          op_blob: bytesToBase64(opBlob),
          client_op_id: clientOpId,
        });
        return clientOpId;
      });
    }
    const originalClose = doc.close.bind(doc);
    (doc as Document & { close: () => void }).close = () => {
      try {
        unsub();
      } catch {
        // Already detached; closing the Document is what matters.
      }
      originalClose();
    };
  }

  // Strict open: a 404 propagates as `BrassError`. A `version` option
  // diverts to the read-only at-version path.
  const open: OpenDocumentByIdFn = async (docId, options) => {
    // Cache hit: return the parked Document. Its subscription stayed alive
    // while parked, and the UndoController + outstanding-op map survived, so
    // undo works as if the user never switched away.
    const parked = takeParkedDocument(docId, options);
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
  // coverage floor: ops missed while disconnected were compacted into the
  // snapshot and the tail cannot bridge the hole. Optional only for
  // transport-less paths.
  resyncFromSnapshot?: () => void;
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
  // server-allocated seq, or an error message the Document surfaces on the
  // op. Absent in transport-only tests, where an oversized op is failed
  // rather than rerouted.
  postOversizedOp?: (
    opBlobB64: string,
    clientOpId: string,
  ) => Promise<{ ok: true; seq: number } | { ok: false; message: string }>;
  // Invoked on a terminal `doc_status` frame: re-fetches once and, on
  // success, imports the now-available snapshot so content appears without
  // the app reopening; on failure leaves the status and does not loop.
  // Absent in transport-only tests.
  reloadAfterHydration?: (finalStatus: DocumentWorkStatus) => void;
  // Invoked on `doc_init`. Posted only after the SUB# row is written, so it
  // is the safe point to reconcile a pending open whose terminal
  // `doc_status` frame may have been dropped. Absent in transport-only tests.
  reconcileStatusOnInit?: () => void;
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

function parkDocument(entry: ParkedDocEntry): void {
  parkedDocs.set(entry.key, entry);
  // Map iteration is insertion order, so evicting the front entry is LRU
  // (a newly parked entry is the most-recent; a hit removes the entry
  // entirely, so there's no bump-on-hit).
  while (parkedDocs.size > PARK_CACHE_CAPACITY) {
    const oldestKey = parkedDocs.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = parkedDocs.get(oldestKey);
    parkedDocs.delete(oldestKey);
    try {
      oldest?.teardown();
    } catch {
      // Teardown errors must not strand the cache; the evicted Doc is gone
      // from the user's perspective either way.
    }
  }
}

function takeParkedDocument(
  docId: string,
  options: OpenDocumentByIdOptions | undefined,
): Document | null {
  if (options?.version !== undefined) return null;
  const key = parkCacheKey(docId, options?.branch, options?.stream);
  if (!key) return null;
  const entry = parkedDocs.get(key);
  if (!entry) return null;
  parkedDocs.delete(key);
  return entry.doc;
}

// Test-only: drop the parking cache. Used by unit tests that need
// a clean slate between cases.
export function _resetParkCacheForTesting(): void {
  for (const entry of parkedDocs.values()) {
    try {
      entry.teardown();
    } catch {
      // ignore
    }
  }
  parkedDocs.clear();
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

// A mutation carrying many records commits as it goes, so the only write
// that reaches this is one record nothing can split.
const TOO_LARGE_MESSAGE =
  'This record is too large to save. A single record must fit in one ' +
  'update; store the bulk of it as a file instead, or split it across ' +
  'several records.';

function wireDocTransport(args: WireDocTransportArgs): void {
  const topic = `doc:${args.docId}:${args.branchId}`;

  // Per-op retry tracker. The op-write endpoint sometimes returns
  // `{"message": "Internal server error"}` without reaching the handler
  // (burst input against a cold-started server giving up before scale-up).
  // That frame has no `type`, so the multiplexer drops it,
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
  const outstandingResends = new Map<
    string,
    {
      frame: { type: 'op'; topic: string; op_blob: string; client_op_id: string };
      attempts: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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
    if (seq > 0 && args.getCoveredSeq() < seq) args.resyncFromSnapshot?.();
  }

  // Backoff: 1.5s, ~1.6x per attempt, ceiling 30s. The ceiling keeps a doc
  // on a dead connection from hammering; the reconnect-driven resend below
  // fires the instant `doc_init` arrives, so the ceiling never delays
  // recovery past the next reconnect.
  const RESEND_BASE_DELAY_MS = 1500;
  const RESEND_MAX_DELAY_MS = 30_000;

  function resendDelayMs(attempts: number): number {
    const grown = RESEND_BASE_DELAY_MS * Math.pow(1.6, attempts - 1);
    return Math.min(grown, RESEND_MAX_DELAY_MS);
  }

  function scheduleResend(clientOpId: string): void {
    const entry = outstandingResends.get(clientOpId);
    if (!entry) return;
    entry.timer = setTimeout(() => {
      const current = outstandingResends.get(clientOpId);
      if (!current) return;
      current.attempts += 1;
      args.wsClient.send(current.frame);
      scheduleResend(clientOpId);
    }, resendDelayMs(entry.attempts));
  }

  // Resend every outstanding op now and restart its backoff. Called on
  // reconnect (`doc_init`): a dropped-and-restored connection is the most
  // common reason an op went unacked, and the backoff may have grown to its
  // ceiling while the socket was down, so re-asserting immediately is the
  // fast recovery path.
  function resendAllOutstanding(): void {
    for (const [clientOpId, entry] of outstandingResends) {
      clearTimeout(entry.timer);
      entry.attempts += 1;
      args.wsClient.send(entry.frame);
      scheduleResend(clientOpId);
    }
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
    args.doc.maybeResyncPush(
      base64ToBytes(snapshotVersionVectorB64),
      durableTailBlobs,
    );
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
  async function reverifyDurability(): Promise<void> {
    if (reverifyInFlight) {
      reverifyAgain = true;
      return;
    }
    reverifyInFlight = true;
    try {
      do {
        reverifyAgain = false;
        try {
          const frontier = await args.refetchDurableFrontier?.();
          if (frontier && frontier.snapshotVersionVector) {
            args.doc.maybeResyncPush(
              base64ToBytes(frontier.snapshotVersionVector),
              frontier.tailBlobs,
            );
          }
        } catch {
          // Best-effort: a failed re-fetch defers the check to the next tick
          // or reconnect's `doc_init` handshake. Swallowed so the timer's
          // fire-and-forget never surfaces an unhandled rejection and one
          // failed tick does not wedge the loop guard.
        }
      } while (reverifyAgain);
    } finally {
      reverifyInFlight = false;
    }
  }

  // A coverage floor below the highest seq seen records ops this client
  // applied nothing for, and the server posts each op once, so nothing
  // re-sends them. Pull the join instead, after a delay long enough for an
  // out-of-order arrival to close the hole itself.
  let gapTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleGapCheck(): void {
    if (gapTimer !== null) return;
    if (args.getCoveredSeq() >= args.getCurrentSeq()) return;
    gapTimer = setTimeout(() => {
      gapTimer = null;
      if (args.getCoveredSeq() >= args.getCurrentSeq()) return;
      args.resyncFromSnapshot?.();
    }, MISSED_OP_RESYNC_DELAY_MS);
    (gapTimer as { unref?: () => void }).unref?.();
  }

  // 1. Subscribe to the doc topic. Frame routing:
  //    - `doc_init`: bridge the join-vs-fanout race. Ops committed between
  //      the HTTP join (T0) and the WS subscribe (T1) miss the HTTP tail and
  //      can race the SUB# row so the first `doc_op` fanout may arrive BEFORE
  //      doc_init (separate server invocations, no wire ordering). tail_ops
  //      apply unconditionally: filtering on `seq > currentSeq` would mask
  //      tail_ops a racing `doc_op` inflated the cursor past, leaving lamport
  //      gaps Loro cannot converge across (re-applying is an idempotent
  //      no-op).
  //    - `doc_op`: apply, advance cursor.
  //    - `op_ack`: resolve the outstanding-op tracker, advance cursor, cancel
  //      that op's resend timer.
  //    - everything else: handled by `BrassWsClient`.
  const unsub = args.wsClient.subscribe(topic, (frame) => {
    if (isDocInitFrame(frame)) {
      // Resync check BEFORE applying. The tail covers (snapshot_seq,
      // current_seq]; if the coverage floor sits below the tail's lower edge
      // (or below current_seq when the tail is empty), ops in between were
      // compacted into the snapshot while disconnected and exist nowhere in
      // this tail or future fanout, so re-import the join's snapshot. The
      // initial subscribe never trips this (the floor was just seeded), so
      // the cost is paid only on a reconnect that crossed a compaction.
      const minTailSeq = frame.tail_ops.reduce<number | null>(
        (acc, entry) => (acc === null || entry.seq < acc ? entry.seq : acc),
        null,
      );
      const snapshotFloor =
        minTailSeq !== null ? minTailSeq - 1 : frame.current_seq;
      const needsResync = args.getCoveredSeq() < snapshotFloor;
      const tailBlobs: Uint8Array[] = [];
      for (const entry of frame.tail_ops) {
        // An op with no inline bytes is deliberately left uncovered: it
        // has not been applied, so marking it covered would retire the
        // very resync that fetches it.
        if (entry.op_blob_b64 === undefined) continue;
        const blob = base64ToBytes(entry.op_blob_b64);
        tailBlobs.push(blob);
        args.doc.applyRemoteOp(blob);
        if (entry.seq > args.getCurrentSeq()) args.setCurrentSeq(entry.seq);
        args.advanceCoveredSeq(entry.seq);
      }
      if (frame.current_seq > args.getCurrentSeq()) {
        args.setCurrentSeq(frame.current_seq);
      }
      if (needsResync) {
        if (httpOpWritesInFlight > 0) {
          if (frame.current_seq > heldCatchUpSeq) heldCatchUpSeq = frame.current_seq;
        } else {
          args.resyncFromSnapshot?.();
        }
      }
      // `doc_init` is the reconnect signal the retry-forever recovery hangs
      // off: re-assert every outstanding op and run the durability handshake
      // now, so a client holding work the server lost re-asserts it on
      // reconnect rather than waiting out the per-op backoff.
      resendAllOutstanding();
      // Tolerate a non-string vector (a future retyping) as absent: the
      // handshake is skipped, but the frame still delivers.
      maybeResyncPush(
        typeof frame.snapshot_version_vector === 'string'
          ? frame.snapshot_version_vector
          : undefined,
        tailBlobs,
      );
      // Posted after the SUB# row exists, so this is the safe point to
      // reconcile a pending open whose terminal status frame was dropped.
      args.reconcileStatusOnInit?.();
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
      return;
    }
    if (isOpAckFrame(frame)) {
      args.doc.resolveOutstandingOp(frame.client_op_id);
      args.setCurrentSeq(frame.seq);
      args.advanceCoveredSeq(frame.seq);
      // An ack for a local op sits above any remote op this client never
      // received, so the user's own next edit is a second chance to notice.
      scheduleGapCheck();
      const pending = outstandingResends.get(frame.client_op_id);
      if (pending) {
        clearTimeout(pending.timer);
        outstandingResends.delete(frame.client_op_id);
      }
      return;
    }
    if (isOpRejectedFrame(frame)) {
      // Terminal, not transient: cancel this op's resend (retrying would only
      // draw the same rejection forever and pin `savingCount`) and fail it on
      // the Document so the app hears "could not be saved" instead of a silent
      // wedge. Scoped to this one op; the topic subscription stays live.
      const pending = outstandingResends.get(frame.client_op_id);
      if (pending) {
        clearTimeout(pending.timer);
        outstandingResends.delete(frame.client_op_id);
      }
      args.doc._failOutstandingOp(frame.client_op_id, opRejectedMessage(frame));
      return;
    }
    if (isDocGoneFrame(frame)) {
      // Cancel every resend timer FIRST so a doc that was saving when delete
      // landed stops re-trying ops the server will only reject as `forbidden`
      // (the SUB# row was evicted at fanout). Draining before the `_markGone`
      // listeners keeps the lifecycle observably clean.
      for (const pending of outstandingResends.values()) {
        clearTimeout(pending.timer);
      }
      outstandingResends.clear();
      // Stop re-verifying durability against an evicted doc: a resync push
      // would only bounce as `forbidden`, and a gap pull would only 404.
      if (reverifyTimer !== null) {
        clearInterval(reverifyTimer);
        reverifyTimer = null;
      }
      if (gapTimer !== null) {
        clearTimeout(gapTimer);
        gapTimer = null;
      }
      args.doc._markGone(goneReasonOf(frame));
      return;
    }
    if (isDocStatusFrame(frame)) {
      // The validator gates only on `pending`; default `message` here so a
      // message-less status still carries a valid `DocumentWorkStatus`
      // (`message` is typed non-null and rendered verbatim).
      const status: DocumentWorkStatus = {
        ...frame.status,
        message:
          typeof frame.status.message === 'string' ? frame.status.message : '',
      };
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
    if (isDocOpsDroppedFrame(frame)) {
      // Prompt durability re-check: the discard sealed a new snapshot, so
      // re-fetch the moved frontier and run the handshake now instead of at
      // the author's next reconnect. The handshake self-selects: the author
      // finds local ahead and resync-pushes under a new seq, others no-op.
      // Covered by the `doc_init` handshake / periodic re-verify if missed.
      void reverifyDurability();
      return;
    }
    // Unknown frame: ignore, so server-side schema growth doesn't break older
    // SDK builds.
  });

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

    args.wsClient.send(sendFrame);
    outstandingResends.set(clientOpId, {
      frame: sendFrame,
      attempts: 1,
      // Placeholder, overwritten immediately below.
      timer: setTimeout(() => undefined, 0),
    });
    scheduleResend(clientOpId);
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
      args.doc._failOutstandingOp(clientOpId, TOO_LARGE_MESSAGE);
      return;
    }

    if (!args.postOversizedOp) {
      args.doc._failOutstandingOp(clientOpId, TOO_LARGE_MESSAGE);
      return;
    }
    let result: Awaited<ReturnType<NonNullable<WireDocTransportArgs['postOversizedOp']>>>;
    try {
      result = await args.postOversizedOp(opBlobB64, clientOpId);
    } catch (err) {
      result = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (!result.ok) {
      // Terminal for this op, the same way `op_rejected` is: the local
      // commit stays applied but never persists, so the app hears about it
      // instead of watching `savingCount` sit above zero forever.
      args.doc._failOutstandingOp(clientOpId, result.message);
      return;
    }
    // Same bookkeeping an `op_ack` does: resolve the outstanding entry and
    // advance both cursors past the seq the server allocated.
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
    if (gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
    for (const entry of outstandingResends.values()) {
      clearTimeout(entry.timer);
    }
    outstandingResends.clear();
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
    const cacheKey =
      args.doc.readOnly || args.parkable === false
        ? null
        : parkCacheKey(args.docId, args.requestedBranchId, args.requestedStream);
    if (cacheKey === null) {
      fullTeardown();
      return;
    }
    args.doc._suspend();
    parkDocument({ doc: args.doc, teardown: fullTeardown, key: cacheKey });
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
