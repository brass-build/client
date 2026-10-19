// `Brass.session`: the SDK-owned document session.
//
// The SDK owns the active-document lifecycle (open / create / pick / switch /
// version-preview / delete-reaction) and exposes a flat command list (New,
// Open, Version history, ..., plus app-registered commands); with a
// registered canvas it also auto-captures the thumbnail. The app renders the
// commands and draws from `session.document`. Every primitive the session
// calls stays public, so an app can ignore the session and wire them directly.

import type {
  CanvasSource,
  Command,
  CommandGroup,
  CommandSurface,
  Document,
  DocumentOptions,
  ReopenMode,
} from './documents.js';
import type {
  CreateDocumentArgs,
  CreateDocumentOptions,
  CreateDocumentResult,
  MintedAnonymousDocument,
  OpenDocumentByIdOptions,
  OpenedDocument,
} from './open-document.js';
import type { ReadOnlyDocument } from './read-only-document.js';
import { placeThroughHostedSurfaces } from './placement.js';
import type {
  CreateDestinationResult,
  DocumentHistoryResult,
  DocumentSettingsFocus,
  DocumentSettingsResult,
  SelectDocumentResult,
} from './hosted-ui.js';
import type { DocumentsNamespace } from './documents-namespace.js';
import type { UrlSelection } from './doc-url-sync.js';
import type { AuthStatus } from './types.js';
import { BrassError } from './errors.js';
import { makeLiveCommand } from './document-commands.js';
import { appCallbackError } from './subscriber-delivery.js';

// A command in `session.commands`. The SDK owns each command's `run` /
// `enabled` / `running` plus a `surface` placement hint; the app places each
// into its own chrome. The session concatenates its orphan commands ('new' /
// 'open') with the active doc's commands.
export type {
  CanvasSource,
  Command,
  CommandGroup,
  CommandSurface,
} from './documents.js';

// Coarse lifecycle state: 'unknown' (auth not yet determined), 'signed-out',
// 'empty' (signed in, no document), 'loading' (open in flight), 'ready',
// 'error' (a user-initiated open terminally failed with nothing to fall back
// to, or `Brass.init` rejected its configuration). 'unknown' is distinct from 'signed-out' so a status-gated app renders a
// neutral state during boot instead of flashing the sign-in surface at a user
// who turns out to be signed in. 'error' is distinct from 'empty' so a
// document the user navigated to but cannot open (deleted, or an access the
// server collapses to 404 to avoid disclosing existence) renders as an honest
// failure rather than the app's document-less home surface.
export type SessionStatus =
  | 'unknown'
  | 'signed-out'
  | 'empty'
  | 'loading'
  | 'ready'
  | 'error';

export interface SessionOpenOptions {
  // Open a specific branch instead of the document's default.
  branch?: string;
  // Open a historical version read-only (`document.readOnly` is true).
  version?: number;
  /** Open this document read-only (`true`) or for editing (`false`), whatever
   *  the mode set at `Brass.init` (`open: { readOnly }`). Unset, that mode
   *  decides. */
  readOnly?: boolean;
  // Forwarded to the Document materialization (e.g. the undo merge
  // interval). Matches `documentOptions` on `OpenDocumentByIdOptions` /
  // `CreateDocumentOptions`.
  documentOptions?: DocumentOptions;
}

// The document session. Reached via `Brass.session`; a process-wide singleton.
export interface DocumentSession {
  // The active document, or null when none is open.
  readonly document: Document | null;
  // The active document's display name, or null when none / not yet resolved.
  readonly documentName: string | null;
  // Coarse lifecycle state (see `SessionStatus`).
  readonly status: SessionStatus;
  // The failure behind `status === 'error'`, else null. Set when a
  // user-initiated open (the URL's `?doc=` on boot, `open()`, `pick()`, a
  // Back / Forward to a doc) terminally fails with no document to fall back
  // to, so a status-gated app can render the failure instead of its empty
  // state. `.message` is server-authored, non-disclosing copy meant to be
  // rendered verbatim (the server collapses a no-access document to a `404`
  // indistinguishable from a genuinely missing one, so the platform can
  // evolve the wording without any app change); an app supplies its own
  // recovery affordances around it and does not author the copy. `.status`
  // is there for logging or an override the app absolutely needs. Cleared on
  // the next open / create / close. Also set, with no `status`, when
  // `Brass.init` rejected its configuration (a missing app id).
  readonly error: BrassError | null;
  // While `status` is `'loading'`, a progress message for the open in flight
  // (e.g. `Downloading... 62%`), or null. Populated as a presigned snapshot
  // streams in BEFORE the Document exists, so an app shows download progress
  // while `document` is still null. (Once bound, `doc.status` carries
  // server-side work progress.)
  readonly loadingMessage: string | null;
  // The open's progress as 0..1 when a total is known, else null. Pairs with
  // `loadingMessage`.
  readonly loadingProgress: number | null;
  // The commands to render. SDK-owned; re-read on every notification.
  readonly commands: readonly Command[];
  // The active document's presence client, or null. A live proxy for
  // `document?.presence` at session scope so pointer / camera / selection
  // handlers publish without threading a doc reference; reads the active doc
  // at call time, so it works across switches. Null on a read-only doc, a doc
  // opened without `wsBaseUrl`, and when none is open.
  readonly presence: import('./presence.js').PresenceClient | null;
  // Subscribe to lifecycle + command-state changes. Fires immediately, then on
  // every change to `document` / `status` / `commands`. Does NOT fire on every
  // document mutation; subscribe to the `Document` for that.
  subscribe(listener: (session: DocumentSession) => void): () => void;
  // Restore on boot: open the document named by the URL (or last picked) if
  // any, else the empty state. Safe before sign-in (resolves null). Also runs
  // automatically on first sign-in.
  start(): Promise<Document | null>;
  // With no id, open the hosted picker and make the picked document active;
  // null on dismiss. Signed out, ask for a file instead and open the document
  // made from it with no account, as `create` does for an empty one.
  open(): Promise<Document | null>;
  // Open a document by id and make it active.
  open(docId: string, options: SessionOpenOptions & { readOnly: true }): Promise<ReadOnlyDocument>;
  open(docId: string, options?: SessionOpenOptions): Promise<Document>;
  // Create a document and make it active. Create-in-place: with no explicit
  // destination it lands as a sibling of the active one. A cold create (no
  // active doc) in a single-org caller lands loose; a multi-org caller is
  // asked via the hosted destination dialog, resolving null on dismiss.
  create(options?: CreateDocumentOptions): Promise<Document | null>;
  /** @deprecated Use `open()` with no id. */
  pick(): Promise<Document | null>;
  // Close the active document and return to the empty state.
  close(): void;
  // Invoke a command by id (e.g. `Ctrl-Z` -> `session.run('undo')`). No-op for
  // an unknown id.
  run(commandId: string): Promise<void>;
  // Register the app's canvas so the SDK auto-captures the thumbnail:
  // debounced after each local edit, skipped for read-only docs and remote
  // edits. Returns an unregister function.
  useCanvas(canvas: CanvasSource): () => void;
  // Resolves with the bound `OpenedDocument` once `status` is `ready`
  // (immediately if already bound). Rejects only on terminal failure (closed
  // or signed out before a document bound); never hangs. Removes the
  // hand-rolled "wait for binding" race every session-backed app would write.
  whenReady(): Promise<OpenedDocument>;
  // Default `documentOptions` applied to every doc the session opens whose
  // caller did not pass its own; caller values win per-field, the default
  // fills gaps. Set once at boot for app-wide knobs (e.g.
  // `{ undo: { maxUndoSteps: 500 } }`).
  setDefaultDocumentOptions(options: DocumentOptions | null): void;
  /** @internal The configured defaults, read by `withDefaults` through the
   *  singleton. */
  readonly _defaultDocumentOptions: DocumentOptions | null;
  /** @internal Record that the local user is deleting `docId` through the
   *  hosted share dialog, so the incoming `doc_gone` is treated as a local
   *  delete (return to the empty state) rather than a remote eviction. Called
   *  by the client when the hosted delete surface signals over the bridge. */
  _noteLocalDelete(docId: string): void;
  /** @internal Retract a note recorded by `_noteLocalDelete` when the hosted
   *  delete request failed, so a later remote delete of the same doc is not
   *  misread as local. */
  _clearLocalDelete(docId: string): void;
  /** @internal Open what the hosted history and branch surfaces switch to
   *  from the bound document, in the mode that document was opened in. */
  _openSibling(docId: string, options?: SessionOpenOptions): Promise<Document>;
}

// Dependency seam. The session is a pure coordinator over the public SDK
// surface; injecting these keeps it unit-testable and breaks the import cycle.
export type ClaimedLinkTarget = { docId: string } | 'sign-in' | null;

// Thrown through a guest open whose link leads its claimant to sign in: the
// open ends with no document and no error, on the signed-out surface.
class SignInToFollowLink extends Error {}

