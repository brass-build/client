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
} from './documents.js';
import type {
  CreateDocumentArgs,
  CreateDocumentOptions,
  CreateDocumentResult,
  OpenDocumentByIdOptions,
  OpenedDocument,
} from './open-document.js';
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
// to). 'unknown' is distinct from 'signed-out' so a status-gated app renders a
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
  // the next open / create / close.
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
  // Open a document by id and make it active.
  open(docId: string, options?: SessionOpenOptions): Promise<Document>;
  // Create a document and make it active. Create-in-place: with no explicit
  // destination it lands as a sibling of the active one. A cold create (no
  // active doc) in a single-org caller lands loose; a multi-org caller is
  // asked via the hosted destination dialog, resolving null on dismiss.
  create(options?: CreateDocumentOptions): Promise<Document | null>;
  // Open the hosted picker and make the picked document active; null on
  // dismiss.
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
}

// Dependency seam. The session is a pure coordinator over the public SDK
// surface; injecting these keeps it unit-testable and breaks the import cycle.
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
  // Anonymous "anyone with the link" boot. When the page was opened via a
  // public-link token (`?brass_link=`), `guestLinkToken` returns it and the
  // session boots by opening that document read-only through
  // `openDocumentByLink` instead of the signed-in URL / last-selected
  // restore. Absent (returns null) in the ordinary signed-in case.
  guestLinkToken?(): string | null;
  openDocumentByLink?(
    token: string,
    options?: OpenDocumentByIdOptions,
  ): Promise<OpenedDocument>;
}

// Built-in orphan command labels (no active doc needed). Sentence case, ASCII
// ellipsis, per the copy-style rules. Both stay bare: an app's own word for
// what it holds is rarely "document" (a sketch, a model, a sheet), so a
// label naming it would read wrong in most of the apps this menu mounts in.
const SESSION_LABELS = {
  new: 'New',
  open: 'Open...',
} as const;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// Fallback copy for a failed open with no server message to render (a
// network drop, no HTTP response). The HTTP case carries the server's own
// message instead, so the platform evolves the wording without an app change.
const OPEN_FAILED_MESSAGE = 'This document could not be opened';

