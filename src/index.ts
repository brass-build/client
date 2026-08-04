import { BrassClient } from './client.js';
import type {
  CreateDocumentOptions,
  OpenDocumentByIdOptions,
  OpenedDocument,
} from './open-document.js';
import type { SelectDocumentResult } from './hosted-ui.js';
import type { DocumentsNamespace } from './documents-namespace.js';
import type { DocumentImporter } from './importer.js';
import type { DocumentSerializer } from './serializer.js';
import type { DocumentSession } from './session.js';
import type {
  AuthStatus,
  ErrorListener,
  BrassInitOptions,
  BrassUser,
  UserChangeListener,
} from './types.js';

export type {
  AuthStatus,
  ErrorListener,
  BrassInitOptions,
  BrassUser,
  UserChangeListener,
};
export { BrassError, type BrassErrorCode } from './errors.js';
export {
  type AcquireOrganizationResult,
  type HostedUiLauncher,
  type HostedUiLauncherOptions,
  type HostedUiTheme,
  type SelectDocumentResult,
} from './hosted-ui.js';
export {
  type DocumentMember,
  type DocumentRecord,
  type DocumentRole,
  type DocumentCheckpoint,
  type DocumentSourceBlob,
  type DocumentSourceStream,
  type DocumentStreamInfo,
  type DocumentSummary,
  type DocumentThumbnail,
  type DocumentsNamespace,
  type GetThumbnailOptions,
  type SetThumbnailInput,
} from './documents-namespace.js';
export {
  type CanvasSource,
  type Command,
  type CommandGroup,
  type CommandSurface,
  type DocumentSession,
  type DocumentSessionDeps,
  type SessionOpenOptions,
  type SessionStatus,
} from './session.js';
export type {
  SessionToolbarHandle,
  SessionHeaderHandle,
  SessionToolbarOptions,
  MountedPiece,
} from './session-toolbar.js';
import type {
  SessionToolbarHandle,
  SessionHeaderHandle,
  SessionToolbarOptions,
  MountedPiece,
} from './session-toolbar.js';
export {
  Document,
  type DocumentMutator,
  type DocumentOptions,
  type DocumentSubscriber,
  type SyntheticSubscribeEvent,
  type DocumentUnsubscribe,
  type DocumentGoneListener,
  type DocumentGoneReason,
  type DocumentGoneUnsubscribe,
  type DocumentWorkStatus,
  type DocumentStatusListener,
  type DocumentStatusUnsubscribe,
  type DocumentDriveStatus,
  type DocumentDriveStatusListener,
  type DocumentDriveStatusUnsubscribe,
  type DocumentDriveTrackingState,
  type DriveMirrorDirection,
  type EntityProxy,
  type UndoState,
  type UndoStateSubscriber,
} from './documents.js';
export type {
  Change,
  ChangeOrigin,
  ChangeSource,
  HandleUnsubscribe,
  ListHandle,
  ListSubscriber,
  MapHandle,
  MapSubscriber,
  OrderedMapHandle,
} from './handles.js';
export type { UndoControllerOptions } from './undo.js';
export type { DocumentSerializer } from './serializer.js';
export type { DocumentImporter } from './importer.js';
export { DocumentStream, type StreamRuntime } from './document-streams.js';
export {
  type CreateDocumentFn,
  type CreateDocumentOptions,
  type DocumentAtVersionResponse,
  type DocumentDriveSummaryWire,
  type DocumentFactory,
  type DocumentSnapshotResponse,
  type OpenDocumentFactoryOptions,
  type OpenDocumentByIdFn,
  type OpenDocumentByIdOptions,
  type OpenDocumentWsClient,
  type OpenedDocument,
} from './open-document.js';
export type {
  PresenceChangeListener,
  PresenceClient,
  PresenceParticipant,
  PresenceSetInput,
  PresenceState,
} from './presence.js';

const client = new BrassClient();

// A Brass-hosted bundle (`*.onbrass.app`) resolves its app id and
// environment from the serving slot, so it uses the zero-argument form;
// everywhere else the app id is required.
function init(options?: BrassInitOptions): Promise<void>;
function init(appId: string, options?: BrassInitOptions): Promise<void>;
function init(
  appIdOrOptions?: string | BrassInitOptions,
  options?: BrassInitOptions,
): Promise<void> {
  if (typeof appIdOrOptions === 'string') return client.init(appIdOrOptions, options);
  return client.init(undefined, appIdOrOptions);
}