export interface DocumentSessionDeps {
  isSignedIn(): boolean;
  // The tri-state auth lifecycle, so `status()` reports `'unknown'` during
  // boot rather than conflating "not checked yet" with `'signed-out'`.
  authStatus(): AuthStatus;
  onUserChange(listener: (signedIn: boolean) => void): () => void;
  // `consent: 'skip'` suppresses the install-consent dialog the client
  // offers on an `app_not_installed` denial. Background opens (boot
  // restore, history navigation) pass it: a dialog nobody asked for must
  // not pop over the app. Explicit opens (picker result, `open()`) leave
  // the default so the person gets the consent moment.
  openDocumentById(
    docId: string,
    options?: OpenDocumentByIdOptions,
    consent?: 'offer' | 'skip',
  ): Promise<OpenedDocument>;
  // Create-only (no open). The session drives the reactive picker / acquire
  // dance itself so those surfaces open over the empty state, then opens the
  // returned id. Placement is expressed by context (a `siblingOf` doc, the
  // picker's opaque `destination`), never an org the session names.
  createDocumentId(args: CreateDocumentArgs): Promise<CreateDocumentResult>;
  selectDocument(): Promise<SelectDocumentResult | null>;
  // The hosted destination dialog for an ambiguous cold create. Resolves an
  // opaque destination + name; the session relays the destination to the
  // create verbatim.
  selectCreateDestination(options?: {
    name?: string;
  }): Promise<CreateDestinationResult | null>;
  // The hosted acquire-organization surface, opened for a cold create by a
  // caller who belongs to no organization yet.
  acquireOrganization(): Promise<{ organization_id: string } | null>;
  documentHistory(
    docId: string,
    options?: { branch?: string },
  ): Promise<DocumentHistoryResult | null>;
  documentSettings(
    docId: string,
    options?: { focus?: DocumentSettingsFocus },
  ): Promise<DocumentSettingsResult | null>;
  // Active-selection URL sync (no-op when the app opted out of
  // `syncDocToUrl`). `readUrlSelection` returns the URL's doc + branch on boot
  // / `popstate`; `writeUrlSelection` pins or pushes; `clearUrlSelection`
  // drops; `onUrlPopState` subscribes to Back / Forward.
  readUrlSelection(): UrlSelection | null;
  // Read and consume the hosted picker's one-shot pick from the URL (the
  // redirect fallback's return channel), or null on an ordinary boot. Runs
  // regardless of `syncDocToUrl`, so a picked document opens even when the
  // app manages its own selection.
  takePickSelection(): UrlSelection | null;
  writeUrlSelection(
    selection: UrlSelection,
    options: { push: boolean },
  ): void;
  clearUrlSelection(): void;
  onUrlPopState(listener: () => void): () => void;
  // Set the page title to the active document's name, or null to restore the
  // original title (no-op when opted out of `syncDocToTitle`). The client
  // suffixes it with the app name (`Doc · App`).
  setPageTitle(name: string | null): void;
  lastSelectedDocument(): SelectDocumentResult | null;
  documents: Pick<DocumentsNamespace, 'get' | 'setThumbnail'>;
  reportError(error: Error): void;
  // The configuration failure that stopped `Brass.init`, or null. Nothing can
  // sign in or open while it holds, so it is the session's error.
  initFailure?(): BrassError | null;
  // Anonymous "anyone with the link" boot. When the page was opened via a
  // public-link token (`?brass_link=`), `guestLinkToken` returns it and the
  // session boots by opening that document read-only through
  // `openDocumentByLink` instead of the signed-in URL / last-selected
  // restore. Absent (returns null) in the ordinary signed-in case.
  guestLinkToken?(): string | null;
  // Whether the app set `open: { readOnly: true }` at init, which opens every
  // document the session opens (other than one it creates) read-only.
  openReadOnly?(): boolean;
  openDocumentByLink?(
    token: string,
    options?: OpenDocumentByIdOptions,
  ): Promise<OpenedDocument>;
  // A create while signed out mints a document with no account
  // (`POST /anonymous-documents`); `enterGuestMode` then makes its link
  // token the page's credential (`guestLinkToken` returns it, the URL
  // carries it) so the session opens it through `openDocumentByLink`.
  mintAnonymousDocument?(args: {
    name?: string;
  }): Promise<MintedAnonymousDocument>;
  // A pick while signed out asks for a file instead (`chooseAnonymousFile`,
  // the browser's dialog filtered to what the app can start from; null on
  // dismiss) and mints the document from it.
  chooseAnonymousFile?(): Promise<File | null>;
  mintAnonymousDocumentFromFile?(args: {
    file: File;
    onUploadProgress?: (loaded: number, total: number) => void;
  }): Promise<MintedAnonymousDocument>;
  enterGuestMode?(token: string): void;
  // Whether the app may be used without an account, read once the page is
  // signed out: the refusal the server answers for an app that is not
  // public, or null. New and Open are offered until it answers.
  signedOutUseRefusal?(): Promise<BrassError | null>;
  // Whether this app offers New: false when its published manifest says
  // `"access": { "create": false }`.
  appOffersNew?(): Promise<boolean>;
  // The last document created without an account on this app, as the
  // client stashed it when a guest open resolved one (`readUnsavedWork`):
  // null once expired or cleared. `clearUnsavedWork` forgets it after the
  // link is refused for good, and `leaveGuestMode` takes the token back
  // out of the page's credential and URL after such a refusal, so the
  // session reports signed out again rather than a guest with nothing open.
  unsavedWork?(): { token: string; expiresAt: Date } | null;
  clearUnsavedWork?(): void;
  leaveGuestMode?(): void;
  // A link the platform refused with 410 may be one this person's own claim
  // revoked. `followClaimedLink` takes the page out of guest mode for the
  // account that claimed it, signed in, and resolves the document's id; in the
  // browser that claimed it with no session, signed out and `'sign-in'`; and
  // null for anyone else, leaving the page the guest it was.
  followClaimedLink?(token: string): Promise<ClaimedLinkTarget>;
  // New and Upload ask before replacing a document made without an account
  // that this browser has edited (`markTrialEdited` records an edit,
  // `trialEdited` reads it back across reloads). `confirmReplaceTrial` asks,
  // and its `'sign-in'` answer starts `signIn`, which keeps the document by
  // claiming it into the account.
  markTrialEdited?(token: string, expiresAt: Date): void;
  trialEdited?(token: string): boolean;
  confirmReplaceTrial?(expiresAt: Date): Promise<'sign-in' | 'leave' | 'cancel'>;
  signIn?(): void;
}

// Built-in orphan command labels (no active doc needed). Sentence case, ASCII
// ellipsis, per the copy-style rules. Both stay bare: an app's own word for
// what it holds is rarely "document" (a sketch, a model, a sheet), so a
// label naming it would read wrong in most of the apps this menu mounts in.
const SESSION_LABELS = {
  new: 'New',
  open: 'Open...',
  // Without an account there is nothing to browse, so Open takes a file from
  // the reader's own machine.
  upload: 'Upload...',
} as const;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// Fallback copy for a failed open with no server message to render (a
// network drop, no HTTP response). The HTTP case carries the server's own
// message instead, so the platform evolves the wording without an app change.
const OPEN_FAILED_MESSAGE = 'This could not be opened';
// The session holds a live copy, so a frozen one is opened beside it.
const FROZEN_IN_SESSION =
  'The session holds a live copy of its document. Open a frozen copy with Brass.openDocumentById';
const PREPARING_MESSAGE = 'Preparing for editing...';

// Copy parked on `session.error` when the open document is evicted remotely
// (a `doc_gone` the local user did not initiate). Matches the wording a
// post-eviction op frame degrades to ("this is no longer available"),
// so a delete observed live and a fresh visit to the same deleted id read the
// same. A reload re-opens the id, hits the server 404, and swaps in the
// server-authored copy.
const DOCUMENT_GONE_MESSAGE = 'This is no longer available';

// The error parked on `session.error` for a failed open, shaped so its
// `.message` is always presentable copy an app can render verbatim. An HTTP
// failure is returned as-is: its `.message` is the server's (non-disclosing,
// server-authored) copy, which is the whole point of rendering it verbatim.
// A non-HTTP failure has no server copy, so it falls back to a generic
// display string rather than leaking a raw `TypeError: Failed to fetch`.
function toDisplayError(err: unknown): BrassError {
  if (err instanceof BrassError && typeof err.status === 'number' && err.status > 0) {
    return err;
  }
  const status = err instanceof BrassError ? err.status ?? 0 : 0;
  return new BrassError(OPEN_FAILED_MESSAGE, { status });
}

// How a bound selection reflects in the URL. 'push' records a navigation
// (back-navigable entry), 'replace' pins without an entry (boot restore,
// failed-open rebind), 'skip' leaves the URL alone (Back / Forward restore,
// already at the target).
type UrlNav = 'push' | 'replace' | 'skip';