// Copy parked on `session.error` when the open document is evicted remotely
// (a `doc_gone` the local user did not initiate). Matches the wording a
// post-eviction op frame degrades to ("the document is no longer available"),
// so a delete observed live and a fresh visit to the same deleted id read the
// same. A reload re-opens the id, hits the server 404, and swaps in the
// server-authored copy.
const DOCUMENT_GONE_MESSAGE = 'This document is no longer available';

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

  function status(): SessionStatus {
    // 'unknown' before auth settles; the onUserChange handler re-fires
    // (start() / emit()) and flips this to its resolved value.
    if (deps.authStatus() === 'unknown') return 'unknown';
    // A guest (opened via `?brass_link=`) is not signed in but still has a
    // read-only document to load, so it never reports 'signed-out' (which
    // would render the app's sign-in surface instead of the document).
    const isGuest = deps.guestLinkToken?.() != null;
    if (!deps.isSignedIn() && !isGuest) return 'signed-out';
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
    const err = openError ? `${openError.status ?? ''}:${openError.message}` : '';
    return `${status()}|${document?.id ?? ''}|${documentName ?? ''}|${load}|${err}|${cmds}`;
  }

  function emit(): void {
    const sig = signature();
    if (sig === lastSignature) return;
    lastSignature = sig;
    // Settle pending `whenReady()` promises BEFORE notifying, so an app whose
    // subscribe handler awaits whenReady sees it already resolved by the time
    // its listener runs.
    settleWhenReady();
    for (const listener of listeners) {
      try {
        listener(session);
      } catch (err) {
        // A throwing listener must not strand the others.
        console.error('[Brass] session listener threw:', err);
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
    } else if (current === 'error' && openError) {
      // A user-initiated open failed terminally; reject rather than hang the
      // awaiter forever. Same error object the session surfaces on `.error`.
      const pending = whenReadyPending.splice(0, whenReadyPending.length);
      for (const { reject } of pending) reject(openError);
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
    label: string,
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

  const cmdNew = buildOrphanCommand(
    'new',
    SESSION_LABELS.new,
    'session',
    'menu',
    deps.isSignedIn,
    async () => {
      await create();
    },
  );
  const cmdOpen = buildOrphanCommand(
    'open',
    SESSION_LABELS.open,
    'session',
    'menu',
    deps.isSignedIn,
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
        const kind = (event as { kind?: string } | undefined)?.kind;
        if (kind === 'branches') syncUrlForActive('replace');
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
          const branch = urlBranch(next);
          document = null;
          documentName = null;
          void activate(
            (onSnapshotProgress) =>
              deps.openDocumentById(
                id,
                {
                  ...withDefaults(),
                  ...(branch ? { branch } : {}),
                  onSnapshotProgress,
                },
                'skip',
              ),
            null,
            'skip',
            branch,
          ).catch(() => markGoneRemote());
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
  ): Promise<Document> {
    const generation = ++openGeneration;
    loading = true;
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
    const previousDocument = document;
    const previousName = documentName;
    const previousSpecifiedBranch = activeSpecifiedBranch;
    document = null;
    documentName = null;
    emit();
    // Surface snapshot-download progress. Ignored once a newer open supersedes
    // this generation, so a slow stale download can't repaint the new open.
    const onSnapshotProgress = (loaded: number, total: number | null): void => {
      if (generation !== openGeneration) return;
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
    };
    let doc: OpenedDocument;
    try {
      doc = await load(onSnapshotProgress);
    } catch (err) {
      if (generation === openGeneration) {
        loading = false;
        loadingMessage = null;
        loadingProgress = null;
        // Rebind the previous document so the user keeps their editor.
        // 'replace' restores the URL without planting an entry for an open
        // that never happened.
        activeSpecifiedBranch = previousSpecifiedBranch;
        // With no document to fall back to, a rebind lands on the empty state,
        // which reads as the app's document-less home and hides the failure.
        // Park the session in 'error' instead so a status-gated app renders
        // the failure. A warm swap (previous doc present) keeps the editor and
        // only rejects the caller, so the working surface is never clobbered.
        if (surfaceOpenError && previousDocument === null) {
          openError = toDisplayError(err);
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
    if (generation !== openGeneration) {
      // A newer open / close superseded this one. Discard the orphan (so its
      // WS subscription doesn't leak) plus the doc this generation detached.
      closeQuietly(doc);
      closeQuietly(previousDocument);
      return doc;
    }
    // A doc opened mid-preparation (drive-stub hydration, upload extraction)
    // arrives empty + read-only with a pending blocking status; the SDK
    // imports the content and emits the terminal status when the work
    // finishes. Hold the session in 'loading' (surfacing the server message)
    // and bind only on that terminal status, so the editor's first paint sees
    // the content. A pending push is non-blocking and binds immediately.
    const work = doc.status;
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
          (onSnapshotProgress) => openGuest(guestToken, { onSnapshotProgress }),
          null,
          'skip',
          null,
        );
      } catch {
        return null;
      }
    }
    if (!deps.isSignedIn() || document) return document;
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
            deps.openDocumentById(
              sel.docId,
              {
                ...(sel.branchId ? { branch: sel.branchId } : {}),
                onSnapshotProgress,
              },
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
            deps.openDocumentById(last.doc_id, { onSnapshotProgress }, 'skip'),
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
    return activate(
      (onSnapshotProgress) =>
        deps.openDocumentById(docId, {
          ...withDefaults(options),
          onSnapshotProgress,
        }),
      null,
      'push',
      options?.branch ?? null,
    );
  }

  async function create(
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
    let args = base;
    let knownName = options?.name ?? null;
    let result: CreateDocumentResult;
    for (;;) {
      result = await deps.createDocumentId(args);
      if (result.kind === 'created') break;
      if (result.kind === 'needs-organization') {
        const acquired = await deps.acquireOrganization();
        if (!acquired) return null;
        args = { ...args, destination: { organization_id: acquired.organization_id } };
        continue;
      }
      // needs-destination
      const destination = await deps.selectCreateDestination(
        options?.name !== undefined ? { name: options.name } : undefined,
      );
      if (destination === null) return null;
      // The dialog's final name wins on both the wire and the display: the
      // user saw and could edit it.
      args = { ...args, destination, name: destination.name };
      knownName = destination.name ?? knownName;
    }

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
        deps.openDocumentById(docId, {
          ...withDefaults(openOptions),
          onSnapshotProgress,
        }),
      knownName,
    );
  }

  async function pick(): Promise<Document | null> {
    const result = await deps.selectDocument();
    if (!result) return null;
    const opts = {
      ...withDefaults(),
      ...(result.branch_id ? { branch: result.branch_id } : {}),
    };
    return activate(
      (onSnapshotProgress) =>
        deps.openDocumentById(result.doc_id, { ...opts, onSnapshotProgress }),
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
        deps.openDocumentById(
          sel.docId,
          {
            ...withDefaults(),
            ...(sel.branchId ? { branch: sel.branchId } : {}),
            onSnapshotProgress,
          },
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
  deps.onUserChange((signedIn) => {
    if (signedIn || deps.guestLinkToken?.() != null) {
      if (!document) void start();
      else emit();
    } else {
      teardownForSignOut();
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
      return status() === 'error' ? openError : null;
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
        console.error('[Brass] session listener threw:', err);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    open,
    create,
    pick,
    close,
    async run(commandId): Promise<void> {
      const command = allCommands().find((c) => c.id === commandId);
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
      if (status() === 'error' && openError) {
        return Promise.reject(openError);
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
  };

  return session;
}
