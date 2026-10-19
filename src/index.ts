// The app-facing entry (`@brass-build/client`). A type reaches this barrel
// only when a member of `Brass`, `Document`, or `DocumentSession` names it
// in a signature, so what an app's autocomplete offers is what an app can
// call. The plumbing under those members (the session's dependency seam,
// the document factory, the join and at-version wire shapes) stays exported
// from its own module for this package's own use, and `./internal` carries
// the primitives Brass's own dashboard and console import.
// `__tests__/exports-contract.test.ts` pins both sets.

import { BrassClient } from './client.js';
import type {
  CreateDocumentOptions,
  OpenDocumentByIdOptions,
  OpenedDocument,
} from './open-document.js';
import type {
  ChooseInputOptions,
  ChooseInputsOptions,
  DocumentFamilies,
  InputReference,
  SelectDocumentResult,
} from './hosted-ui.js';
import type { AppServiceState, CallServiceOptions } from './call-service.js';
import type { DocumentsNamespace } from './documents-namespace.js';
import type { OpenDocumentById } from './read-only-document.js';
import type { DocumentImporter } from './import-contract.js';
import type { DocumentSerializer } from './serializer.js';
import type { DocumentSession } from './session.js';
import type {
  AuthStatus,
  ErrorListener,
  BrassInitOptions,
  BrassUser,
  UndoControllerOptions,
  UserChangeListener,
} from './types.js';

export type {
  AuthStatus,
  ErrorListener,
  BrassInitOptions,
  BrassUser,
  UndoControllerOptions,
  UserChangeListener,
};
export { BrassError, type BrassErrorCode } from './errors.js';
export type {
  AppServiceState,
  CallServiceBody,
  CallServiceOptions,
} from './call-service.js';
export {
  type HostedUiTheme,
  type ChooseInputOptions,
  type ChooseInputsOptions,
  type DocumentFamilies,
  type SelectDocumentResult,
  type SelectionAccept,
  type SelectionNarrowing,
} from './hosted-ui.js';
export {
  type DocumentMember,
  type DocumentRecord,
  type DocumentRole,
  type DocumentSourceBlob,
  type DocumentStreamInfo,
  type DocumentSummary,
  type DocumentThumbnail,
  type DocumentsNamespace,
  type GetThumbnailOptions,
  type SetThumbnailInput,
} from './documents-namespace.js';
export {
  type ReadOnlyDocument,
  type ReadOnlyStream,
  type ReadOnlyListHandle,
  type ReadOnlyMapHandle,
  type ReadOnlyOrderedMapHandle,
  type ReadOnlyTextHandle,
  type OpenModeOptions,
} from './read-only-document.js';
export {
  type CanvasSource,
  type Command,
  type CommandGroup,
  type CommandSurface,
  type DocumentSession,
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
  type RootKind,
  type UndoState,
  type UndoStateSubscriber,
} from './documents.js';
export type {
  Change,
  ChangeOrigin,
  ChangeSource,
  HandleUnsubscribe,
  ListHandle,
  ListChange,
  ListSubscriber,
  Splice,
  MapHandle,
  MapSubscriber,
  MutateOptions,
  OrderedMapHandle,
  OrderedMapPosition,
  TextHandle,
  TextSubscriber,
} from './handle-types.js';
export type {
  InputDocument,
  InputDocumentHandlers,
  InputDocumentOpen,
  InputDocumentOptions,
} from './input-documents.js';

export type {
  DocumentSerializer,
  StoredDocument,
  StoredList,
  StoredMap,
} from './serializer.js';
export type {
  DocumentImporter,
  ImportContent,
  ImportFile,
  ImportResult,
} from './import-contract.js';
export type {
  ImportFinding,
  ImportFindingKind,
  ImportReport,
} from './import-report.js';
export type {
  InputReference,
  InputStatus,
  InputStatusDocument,
} from './inputs-status.js';
export { DocumentStream } from './document-streams.js';
export {
  type CreateDocumentOptions,
  type OpenDocumentByIdOptions,
  type OpenedDocument,
} from './open-document.js';
export { PRESENCE_LAYER_MAX_BYTES } from './presence.js';
export type {
  PresenceChangeListener,
  PresenceClient,
  PresenceLayer,
  PresenceParticipant,
  PresenceSetInput,
  PresenceState,
  PresenceStatus,
  PresenceStatusListener,
} from './presence.js';