export const Brass = {
  init,
  signIn(): void {
    client.signIn();
  },
  signOut(): void {
    client.signOut();
  },
  get user(): BrassUser | null {
    return client.currentUser;
  },
  // Tri-state auth lifecycle: `'unknown'` until `Brass.init` settles,
  // then `'signed-in'` / `'signed-out'`. Gate the sign-in CTA on this,
  // not on `!Brass.user`: a falsy `user` during `'unknown'` is "not
  // checked yet", so gating on `!user` flashes the CTA at signed-in
  // users on reload. Render the CTA only on `'signed-out'`.
  get authStatus(): AuthStatus {
    return client.authStatus;
  },
  onUserChange(listener: UserChangeListener): () => void {
    return client.onUserChange(listener);
  },
  onError(listener: ErrorListener): () => void {
    return client.onError(listener);
  },
  getAccessToken(): Promise<string | null> {
    return client.getAccessToken();
  },
  // Metadata read for a known id (`get`) plus thumbnails / branches /
  // pushToDrive. Create / move / list / grant access are hosted-only.
  get documents(): DocumentsNamespace {
    return client.documents;
  },
  // The document session: owns the active-document lifecycle and exposes
  // a flat command list to render. Accessible before `Brass.init` so a
  // boot flow can subscribe first.
  get session(): DocumentSession {
    return client.session;
  },
  // SDK-rendered document toolbar: file menu, title, location, account
  // menu, presence roster into `container`. The app fills the returned
  // `tools` slot with its own buttons.
  mountToolbar(
    container: HTMLElement,
    options?: SessionToolbarOptions,
  ): SessionToolbarHandle {
    return client.mountToolbar(container, options);
  },
  // The bare header shell, for an app that wants the SDK's responsive
  // layout but fills the clusters itself. Mount pieces into the returned
  // `start` / `tools` / `end` slots; the account avatar in `end` stays
  // pinned top-right on mobile, never wrapping when the tools wrap.
  mountHeader(container: HTMLElement): SessionHeaderHandle {
    return client.mountHeader(container);
  },
  // Composable header pieces, for an app that builds its own shell and
  // wants the standard clusters (account menu / presence / title / file
  // menu / undo-redo) without the whole `mountToolbar` bar. Each renders
  // one cluster and returns `{ destroy(): void }`.
  mountFileMenu(container: HTMLElement): MountedPiece {
    return client.mountFileMenu(container);
  },
  mountDocumentTitle(container: HTMLElement): MountedPiece {
    return client.mountDocumentTitle(container);
  },
  mountUndoRedo(container: HTMLElement): MountedPiece {
    return client.mountUndoRedo(container);
  },
  mountPresenceRoster(container: HTMLElement): MountedPiece {
    return client.mountPresenceRoster(container);
  },
  mountDriveSync(container: HTMLElement): MountedPiece {
    return client.mountDriveSync(container);
  },
  mountAccountMenu(container: HTMLElement): MountedPiece {
    return client.mountAccountMenu(container);
  },
  // The historical-version preview banner (return-to-live during a hosted
  // `history` preview). `mountToolbar` / `mountHeader` already include it, so
  // this is only for an app that builds fully custom chrome.
  mountVersionPreview(container: HTMLElement): MountedPiece {
    return client.mountVersionPreview(container);
  },
  selectDocument(): Promise<SelectDocumentResult | null> {
    return client.selectDocument();
  },
  // Opens the hosted multi-tier share dialog (document / project /
  // organization in one UI) focused on the given document.
  shareDocument(docId: string): Promise<void> {
    return client.shareDocument(docId);
  },
  openDocumentById(
    docId: string,
    options?: OpenDocumentByIdOptions,
  ): Promise<OpenedDocument> {
    return client.openDocumentById(docId, options);
  },
  // `true` when the page was opened as an anonymous link guest
  // (`?brass_link=`): no signed-in user, a read-only document. Apps render
  // their working surface for a guest as they do for a signed-in user (the
  // document is read-only) and show their sign-in CTA only when neither.
  get isGuest(): boolean {
    return client.isGuest;
  },
  createDocument(options?: CreateDocumentOptions): Promise<OpenedDocument> {
    return client.createDocument(options);
  },
  // Register the app's export backend: serialises a blob document back
  // to its source file's bytes. The platform calls it when a user
  // downloads from a hosted surface (the app never initiates export).
  // Call once at boot; an app with no serializer cannot export blobs.
  registerSerializer(serializer: DocumentSerializer): void {
    client.registerSerializer(serializer);
  },
  // Register the app's import backend: parses a stored source file into
  // the document's records. Brass runs it when a document's file needs
  // importing; the records reach every open client live. Call once at
  // boot beside `registerSerializer`.
  registerImporter(importer: DocumentImporter): void {
    client.registerImporter(importer);
  },
};

export default Brass;