export function createDocumentSession(
  deps: DocumentSessionDeps,
): DocumentSession {
  let document: Document | null = null;
  let documentName: string | null = null;
  let loading = false;
  // Progress for an open in flight (a presigned snapshot streaming in),
  // surfaced via `session.loadingMessage` / `loadingProgress` while
  // `status` is 'loading' and before the Document exists.
  let loadingMessage: string | null = null;
  let loadingProgress: number | null = null;
  // Bumped on every open / create / close so a slower in-flight open
  // cannot clobber a newer one (last call wins).
  let openGeneration = 0;
  // The failure that put the session in the 'error' state, or null. A new
  // open attempt clears it (at the generation bump in `activate`), so it only
  // survives while no newer open supersedes the one that failed.
  let openError: BrassError | null = null;
  // Dedups concurrent `start()` calls (an app's explicit boot call
  // racing the auto-start the sign-in handler fires).
  let startPromise: Promise<Document | null> | null = null;
  // Signature of the last broadcast state; a notification is sent only when it
  // changes, so a per-commit `doc.subscribe` that doesn't move a command's
  // enabled state stays quiet.
  let lastSignature: string | null = null;
  // Counts the documents bound, so a new copy of the same id (a reopen for
  // editing, a reload) changes the signature and reaches subscribers.
  let bindCount = 0;
  // Outstanding `whenReady()` promises, settled in `emit()`: resolve once a
  // document binds, reject if the user signs out before one ever does.
  const whenReadyPending: Array<{
    resolve: (document: OpenedDocument) => void;
    reject: (error: Error) => void;
  }> = [];

  const listeners = new Set<(session: DocumentSession) => void>();
  // Per-built-in `running` flag for orphan commands.
  const orphanRunning = new Map<string, boolean>();
  let canvas: CanvasSource | null = null;
  // Per-doc useCanvas registration the session armed (so the session
  // can detach it when the active doc swaps or useCanvas is cleared).
  let sessionCanvasUnregister: (() => void) | null = null;
  let defaultDocumentOptions: DocumentOptions | null = null;
  // The branch the active open explicitly asked for, or null. Decides the URL
  // branch: the default branch (no-branch-specified) is never pinned, so
  // `?branch=` appears only for a chosen branch. `defaultBranchId` then
  // refines it (a specified branch that turns out to be the default is
  // dropped once known).
  let activeSpecifiedBranch: string | null = null;

  // Subscriptions onto the active document, dropped when it changes.
  let docUnsub: (() => void) | null = null;
  let goneUnsub: (() => void) | null = null;

  // Doc ids the local user is deleting through the hosted share dialog. The
  // dialog signals over the SDK bridge BEFORE its delete request goes out, so
  // an id lands here ahead of the server's `doc_gone` frame (fanned out before
  // the delete's 204). A `doc_gone` for an id in this set is the user's own
  // delete: return to the empty state and clear the URL. Any other `doc_gone`
  // is a remote eviction: keep the URL and park the 'error' surface. A failed
  // delete retracts its id, so a later remote delete of the same doc is not
  // misread as local.
  const localDeletes = new Set<string>();

  // Set for the length of an open started without an account (see `status`).
  let accountFreeOpen = false;

  // Documents the session opened read-only by request, as opposed to ones a
  // reader's access made read-only. A reopen of one (a move, a reload) keeps
  // that mode.
  const readOnlyOpens = new WeakSet<Document>();

  // The read intent of one open: the caller's ask where it made one, else the
  // mode the app set at init.
  function inMode<T extends OpenDocumentByIdOptions>(
    options: T,
    asked: boolean | undefined,
  ): T {
    const readOnly = asked ?? (deps.openReadOnly?.() === true ? true : undefined);
    return readOnly === undefined ? options : { ...options, readOnly };
  }

  // Opens that asked to read, keyed by the open's own promise, so `activate`
  // records the document it binds from one in `readOnlyOpens`.
  const readOnlyAsks = new WeakSet<Promise<OpenedDocument>>();

  function remember(
    opened: Promise<OpenedDocument>,
    options: OpenDocumentByIdOptions,
  ): Promise<OpenedDocument> {
    if (options.readOnly ?? options.documentOptions?.readOnly === true) {
      readOnlyAsks.add(opened);
    }
    return opened;
  }

  function openById(
    docId: string,
    options: OpenDocumentByIdOptions,
    consent?: 'offer' | 'skip',
  ): Promise<OpenedDocument> {
    const opened =
      consent === undefined
        ? deps.openDocumentById(docId, options)
        : deps.openDocumentById(docId, options, consent);
    return remember(opened, options);
  }

  function openByLink(
    openGuest: NonNullable<DocumentSessionDeps['openDocumentByLink']>,
    token: string,
    options: OpenDocumentByIdOptions,
  ): Promise<OpenedDocument> {
    return remember(openGuest(token, options), options);
  }

  function status(): SessionStatus {
    // 'unknown' before auth settles; the onUserChange handler re-fires
    // (start() / emit()) and flips this to its resolved value.
    if (deps.authStatus() === 'unknown') return 'unknown';
    if (deps.initFailure?.()) return 'error';
    // A guest (opened via `?brass_link=`) is not signed in but still has a
    // read-only document to load, so it never reports 'signed-out' (which
    // would render the app's sign-in surface instead of the document).
    const isGuest = deps.guestLinkToken?.() != null;
    // An open started without an account loads before there is a link to be
    // a guest on (a pick sends its file first), and the visitor is watching
    // that load, not the sign-in surface.
    if (!deps.isSignedIn() && !isGuest && !(loading && accountFreeOpen)) {
      return 'signed-out';
    }
    if (loading) return 'loading';
    if (document) return 'ready';
    if (openError) return 'error';
    return 'empty';
  }

  function commandSig(c: Command): string {
    let s = `${c.id}:${c.enabled ? 1 : 0}:${c.running ? 1 : 0}:${c.label}`;
    if (c.selected) s += ':S';
    if (c.children) s += `:[${c.children.map(commandSig).join(',')}]`;
    return s;
  }

  function signature(): string {
    const cmds = allCommands().map(commandSig).join(',');
    // `loadingMessage` is in the signature so a download-progress tick
    // re-fires subscribers; it is null outside an in-flight open.
    const load = loading ? `${loadingMessage ?? ''}:${loadingProgress ?? ''}` : '';
    // `openError` message joins the signature so a switch from one failed open
    // to a different one (same 'error' status, no bound doc) still re-fires.
    const shown = openError ?? deps.initFailure?.() ?? null;
    const err = shown ? `${shown.status ?? ''}:${shown.message}` : '';
    // The previewed version and the browsing flag are their own terms because
    // nothing else in this signature follows them: a preview -> preview step
    // holds the id, the name, the status and every command's enabled state
    // (edit affordances are already disabled by the first checkout), so
    // without these the step is a silent emit and the chrome rendering the
    // preview keeps showing the version the reader stepped away from.
    const ver = `${document?.previewVersion ?? ''}:${document?.versionBrowsing ? 1 : 0}`;
    // The expiry moves once, to null, when the document is claimed; the
    // chrome naming it has to hear that.
    const expiry = document?.expiresAt?.getTime() ?? '';
    return `${status()}|${bindCount}|${document?.id ?? ''}|${documentName ?? ''}|${load}|${err}|${ver}|${expiry}|${cmds}`;
  }

  // A listener that throws usually leaves the app showing nothing, so the
  // app's `onError` hears about it as well as the console.
  function reportListenerThrow(err: unknown): void {
    console.error('[Brass] session listener threw:', err);
    deps.reportError(appCallbackError(err));
  }

  function emit(): void {
    const sig = signature();
    if (sig === lastSignature) return;
    lastSignature = sig;
    // Settle pending `whenReady()` promises BEFORE notifying, so an app whose
    // subscribe handler awaits whenReady sees it already resolved by the time
    // its listener runs.
    settleWhenReady();
    // Copied before the walk, so a listener that detaches another still
    // leaves it this fire: an entry removed from a `Set` before its turn is
    // never visited.
    for (const listener of Array.from(listeners)) {
      try {
        listener(session);
      } catch (err) {
        // A throwing listener must not strand the others.
        reportListenerThrow(err);
      }
    }
  }

  function settleWhenReady(): void {
    if (whenReadyPending.length === 0) return;
    const current = status();
    if (current === 'ready' && document) {
      const doc = document as OpenedDocument;
      const pending = whenReadyPending.splice(0, whenReadyPending.length);
      for (const { resolve } of pending) resolve(doc);
    } else if (current === 'signed-out') {
      const error = new Error(
        'Brass.session.whenReady: signed out before a document was bound.',
      );
      const pending = whenReadyPending.splice(0, whenReadyPending.length);
      for (const { reject } of pending) reject(error);
    } else if (current === 'error' && session.error) {
      // A user-initiated open failed terminally, or init could not start;
      // reject rather than hang the awaiter forever. Same error object the
      // session surfaces on `.error`.
      const failure = session.error;
      const pending = whenReadyPending.splice(0, whenReadyPending.length);
      for (const { reject } of pending) reject(failure);
    }
    // No branch for 'empty': it is both the idle pre-open state (an awaiter
    // legitimately waits for a future open) and the post-close state. A close
    // that must reject its awaiters does so explicitly via
    // `rejectWhenReadyPending`, so we do not blanket-reject on 'empty' here.
  }

  // Reject every outstanding `whenReady()` awaiter. Used by `close()`, whose
  // 'empty' target has no `settleWhenReady` branch: an open in flight when the
  // app closes never binds, so without this the promise hangs forever,
  // violating the documented "never hangs" contract.
  function rejectWhenReadyPending(message: string): void {
    if (whenReadyPending.length === 0) return;
    const error = new Error(message);
    const pending = whenReadyPending.splice(0, whenReadyPending.length);
    for (const { reject } of pending) reject(error);
  }

  // Build a session-level (orphan) command. Same shape as Document's
  // built-ins but runs against session state directly ('new' / 'open' need no
  // active doc), with a session `emit` on each running flip.
  function buildOrphanCommand(
    id: string,
    label: string | (() => string),
    group: CommandGroup,
    surface: CommandSurface,
    isEnabled: () => boolean,
    impl: () => Promise<void> | void,
  ): Command {
    return makeLiveCommand(
      { id, label, group, surface, isEnabled, impl },
      {
        running: orphanRunning,
        onError: (err) => deps.reportError(toError(err)),
        notify: emit,
      },
    );
  }

  // New and Open start a document without an account where the app can mint
  // one, so a visitor's own buttons and the menu run the same commands.
  // A failed init leaves the page signed out with nothing either command
  // could reach, so neither is offered.
  const withoutAccount = (): boolean => {
    if (deps.initFailure?.()) return false;
    const status = deps.authStatus();
    return status === 'signed-out' || status === 'guest';
  };
  // The server refuses every account-free route for an app that does not
  // offer signed-out use, so New and Open are withdrawn once it says so
  // rather than offered only to show that refusal. Read lazily, from the
  // first check made while signed out, and settled for the page.
  let signedOutRefusal: BrassError | null = null;
  let signedOutProbe: Promise<void> | null = null;
  const refusedWithoutAccount = (): boolean => {
    if (signedOutProbe === null && deps.signedOutUseRefusal) {
      const read = deps.signedOutUseRefusal;
      signedOutProbe = (async () => {
        try {
          signedOutRefusal = await read();
        } catch {
          signedOutRefusal = null;
        }
        if (signedOutRefusal !== null) emit();
      })();
    }
    return signedOutRefusal !== null;
  };
  const canStartWithoutAccount = (): boolean =>
    withoutAccount() &&
    !refusedWithoutAccount() &&
    deps.mintAnonymousDocument !== undefined &&
    deps.enterGuestMode !== undefined &&
    deps.openDocumentByLink !== undefined;
  const canPickWithoutAccount = (): boolean =>
    canStartWithoutAccount() &&
    deps.chooseAnonymousFile !== undefined &&
    deps.mintAnonymousDocumentFromFile !== undefined;

  // An app that creates no documents offers no New. Read lazily, from the
  // first check, and settled for the page; until it answers, New is offered.
  let offersNew = true;
  let offersNewProbe: Promise<void> | null = null;
  const appOffersNew = (): boolean => {
    if (offersNewProbe === null && deps.appOffersNew) {
      const read = deps.appOffersNew;
      offersNewProbe = (async () => {
        try {
          offersNew = await read();
        } catch {
          offersNew = true;
        }
        if (!offersNew) emit();
      })();
    }
    return offersNew;
  };

  const cmdNew = buildOrphanCommand(
    'new',
    SESSION_LABELS.new,
    'session',
    'menu',
    () => appOffersNew() && (deps.isSignedIn() || canStartWithoutAccount()),
    async () => {
      await create();
    },
  );
  const cmdOpen = buildOrphanCommand(
    'open',
    () => (withoutAccount() ? SESSION_LABELS.upload : SESSION_LABELS.open),
    'session',
    'menu',
    () => deps.isSignedIn() || canPickWithoutAccount(),
    async () => {
      await pick();
    },
  );

  const orphanCommands: readonly Command[] = [cmdNew, cmdOpen];

  // Concatenate orphan commands with the active doc's commands (whose
  // instances carry their own `running` state; the session re-emits on the
  // doc's `'commands'` synthetic event).
  function allCommands(): Command[] {
    const list: Command[] = [...orphanCommands];
    if (document) {
      for (const cmd of document.commands) list.push(cmd);
    }
    return list;
  }

  // Swap the active document. Closes the previous one (so its WS subscription
  // does not leak), drops the per-doc subscriptions, and attaches fresh ones:
  // `doc.subscribe` so undo/redo enabled state tracks the live stack, and
  // `doc.onGone` so a server-side delete tears the session down.
  function setDocument(
    next: Document | null,
    name: string | null,
    urlNav: UrlNav = 'skip',
  ): void {
    if (docUnsub) {
      docUnsub();
      docUnsub = null;
    }
    if (goneUnsub) {
      goneUnsub();
      goneUnsub = null;
    }
    // Detach the previous doc's session-armed useCanvas; re-armed on `next`
    // below if a session-level canvas is still registered.
    if (sessionCanvasUnregister) {
      sessionCanvasUnregister();
      sessionCanvasUnregister = null;
    }
    const previous = document;
    if (next !== previous) bindCount += 1;
    document = next;
    documentName = name;
    if (next === null) {
      activeSpecifiedBranch = null;
    }
    if (previous && previous !== next) {
      try {
        previous.close();
      } catch {
        // A close failure (already-closed, freed WASM) is non-fatal.
      }
    }
    if (next && next !== previous) {
      // `reopen` on the bound copy goes through the session, so the new copy
      // binds in its place. A copy the session no longer holds reopens the
      // way the layer that opened it would.
      const outside = next._reopenerFn;
      next._setReopener((mode) =>
        document === next
          ? reopenBound(next, mode)
          : outside !== null
            ? outside(mode)
            : Promise.reject(new BrassError('This document cannot be reopened', { status: 0 })),
      );
    }
    if (next) {
      // `subscribe` fires on every change including local mutations (the
      // session's listeners drive UI that re-renders on local edits). The
      // doc's `'commands'` / `'branches'` synthetic events also flow through,
      // so the session re-emits on command-state changes and resolves the
      // default branch for the URL.
      docUnsub = next.subscribe((event) => {
        // A `branches` event resolves `defaultBranchId`, which `urlBranch`
        // needs to drop a specified-but-default branch; re-sync in place so
        // the pinned branch settles once the default is known.
        if (event.kind === 'branches') syncUrlForActive('replace');
        if (event.kind === 'change' && event.source !== 'remote') noteTrialEdit(next);
        // Take the doc's name whenever it moves. A rename reaches the doc
        // from the server's `doc_meta` frame, which sets it directly, and
        // `documentName` is what the emit signature reads: without this the
        // signature is unchanged, `emit` short-circuits, and chrome
        // rendering the name (the toolbar title) keeps the old one until
        // something unrelated perturbs the signature.
        if (next.name !== null) documentName = next.name;
        updatePageTitle();
        emit();
      });
      goneUnsub = next.onGone((reason) => {
        if (document !== next) return;
        const id = next.id;
        if (id && localDeletes.delete(id)) {
          // The user deleted this document through the hosted share dialog;
          // return to the empty state and clear the URL.
          close();
          return;
        }
        if (reason === 'moved' && id) {
          // A move keeps the same doc id: a cross-org/project re-home
          // (`patchDocument`), a project merge, or the soft-delete move path
          // all fan `doc_gone reason:'moved'` to evict the open editor, but the
          // document still exists under a new location. Re-open the same id so
          // the editor follows the move instead of showing a false "no longer
          // available"; fall back to the gone surface only if the re-open fails
          // (access was genuinely lost in the move). Detach the moved doc first
          // so that failure parks the gone surface rather than rebinding a doc
          // that is itself gone.
          //
          // Detaching is what leaves the evicted copy to be disposed here:
          // `activate` closes the document it detached itself, and it detached
          // a null one. Nothing else holds this copy, and an evicted Document
          // keeps its topic subscription and its LoroDoc until it is closed, so
          // every move would otherwise leave one resident for the life of the
          // page, taking a copy of every op the reopened document receives.
          //
          // A guest holds no access by id, so it re-opens through its link,
          // as its first open did.
          //
          // A copy that is already read-only (a reload onto converted or
          // sealed content, or one discarding a refused change) stays bound
          // until the re-opened one replaces it, so the reader keeps seeing
          // the document instead of a loading surface between two copies of
          // it. Nothing can be written to it in the meantime. An editable one
          // is detached as any other open detaches its predecessor.
          const branch = urlBranch(next);
          const evicted = next;
          const keepBound = next.readOnly;
          const mode = readOnlyOpens.has(next) ? { readOnly: true } : {};
          const guestToken = deps.guestLinkToken?.();
          const openGuest = deps.openDocumentByLink;
          if (!keepBound) {
            document = null;
            documentName = null;
          }
          void activate(
            (onSnapshotProgress) =>
              guestToken && openGuest
                ? openByLink(openGuest, guestToken, { ...mode, onSnapshotProgress })
                : openById(
                    id,
                    {
                      ...withDefaults(),
                      ...(branch ? { branch } : {}),
                      ...mode,
                      onSnapshotProgress,
                    },
                    'skip',
                  ),
            null,
            'skip',
            branch,
            true,
            keepBound,
          )
            .catch(() => markGoneRemote())
            .finally(() => closeQuietly(evicted));
          return;
        }
        // Evicted from under the viewer (remote delete, or a future eviction
        // reason). Keep the URL and park an 'error' surface, so it reads the
        // same as visiting the deleted id fresh rather than silently emptying.
        markGoneRemote();
      });
      // Re-arm the session-level canvas (if any) onto the new doc; capture
      // itself lives inside the Document.
      if (canvas !== null) {
        sessionCanvasUnregister = next.useCanvas(canvas);
      }
      // Prefer the caller-supplied name, else read the doc's own `name`.
      if (name !== null) next._setName(name);
      else documentName = next.name;
    }
    syncUrlForActive(urlNav);
    updatePageTitle();
    emit();
  }

  // The branch to carry in the URL: only a branch the user explicitly chose
  // is pinned, so a default-branch selection reads back as a bare `?doc=`. The
  // default is identified two ways (because `defaultBranchId` resolves only
  // after the branches list loads): no branch was specified, or the specified
  // one equals the now-known default. Before the list loads a specified branch
  // is shown (so a switch still pushes a distinct entry) and dropped by the
  // `branches` re-sync if it was the default.
  function urlBranch(doc: Document): string | null {
    const specified = activeSpecifiedBranch;
    if (specified === null) return null;
    const defaultBranchId = doc._defaultBranchId();
    if (defaultBranchId !== null && specified === defaultBranchId) return null;
    return specified;
  }

  // Reflect the active selection into the URL per `urlNav`. A null doc clears
  // the selection; a doc with no server identity (offline / test) is left
  // unpinned.
  function syncUrlForActive(urlNav: UrlNav): void {
    if (urlNav === 'skip') return;
    if (!document) {
      deps.clearUrlSelection();
      return;
    }
    if (!document.id) return;
    deps.writeUrlSelection(
      { docId: document.id, branchId: urlBranch(document) },
      { push: urlNav === 'push' },
    );
  }

  // The active branch's display name when it is NOT the default, else null.
  // Qualifies the page title; resolves once the branch list loads and the
  // `'branches'` event re-runs `updatePageTitle`.
  function activeBranchName(): string | null {
    return document?._currentBranchName() ?? null;
  }

  // Keep the page title on the active doc's name, qualified `Doc (branch)` on
  // a non-default branch, or restore the original title when none is open.
  // Prefers the doc's live `name` (tracks renames) over the seeded
  // `documentName`, falling back while the name resolves. The app-name
  // suffix (`Doc · App`) is applied one layer down in the client, which
  // holds the captured original title used as the suffix.
  function updatePageTitle(): void {
    if (!document) {
      deps.setPageTitle(null);
      return;
    }
    const base = document.name || documentName || '';
    const branch = activeBranchName();
    deps.setPageTitle(base && branch ? `${base} (${branch})` : base);
  }

  // Fetch the active doc's record once it binds, for the display name when
  // the caller didn't supply one. Best-effort: a failed lookup leaves the
  // name null.
  async function resolveActiveDocRecord(
    doc: Document,
    knownName: string | null,
  ): Promise<void> {
    if (!doc.id) return;
    if (knownName !== null) return;
    try {
      const record = await deps.documents.get(doc.id);
      if (document !== doc) return; // a newer open superseded this one
      doc._setName(record.name);
      documentName = record.name;
      updatePageTitle();
      emit();
    } catch {
      // best-effort; see the doc comment above.
    }
  }

  // Shared open path. `load` produces the document; `knownName` is the name
  // when the caller has it (picker / create), else null and resolved in the
  // background. `urlNav` decides the URL reflection (see `UrlNav`).
  async function activate(
    load: (
      onSnapshotProgress: (loaded: number, total: number | null) => void,
      onUploadProgress: (loaded: number, total: number) => void,
      releasePrevious: () => void,
    ) => Promise<OpenedDocument>,
    knownName: string | null,
    urlNav: UrlNav = 'push',
    specifiedBranch: string | null = null,
    // Whether a cold-open failure (no document to fall back to) parks the
    // session in the 'error' state. On for user-initiated opens; off for the
    // boot last-selected fallback, whose failure is a stale-persistence
    // self-heal that should settle silently on empty (the user asked for
    // nothing specific).
    surfaceOpenError = true,
    // Re-opening the document already bound: it stays bound, and the session
    // stays 'ready', until the new copy replaces it. A failure detaches it as
    // though it had been detached at the start.
    keepBound = false,
    // With `keepBound`: a failure leaves the bound document in place and only
    // rejects the caller.
    keepOnFailure = false,
  ): Promise<Document> {
    const generation = ++openGeneration;
    loading = !keepBound;
    loadingMessage = null;
    loadingProgress = null;
    // A new open attempt supersedes any prior failure's error state.
    openError = null;
    // Detach (without closing) the active document for the load, so the app
    // renders its loading surface instead of the outgoing editor sitting
    // there stale and still editable. `document` is null and `status` is
    // 'loading' until the new doc binds; a failed open restores the previous
    // binding. The doc-event/gone subscriptions stay attached (`setDocument`
    // re-points them, and the restore path watches the same doc).
    let previousDocument = keepBound ? null : document;
    const previousName = keepBound ? null : documentName;
    const previousSpecifiedBranch = activeSpecifiedBranch;
    if (!keepBound) {
      document = null;
      documentName = null;
    }
    // What the join's spilled ops have cost so far, and what the whole
    // download was declared to be. Carried across the two phases so the pair
    // reads as one figure. Per open, because a second open of the same
    // document downloads it again.
    let tailLoadedBytes = 0;
    let downloadTotalBytes: number | null = null;
    emit();
    // Surface snapshot-download progress. Ignored once a newer open supersedes
    // this generation, so a slow stale download can't repaint the new open.
    const onSnapshotProgress = (
      loaded: number,
      total: number | null,
      phase?: 'snapshot' | 'tail' | 'preparing' | 'importing',
      message?: string,
    ): boolean => {
      if (generation !== openGeneration) return false;
      // The platform is making the document editable, or replacing a
      // reader's content, and the open waits for it with nothing bound
      // meanwhile. A replacement is described in the platform's own words.
      if (phase === 'preparing' || phase === 'importing') {
        loadingProgress = null;
        loadingMessage =
          phase === 'preparing' ? PREPARING_MESSAGE : message !== undefined && message !== '' ? message : 'Loading...';
        emit();
        return true;
      }
      // One download, reported once. A document whose ops spilled to storage
      // fetches them from the join before the snapshot, so a load has two
      // stretches of bytes arriving over the network with a reader watching.
      // Which of them is on the wire is a fact about how the platform stores a
      // document, not something a reader can act on, so both count into the
      // same figure under the same word.
      //
      // The tail runs first and declares no total, so its bytes are carried
      // into the snapshot's total once that is known. The percentage is then
      // monotonic across the pair rather than filling twice.
      if (phase === 'tail') {
        tailLoadedBytes = loaded;
        // The tail's total already includes the snapshot still to come, so the
        // figure runs across both rather than filling once here and again
        // after. Held for the snapshot phase, which reports only its own.
        downloadTotalBytes = total;
      }
      if (phase !== 'tail') {
        loaded += tailLoadedBytes;
        if (downloadTotalBytes !== null) total = downloadTotalBytes;
        else if (total !== null) total += tailLoadedBytes;
      }
      // Both phases fall through to the same reporting. The tail's total
      // already covers the snapshot still to come, so a tail callback that
      // reaches the total is a load with no snapshot phase behind it (an
      // inline snapshot arrived with the join and declares no bytes), and
      // the last byte of the download is the last progress event there will
      // ever be. Reported as a fraction of its own phase instead, that load
      // ends parked on a number that never moves again while the reader
      // waits out the import.
      const complete = total !== null && total > 0 && loaded >= total;
      if (complete) {
        // Bytes are in; the remaining work (loro import, projection, render)
        // is not byte-paced, so label the phase instead of freezing at ~100%.
        loadingProgress = null;
        loadingMessage = 'Reading...';
      } else if (total !== null && total > 0) {
        loadingProgress = Math.min(1, loaded / total);
        loadingMessage = `Downloading... ${Math.floor(loadingProgress * 100)}%`;
      } else {
        loadingProgress = null;
        loadingMessage = `Downloading... ${(loaded / 1_000_000).toFixed(1)} MB`;
      }
      emit();
      return true;
    };
    // Give up on this open. A warm swap (previous doc present) rebinds it and
    // only rejects the caller, so the working surface is never clobbered; with
    // nothing to fall back to the session parks in 'error' so a status-gated
    // app renders the failure, where a rebind would land on the empty state
    // and read as the app's document-less home. `display` is what the app
    // renders; it defaults to the platform's own open-failure copy.
    function abandonOpen(err: unknown, display?: BrassError): never {
      if (keepOnFailure && generation === openGeneration) {
        loading = false;
        loadingMessage = null;
        loadingProgress = null;
        emit();
        throw err;
      }
      if (generation === openGeneration) {
        loading = false;
        loadingMessage = null;
        loadingProgress = null;
        // 'replace' restores the URL without planting an entry for an open
        // that never happened.
        activeSpecifiedBranch = previousSpecifiedBranch;
        if (err instanceof SignInToFollowLink) {
          // The URL names the document the sign-in returns to.
          setDocument(previousDocument, previousName, 'skip');
        } else if (surfaceOpenError && previousDocument === null) {
          openError = display ?? toDisplayError(err);
          // Leave the URL pointing at the doc that failed ('skip', not the
          // 'replace' below that clears it for a null document): the error
          // surface corresponds to that id, so a reload re-shows it and the
          // id stays in the URL for a user to copy when requesting access.
          setDocument(previousDocument, previousName, 'skip');
        } else {
          setDocument(previousDocument, previousName, 'replace');
        }
      } else {
        // A newer open / close superseded this load (and captured a null
        // previous), so the detached document is this generation's to dispose.
        closeQuietly(previousDocument);
      }
      throw err;
    }
    // A file the open sends before there is a document to read.
    const onUploadProgress = (loaded: number, total: number): void => {
      if (generation !== openGeneration) return;
      loadingProgress = total > 0 ? Math.min(1, loaded / total) : null;
      loadingMessage =
        loadingProgress === null
          ? 'Uploading...'
          : `Uploading... ${Math.floor(loadingProgress * 100)}%`;
      emit();
    };
    // A load that moves the page onto another document's link takes the
    // outgoing document's credential with it, so that document closes then
    // rather than after the bind, and a failed open has nothing to rebind.
    const releasePrevious = (): void => {
      closeQuietly(previousDocument);
      previousDocument = null;
    };
    let doc: OpenedDocument;
    let askedToRead = false;
    try {
      const opening = load(onSnapshotProgress, onUploadProgress, releasePrevious);
      askedToRead = readOnlyAsks.has(opening);
      doc = await opening;
    } catch (err) {
      abandonOpen(err);
    }
    if (askedToRead) readOnlyOpens.add(doc);
    if (generation !== openGeneration) {
      // A newer open / close superseded this one. Discard the orphan (so its
      // WS subscription doesn't leak) plus the doc this generation detached.
      closeQuietly(doc);
      closeQuietly(previousDocument);
      return doc;
    }
    // An open by id resolves with the document's content or rejects, waiting
    // out any import first. A trial document opened through its link can
    // arrive empty while the visitor's file is imported, with a pending
    // blocking status; hold the session in 'loading' (surfacing the server
    // message) and bind only on the terminal status, so the editor's first
    // paint sees the content. A pending push is non-blocking and binds
    // immediately.
    const work = doc._workStatusNow;
    if (work !== null && work.pending && work.blocking !== false) {
      loadingMessage = work.message;
      loadingProgress = work.progress ?? null;
      emit();
      await new Promise<void>((resolve) => {
        let offStatus: (() => void) | null = null;
        let offGone: (() => void) | null = null;
        const settle = (): void => {
          offStatus?.();
          offGone?.();
          resolve();
        };
        offStatus = doc.onStatus((s) => {
          if (generation !== openGeneration) {
            settle();
            return;
          }
          if (s.pending) {
            loadingMessage = s.message;
            loadingProgress = s.progress ?? null;
            emit();
            return;
          }
          settle();
        });
        // A doc deleted while preparing never reaches a terminal status; the
        // gone signal is its terminal transition.
        offGone = doc.onGone(() => settle());
      });
      if (generation !== openGeneration) {
        closeQuietly(doc);
        closeQuietly(previousDocument);
        return doc;
      }
    }
    // The work ended with no content: the platform could not prepare this
    // document, so the open failed. Binding it would present an empty
    // document as ready, and the app would let the user work in it. The
    // platform's own message is what the app renders.
    if (doc._contentLoadFailed) {
      closeQuietly(doc);
      const failure = new BrassError(
        doc._workStatusNow?.message ?? OPEN_FAILED_MESSAGE,
        { status: 0 },
      );
      abandonOpen(failure, failure);
    }
    loading = false;
    loadingMessage = null;
    loadingProgress = null;
    activeSpecifiedBranch = specifiedBranch;
    setDocument(doc, knownName, urlNav);
    // The outgoing doc was detached at load start (so `setDocument` saw a null
    // previous); dispose it now the new one is bound.
    closeQuietly(previousDocument);
    void resolveActiveDocRecord(doc, knownName);
    return doc;
  }

  // Close a document the session holds outside the active slot (a detached
  // previous binding, a superseded open's orphan), swallowing teardown
  // failures.
  function closeQuietly(target: Document | null): void {
    if (!target) return;
    try {
      target.close();
    } catch {
      // non-fatal
    }
  }

  async function doStart(): Promise<Document | null> {
    // Guest boot: a `?brass_link=` token opens its document read-only,
    // before (and instead of) the signed-in restore paths. A bad / expired
    // token parks the 'error' state like any other failed explicit open.
    const guestToken = deps.guestLinkToken?.();
    if (guestToken && deps.openDocumentByLink) {
      if (document) return document;
      const openGuest = deps.openDocumentByLink;
      try {
        return await activate(
          (onSnapshotProgress) =>
            openByLink(openGuest, guestToken, inMode({ onSnapshotProgress }, undefined)).catch(
              async (err: unknown) => {
                const claimed = await claimedDocumentOf(guestToken, err);
                if (claimed === null) throw err;
                if (claimed === 'sign-in') throw new SignInToFollowLink();
                return openById(claimed.docId, inMode({ onSnapshotProgress }, undefined), 'skip');
              },
            ),
          null,
          'skip',
          null,
        );
      } catch (err) {
        forgetUnsavedWorkIfGone(guestToken, err);
        return null;
      }
    }
    if (document) return document;
    if (!deps.isSignedIn()) return restoreUnsavedWork();
    // A pick handed back by the hosted picker's redirect fallback opens
    // before the ordinary URL / last-selection restore, and independently of
    // `syncDocToUrl`. `takePickSelection` strips the one-shot params as it
    // reads them, so a reload lands on the ordinary restore, not the pick.
    const pick = deps.takePickSelection();
    const sel = pick ?? deps.readUrlSelection();
    if (sel) {
      try {
        // 'replace': a boot restore pins the URL selection in place, not a
        // navigation, so it must not plant a history entry.
        return await activate(
          (onSnapshotProgress) =>
            openById(
              sel.docId,
              inMode(
                {
                  ...(sel.branchId ? { branch: sel.branchId } : {}),
                  onSnapshotProgress,
                },
                undefined,
              ),
              'skip',
            ),
          null,
          'replace',
          sel.branchId,
        );
      } catch {
        // The user navigated to a specific `?doc=` and it could not be
        // opened. `activate` has parked the session in the 'error' state and
        // left the id in the URL (so the error corresponds to it and a reload
        // re-shows it); return rather than fall through to a different
        // last-selected doc, which would silently swap them onto content they
        // did not ask for and hide the failure.
        return null;
      }
    }
    const last = deps.lastSelectedDocument();
    if (last) {
      try {
        return await activate(
          (onSnapshotProgress) =>
            openById(last.doc_id, inMode({ onSnapshotProgress }, undefined), 'skip'),
          last.name,
          'replace',
          null,
          // A stale last-selection is a persistence self-heal, not a request
          // the user made; settle silently on empty rather than parking an
          // error.
          false,
        );
      } catch {
        // Stale last-selection; settle on the empty state.
      }
    }
    return null;
  }

  // Whether a failed link open says the link itself is gone. The view route
  // answers `404` for a token it does not know, `410` for one that expired
  // or was revoked and `403` for one its organization's policy now refuses;
  // anything else (no response, a shed request) says nothing about the link.
  function linkGone(err: unknown): boolean {
    return (
      err instanceof BrassError &&
      (err.status === 403 || err.status === 404 || err.status === 410)
    );
  }

  // The document a revoked link leads this person to, when their own claim
  // revoked it. Asked only on a 410, the one refusal a claim produces.
  async function claimedDocumentOf(token: string, err: unknown): Promise<ClaimedLinkTarget> {
    if (!(err instanceof BrassError) || err.status !== 410 || !deps.followClaimedLink) {
      return null;
    }
    try {
      return await deps.followClaimedLink(token);
    } catch {
      return null;
    }
  }

  // A stashed token the platform no longer answers names nothing to
  // continue, so it is forgotten where the refusal is heard, whether the
  // open was the boot of its URL or the restore below.
  function forgetUnsavedWorkIfGone(token: string, err: unknown): void {
    if (!linkGone(err)) return;
    if (deps.unsavedWork?.()?.token === token) deps.clearUnsavedWork?.();
  }

  // A signed-out boot on a URL that names no document reopens the last
  // document this browser made without an account on this app, the way a
  // signed-in boot reopens the last document picked.
  async function restoreUnsavedWork(): Promise<Document | null> {
    if (deps.readUrlSelection()) return null;
    const entry = deps.unsavedWork?.();
    if (!entry || !deps.enterGuestMode || !deps.openDocumentByLink) return null;
    const openGuest = deps.openDocumentByLink;
    const { token } = entry;
    // The same path a reload of the document's URL takes: the token becomes
    // the page's credential and the URL carries it, then the link opens.
    deps.enterGuestMode(token);
    try {
      return await activate(
        (onSnapshotProgress) =>
          openByLink(
            openGuest,
            token,
            inMode({ ...withDefaults({}), onSnapshotProgress }, undefined),
          ),
        null,
        'skip',
      );
    } catch (err) {
      // The token did not open, so it is not this page's credential after
      // all: the page is signed out again, and the stash is kept unless the
      // link is gone for good, so the next boot tries it again.
      deps.leaveGuestMode?.();
      openError = null;
      forgetUnsavedWorkIfGone(token, err);
      emit();
      return null;
    }
  }

  function start(): Promise<Document | null> {
    if (startPromise) return startPromise;
    startPromise = doStart().finally(() => {
      startPromise = null;
      // Notify once the boot restore settles. The signed-out -> empty
      // transition (signed in, no URL document) takes neither `activate`
      // branch, so without this emit the `session.subscribe(render)` boot
      // path would never hear that sign-in completed.
      emit();
    });
    return startPromise;
  }

  function open(
    docId: string,
    options?: SessionOpenOptions,
  ): Promise<Document> {
    if ((options as { frozen?: unknown } | undefined)?.frozen === true) {
      return Promise.reject(new BrassError(FROZEN_IN_SESSION, { status: 0 }));
    }
    const asked = options?.readOnly ?? options?.documentOptions?.readOnly;
    return activate(
      (onSnapshotProgress) =>
        openById(
          docId,
          inMode({ ...withDefaults(options), onSnapshotProgress }, asked),
        ),
      null,
      'push',
      options?.branch ?? null,
    );
  }

  // A switch the hosted history or branch surfaces make from the bound
  // document (another branch, a version, a fork) opens in the mode that
  // document was opened in, so a copy opened to read stays one and a copy
  // reopened to edit stays one.
  function openSibling(docId: string, options?: SessionOpenOptions): Promise<Document> {
    const current = document;
    const readOnly =
      current === null || current.id !== docId
        ? undefined
        : readOnlyOpens.has(current)
          ? true
          : current._openMode === 'edit'
            ? false
            : undefined;
    return open(docId, { ...options, ...(readOnly !== undefined ? { readOnly } : {}) });
  }

  // `reopen` on the bound document: the new copy replaces it the way a move's
  // reopen does, kept on screen until it binds and kept bound if the reopen
  // fails. The session holds a live copy, so a frozen one is the caller's to
  // open beside it.
  async function reopenBound(current: Document, mode: ReopenMode): Promise<OpenedDocument> {
    if (mode === 'frozen') {
      throw new BrassError(FROZEN_IN_SESSION, { status: 0 });
    }
    const id = current.id;
    if (id === null) throw new BrassError('No document is open', { status: 0 });
    const branch = urlBranch(current);
    const guestToken = deps.guestLinkToken?.();
    const openGuest = deps.openDocumentByLink;
    const readOnly = mode === 'read';
    const next = await activate(
      (onSnapshotProgress) =>
        guestToken && openGuest
          ? openByLink(openGuest, guestToken, {
              ...withDefaults(),
              readOnly,
              onSnapshotProgress,
            })
          : openById(id, {
              ...withDefaults(),
              ...(branch ? { branch } : {}),
              readOnly,
              onSnapshotProgress,
            }),
      documentName,
      'skip',
      activeSpecifiedBranch,
      true,
      true,
      true,
    );
    // A newer open, reopen or close took the session while this one joined,
    // and closed the copy it produced.
    if (document !== next) {
      throw new BrassError('The reopen was replaced by a later open of the session', {
        status: 0,
      });
    }
    return next as OpenedDocument;
  }

  // A create fails in two regimes, and only the later one reaches the
  // session. Once `activate` has the open, `abandonOpen` parks the failure on
  // `session.error` for a status-gated app to render. Everything before that
  // (minting the account-less document, resolving the destination) throws with
  // the returned promise as its only report, and the documented way to call
  // this from a button floats that promise, so the click reads as ignored.
  // Parking here under `abandonOpen`'s own condition gives both regimes one
  // surface. The generation check is what keeps a failure from clobbering a
  // newer open that started while this one was still resolving a destination.
  // The trial token this page last recorded an edit for, so a burst of
  // edits writes the marker once.
  let trialEditNoted: string | null = null;
  function noteTrialEdit(doc: Document): void {
    const token = deps.guestLinkToken?.();
    if (!token || doc.expiresAt === null || trialEditNoted === token) return;
    trialEditNoted = token;
    deps.markTrialEdited?.(token, doc.expiresAt);
  }

  // Whether New or Upload may replace the document on screen. A document
  // made without an account that this browser edited is kept only at its
  // link, so the visitor is asked first, and signing in is what keeps it.
  async function mayLeaveTrial(): Promise<boolean> {
    const token = deps.guestLinkToken?.();
    const doc = document;
    if (!token || !doc || doc.expiresAt === null) return true;
    if (!deps.confirmReplaceTrial || !deps.trialEdited?.(token)) return true;
    const answer = await deps.confirmReplaceTrial(doc.expiresAt);
    if (answer === 'sign-in') deps.signIn?.();
    return answer === 'leave';
  }

  async function create(
    options?: CreateDocumentOptions,
  ): Promise<Document | null> {
    const generation = openGeneration;
    try {
      return await createUnguarded(options);
    } catch (err) {
      if (generation === openGeneration && document === null && openError === null) {
        openError = toDisplayError(err);
        emit();
      }
      throw err;
    }
  }

  async function createUnguarded(
    options?: CreateDocumentOptions,
  ): Promise<Document | null> {
    // Placement is expressed by context, never an org this layer names.
    // Create-in-place: a New doc anchors on the active one via `sibling_of`,
    // resolved server-side (its project, or loose in its org). With no active
    // doc the create runs cold and the server tells us if the caller must
    // choose a destination.
    // The wire always carries a name so the server's untitled-numbering has
    // something to key on; `knownName` stays null when the caller gave none,
    // so the stored "Untitled N" is adopted once the record binds.
    const base: CreateDocumentArgs = { name: options?.name ?? 'Untitled' };
    if (options?.app_metadata !== undefined) base.app_metadata = options.app_metadata;
    if (document?.id) base.siblingOf = document.id;

    // Resolve to a docId BEFORE the loading state starts, so the hosted
    // picker / acquire surface opens over the empty state, not a loading
    // one. The server owns the single-vs-multi decision: a `needs-*` outcome
    // is where we open the corresponding hosted surface and retry with the
    // opaque destination it returns, relayed verbatim.
    // No account: the document is minted without one and opened through
    // its link token, which the URL then carries so a reload and a sign-in
    // both find it again.
    if (
      withoutAccount() &&
      deps.mintAnonymousDocument &&
      deps.enterGuestMode &&
      deps.openDocumentByLink
    ) {
      if (!(await mayLeaveTrial())) return null;
      const minted = await deps.mintAnonymousDocument(
        options?.name !== undefined ? { name: options.name } : {},
      );
      const enterGuestMode = deps.enterGuestMode;
      const openGuest = deps.openDocumentByLink;
      accountFreeOpen = true;
      try {
        return await activate(
          (onSnapshotProgress, _onUploadProgress, releasePrevious) => {
            releasePrevious();
            enterGuestMode(minted.linkToken);
            return openGuest(minted.linkToken, {
              ...withDefaults(
                options?.documentOptions
                  ? { documentOptions: options.documentOptions }
                  : undefined,
              ),
              onSnapshotProgress,
            });
          },
          options?.name ?? null,
          'skip',
        );
      } finally {
        accountFreeOpen = false;
      }
    }

    let args = base;
    let knownName = options?.name ?? null;
    const result = await placeThroughHostedSurfaces(
      deps,
      (destination) =>
        deps.createDocumentId(
          destination === undefined ? args : { ...args, destination },
        ),
      options?.name,
      (chosen) => {
        // The dialog's final name wins on both the wire and the display: the
        // user saw and could edit it.
        args = { ...args, name: chosen.name };
        knownName = chosen.name;
      },
    );
    if (result === null) return null;

    const docId = result.docId;
    const openOptions = options?.documentOptions
      ? { documentOptions: options.documentOptions }
      : undefined;
    // Pass the known name only when the caller or the picker supplied one;
    // with no name the server owns it (resolving the next free "Untitled N"),
    // and a null `knownName` is what lets `resolveActiveDocRecord` adopt the
    // stored name once the record binds.
    return activate(
      (onSnapshotProgress) =>
        openById(docId, {
          ...withDefaults(openOptions),
          onSnapshotProgress,
        }),
      knownName,
    );
  }

  // The upload runs inside the open, so the app renders its loading surface
  // with the upload's progress rather than an unchanged screen. A failure
  // lands on `session.error` the way a failed create's does.
  async function pickAnonymousFile(
    choose: () => Promise<File | null>,
    mint: NonNullable<DocumentSessionDeps['mintAnonymousDocumentFromFile']>,
    enterGuestMode: (token: string) => void,
    openGuest: NonNullable<DocumentSessionDeps['openDocumentByLink']>,
  ): Promise<Document | null> {
    const generation = openGeneration;
    let file: File | null;
    try {
      file = await choose();
    } catch (err) {
      // Before `activate` there is no open to abandon, so the refusal is
      // parked here under `create`'s condition.
      if (generation === openGeneration && document === null && openError === null) {
        openError = toDisplayError(err);
        emit();
      }
      throw err;
    }
    if (file === null) return null;
    accountFreeOpen = true;
    try {
      return await activate(
        async (onSnapshotProgress, onUploadProgress, releasePrevious) => {
          const minted = await mint({ file, onUploadProgress });
          releasePrevious();
          enterGuestMode(minted.linkToken);
          return openGuest(minted.linkToken, {
            ...withDefaults(),
            onSnapshotProgress,
          });
        },
        null,
        'skip',
      );
    } finally {
      accountFreeOpen = false;
      emit();
    }
  }

  async function pick(): Promise<Document | null> {
    if (
      withoutAccount() &&
      deps.chooseAnonymousFile &&
      deps.mintAnonymousDocumentFromFile &&
      deps.enterGuestMode &&
      deps.openDocumentByLink
    ) {
      if (!(await mayLeaveTrial())) return null;
      return pickAnonymousFile(
        deps.chooseAnonymousFile,
        deps.mintAnonymousDocumentFromFile,
        deps.enterGuestMode,
        deps.openDocumentByLink,
      );
    }
    const result = await deps.selectDocument();
    if (!result) return null;
    const opts = inMode(
      {
        ...withDefaults(),
        ...(result.branch_id ? { branch: result.branch_id } : {}),
      },
      undefined,
    );
    return activate(
      (onSnapshotProgress) =>
        openById(result.doc_id, { ...opts, onSnapshotProgress }),
      result.name,
      'push',
      result.branch_id ?? null,
    );
  }

  // Merge `defaultDocumentOptions` into the caller's options: caller values
  // win per-field, the default fills gaps, and nested `undo` is shallow-merged
  // so a partial override composes. Returns undefined when neither side has
  // anything.
  function withDefaults<
    T extends { documentOptions?: DocumentOptions } | undefined,
  >(options?: T): T {
    const docDefaults = session._defaultDocumentOptions;
    if (!docDefaults) return options as T;
    const callerDocOpts = options?.documentOptions;
    const mergedDocOpts: DocumentOptions = {
      ...docDefaults,
      ...callerDocOpts,
    };
    // Shallow-merge `undo` so a partial override composes. (The explicit
    // branch works around exactOptionalPropertyTypes' finicky
    // `undo?: T | undefined` -> `undo?: T` narrowing.)
    const mergedUndo = callerDocOpts?.undo
      ? { ...docDefaults.undo, ...callerDocOpts.undo }
      : docDefaults.undo;
    if (mergedUndo) mergedDocOpts.undo = mergedUndo;
    return {
      ...options,
      documentOptions: mergedDocOpts,
    } as T;
  }

  function close(): void {
    // Bump the generation so an in-flight open can't resurrect a document
    // after an explicit close.
    openGeneration++;
    loading = false;
    // A deliberate close returns to the empty state, clearing any parked open
    // failure (an app dismissing the error surface calls this).
    openError = null;
    // Reject awaiters of an open that was in flight at close time: 'empty' has
    // no settleWhenReady branch, so they would otherwise never settle.
    rejectWhenReadyPending(
      'Brass.session.whenReady: closed before a document was bound.',
    );
    // 'replace': clears the URL selection and restores the title without an
    // entry.
    setDocument(null, null, 'replace');
  }

  // The active document was evicted remotely (a `doc_gone` the user did not
  // initiate). Park the 'error' state with the gone message and leave the URL
  // pointing at the now-deleted id ('skip', not the 'replace' that would clear
  // it): the error surface corresponds to that id, so a reload re-shows it and
  // the id stays in the URL. Mirrors the failed-open error path in `activate`.
  function markGoneRemote(): void {
    openGeneration++;
    loading = false;
    openError = new BrassError(DOCUMENT_GONE_MESSAGE, { status: 404 });
    setDocument(null, null, 'skip');
  }

  // Browser Back / Forward moved the URL. Re-bind to the selection the URL now
  // names WITHOUT writing history again (the entry exists, so 'skip'). Only
  // user navigation fires `popstate`; the SDK's own push / replace do not, so
  // this can't feed back into another write.
  function handlePopState(): void {
    if (deps.authStatus() === 'unknown' || !deps.isSignedIn()) return;
    const sel = deps.readUrlSelection();
    if (!sel) {
      // Back / Forward landed on a bare URL: return to the empty state ('skip'
      // since the URL is already bare). Reset when a document OR a parked open
      // error is showing: a Forward into a now-deleted doc parks 'error' with a
      // null document, and a Back off it must clear the error and land on empty
      // rather than stranding the stale error surface over a bare URL.
      if (document || openError) {
        openGeneration++;
        loading = false;
        openError = null;
        setDocument(null, null, 'skip');
      }
      return;
    }
    const current = document;
    if (
      current &&
      current.id === sel.docId &&
      urlBranch(current) === sel.branchId
    ) {
      return; // already showing this selection
    }
    void activate(
      (onSnapshotProgress) =>
        openById(
          sel.docId,
          inMode(
            {
              ...withDefaults(),
              ...(sel.branchId ? { branch: sel.branchId } : {}),
              onSnapshotProgress,
            },
            undefined,
          ),
          'skip',
        ),
      null,
      'skip',
      sel.branchId,
    ).catch(() => {
      // Back / Forward to a doc that can't be opened parks the 'error' state
      // (or, warm, keeps the current doc); the URL the user navigated to is
      // left as-is, so the caught rejection needs no cleanup here.
    });
  }
  deps.onUrlPopState(handlePopState);

  // Sign-out (explicit, token expiry, or the boot resolution to signed-out)
  // drops the active document but PRESERVES the URL's `?doc=` selection. A
  // deep-linked visitor lands signed-out on `?doc=<id>`; `Brass.signIn()`
  // carries `window.location.href` as its return_to, so the id must survive
  // in the URL until that click, and `start()` restores it after sign-in.
  // A user-initiated `close()` clears the URL (return to the empty state);
  // sign-out must not, or the deep link is lost before the round-trip.
  function teardownForSignOut(): void {
    openGeneration++;
    loading = false;
    openError = null;
    setDocument(null, null, 'skip');
  }

  // Sign-out drops the document; the first sign-in restores it. A guest
  // (opened via `?brass_link=`) is never signed in, so the initial
  // resolution arrives here with `signedIn === false`; it must boot the
  // read-only link document rather than tear down to the sign-in surface.
  //
  // The first resolution to signed-out is the boot of a signed-out page, which
  // restores the unsaved work this browser made (`restoreUnsavedWork`); a
  // later sign-out lands on the sign-in surface.
  let authResolved = false;
  deps.onUserChange((signedIn) => {
    const boot = !authResolved;
    authResolved = true;
    if (signedIn || deps.guestLinkToken?.() != null) {
      if (!document) void start();
      else emit();
    } else {
      teardownForSignOut();
      // Deferred: a session made after `init` settled hears this resolution
      // while it is still being built.
      if (boot) queueMicrotask(() => void start());
    }
  });

  const session: DocumentSession = {
    get document(): Document | null {
      return document;
    },
    get documentName(): string | null {
      return documentName;
    },
    get status(): SessionStatus {
      return status();
    },
    get error(): BrassError | null {
      // Not gated on `status() === 'error'`. A signed-out visitor's failed
      // create is the case that gating loses: 'signed-out' outranks the error
      // in `status()` (the app must keep rendering its sign-in surface, which
      // is where the retry lives), so gating here left the try-before-signing-in
      // failure with no channel at all.
      // What makes ungating safe is that a parked error never coexists with a
      // bound document: `activate` clears it on entry and is the only path that
      // binds a non-null one, and `abandonOpen` parks only when there was no
      // document to fall back to. So this can never show a stale failure beside
      // a working document. A new write to `openError` has to hold that.
      return openError ?? deps.initFailure?.() ?? null;
    },
    get loadingMessage(): string | null {
      return loading ? loadingMessage : null;
    },
    get loadingProgress(): number | null {
      return loading ? loadingProgress : null;
    },
    get commands(): readonly Command[] {
      return allCommands();
    },
    get presence(): import('./presence.js').PresenceClient | null {
      return document?.presence ?? null;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      try {
        listener(session);
      } catch (err) {
        reportListenerThrow(err);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    open: ((docId?: string, options?: SessionOpenOptions) =>
      docId === undefined ? pick() : open(docId, options)) as DocumentSession['open'],
    create,
    pick,
    close,
    async run(commandId): Promise<void> {
      const command = allCommands().find((c) => c.id === commandId);
      // An app's own signed-out button may still run a withdrawn New or Open,
      // and the reader is owed the reason rather than a press that does
      // nothing.
      if (
        command &&
        command.group === 'session' &&
        !command.enabled &&
        withoutAccount() &&
        signedOutRefusal !== null
      ) {
        // A parked error never sits beside a bound document, so a guest
        // reading one hears the refusal through `onError` instead.
        if (document === null) {
          openError = signedOutRefusal;
          emit();
        } else {
          deps.reportError(signedOutRefusal);
        }
        return;
      }
      if (command) await command.run();
    },
    useCanvas(source): () => void {
      // A forwarder: store the canvas at session scope and re-arm it on the
      // active Document each time one becomes active. Apps can also call
      // `doc.useCanvas(canvas)` directly for per-doc control.
      canvas = source;
      // Detach any previous session-armed registration, then arm the active
      // doc.
      if (sessionCanvasUnregister) sessionCanvasUnregister();
      sessionCanvasUnregister = document
        ? document.useCanvas(source)
        : null;
      return () => {
        if (canvas === source) {
          canvas = null;
          if (sessionCanvasUnregister) sessionCanvasUnregister();
          sessionCanvasUnregister = null;
        }
      };
    },
    whenReady(): Promise<OpenedDocument> {
      if (document && status() === 'ready') {
        return Promise.resolve(document as OpenedDocument);
      }
      // Mirror `status()` (not raw `isSignedIn()`): a link guest is not
      // signed in yet legitimately has a read-only document loading, so only
      // a genuine 'signed-out' rejects here. This is the same terminal test
      // the async `settleWhenReady` path uses; a raw `!isSignedIn()` check
      // would reject every guest before its document binds.
      if (status() === 'signed-out') {
        return Promise.reject(
          new Error(
            'Brass.session.whenReady: signed out before a document was bound.',
          ),
        );
      }
      // Already-terminal open failure: reject now rather than wait for a bind
      // that isn't coming.
      const failure = session.error;
      if (status() === 'error' && failure) {
        return Promise.reject(failure);
      }
      return new Promise((resolve, reject) => {
        whenReadyPending.push({ resolve, reject });
      });
    },
    setDefaultDocumentOptions(options): void {
      defaultDocumentOptions = options;
    },
    get _defaultDocumentOptions(): DocumentOptions | null {
      return defaultDocumentOptions;
    },
    _noteLocalDelete(docId: string): void {
      localDeletes.add(docId);
    },
    _clearLocalDelete(docId: string): void {
      localDeletes.delete(docId);
    },
    _openSibling: openSibling,
  };

  return session;
}