const client = new BrassClient();

// A Brass-hosted bundle (`*.onbrass.app`) resolves its app id and
// environment from the serving slot, so it takes no id; everywhere else the
// id is supplied. One bundle does both, so the id argument accepts
// `undefined` and an app can pass whatever its build resolved to without
// branching on it.
function init(options?: BrassInitOptions): Promise<void>;
function init(appId: string | undefined, options?: BrassInitOptions): Promise<void>;
function init(
  appIdOrOptions?: string | BrassInitOptions,
  options?: BrassInitOptions,
): Promise<void> {
  if (typeof appIdOrOptions === 'string') return client.init(appIdOrOptions, options);
  // With no id in the first position the options are in whichever argument
  // the caller used: `init(options)` on a hosted bundle, `init(undefined,
  // options)` from an app that resolves its id at build time.
  return client.init(undefined, appIdOrOptions ?? options);
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
  // One call to an outside service the app's manifest declares, under a
  // credential Brass holds. Returns the service's own response.
  callService(
    host: string,
    path: string,
    options?: CallServiceOptions,
  ): Promise<Response> {
    return client.callService(host, path, options);
  },
  // Which of this app's declared services would serve a call right now, so a
  // feature that works better with an account connected renders as available
  // or as an upgrade before the reader presses anything.
  //
  // Null while the app is acting in no organization yet, or in one that has
  // not installed it, which is a state to render the feature as available on.
  // `connectService` asks when the reader reaches for it.
  listServices(): Promise<AppServiceState[] | null> {
    return client.listServices();
  },
  // Open the hosted dialog for one service from the app's own affordance.
  // Whoever can supply the credential does it there; anyone else reads who to
  // ask. Resolves true when that host became usable.
  connectService(host: string): Promise<boolean> {
    return client.connectService(host);
  },
  // Metadata read for a known id (`get`) plus thumbnails. Create / move /
  // grant access are hosted-only.
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
  /** @deprecated Use `Brass.session.open()` with no id. */
  selectDocument(): Promise<SelectDocumentResult | null> {
    return client.selectDocument();
  },
  // Files, folders and projects as references, or `null` when the person
  // closes the picker. A folder or project reference keeps including what is
  // filed there later: record the references with `doc.dependsOn`, and the
  // key's status lists the files they include. Rejects with
  // `iframe_unavailable` where the browser blocks the picker.
  chooseInputs(
    families: DocumentFamilies,
    options?: ChooseInputsOptions,
  ): Promise<InputReference[] | null> {
    return client.chooseInputs(families, options);
  },
  // One file as a reference, such as a standard a model is checked against.
  // Resolves with that reference, or `null` when the person closes the
  // picker; keep the reference you already have on `null`. Rejects with
  // `iframe_unavailable` where the browser blocks the picker.
  chooseInput(
    families: DocumentFamilies,
    options?: ChooseInputOptions,
  ): Promise<InputReference | null> {
    return client.chooseInput(families, options);
  },
  // Opens the hosted multi-tier share dialog (document / project /
  // organization in one UI) focused on the given document.
  shareDocument(docId: string): Promise<void> {
    return client.shareDocument(docId);
  },
  // `readOnly: true` opens a live copy with nothing on it that writes
  // (`ReadOnlyDocument`).
  openDocumentById: ((docId: string, options?: OpenDocumentByIdOptions) =>
    client.openDocumentById(docId, options)) as OpenDocumentById,
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
  // Register the app's import backend: given a document's stored files, it
  // returns the document's content. Brass seals what it returns as the
  // document's first content. Call once at boot beside `registerSerializer`.
  registerImporter(importer: DocumentImporter): void {
    client.registerImporter(importer);
  },
};

export default Brass;
