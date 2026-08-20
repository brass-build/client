import {
  buildSignInUrl,
  buildSignedOutOfAppUrl,
  refreshTokens,
  revokeAppApproval,
  type RefreshCredential,
  type RefreshOutcome,
  type TokenSet,
} from './auth-flow.js';
import { decodeIdToken } from './jwt.js';
import { createEmitter } from './emitter.js';
import {
  clearParkedDocuments,
  createOpenDocument,
  type CreateDocumentArgs,
  type CreateDocumentOptions,
  type CreateDocumentResult,
  type DocumentFactory,
  type OpenDocumentByIdOptions,
  type OpenedDocument,
} from './open-document.js';
import { askSchemaConflict } from './schema-conflict-dialog.js';
import { BrassError } from './errors.js';
import {
  createHostedUiLauncher,
  trackHostedUiActivations,
  type DocumentHistoryResult,
  type ExportSerializeOutcome,
  type HostedUiLauncher,
  type HostedUiTheme,
  type SelectDocumentResult,
} from './hosted-ui.js';
import type { Document } from './documents.js';
import type { DocumentSerializer, StoredDocument } from './serializer.js';
import {
  createImportRunner,
  type DocumentImporter,
  type ImportRunner,
} from './importer.js';
import {
  isExportMode,
  startExportGuest,
  type ExportGuestController,
} from './export-guest.js';
import { readGuestLinkToken } from './guest-link.js';
import { consumeLaunchOrganizationId } from './launch-context.js';
import {
  clearAll as clearLastSelections,
  readLastDocument,
  storeLastDocument,
} from './selection-persistence.js';
import {
  DEFAULT_BRANCH_URL_PARAM,
  DEFAULT_DOC_URL_PARAM,
  PICK_BRANCH_PARAM,
  PICK_DOC_PARAM,
  clearUrlSelection,
  readUrlSelection,
  subscribePopState,
  takePickFromUrl,
  writeDocIdToUrl,
  writeUrlSelection,
} from './doc-url-sync.js';
import { composePageTitle, setPageTitle } from './page-title.js';
import {
  clearSessionToken,
  readSessionToken,
  storeSessionToken,
} from './session-persistence.js';
import {
  clearLoginHint,
  readLoginHint,
  storeLoginHint,
} from './login-hint.js';
import {
  createDocumentsNamespace,
  type DocumentsNamespace,
  type DocumentsInternalNamespace,
  type PushToDriveInput,
  type PushToDriveResult,
} from './documents-namespace.js';
import {
  createDocumentSession,
  type DocumentSession,
} from './session.js';
import {
  createSessionToolbar,
  createSessionHeader,
  createFileMenu,
  createDocumentTitle,
  createUndoRedo,
  createPresenceRoster,
  createDriveSync,
  createAccountMenu,
  createVersionPreview,
  type SessionToolbarDeps,
  type SessionToolbarHandle,
  type SessionHeaderHandle,
  type SessionToolbarOptions,
  type MountedPiece,
} from './session-toolbar.js';
import { BrassWsClient } from './ws-client.js';
import {
  fetchHostedRuntime,
  readInjectedRuntime,
  isBrassHostedHost,
  HOSTED_RUNTIME_PATH,
  type HostedRuntime,
} from './hosted-runtime.js';
import type {
  AuthStatus,
  ErrorListener,
  BrassInitOptions,
  BrassUser,
  UserChangeListener,
} from './types.js';

const DEFAULT_AUTH_BASE_URL = 'https://auth.brass.build';
// How long `signOut` waits for the revocation before it navigates. The page
// it lands on finishes an unrevoked sign-out itself, so waiting longer than
// this only delays the sign-out.
const SIGN_OUT_REVOKE_DEADLINE_MS = 4000;
// The data API has its own host, NOT the dashboard origin: the
// dashboard (app.brass.build) is a static SPA, the data API is a
// separate gateway behind api.brass.build.
const DEFAULT_API_BASE_URL = 'https://api.brass.build';
// Origin serving the `/embed/*` hosted-UI pages. An app on another
// stack overrides it via `Brass.init`'s `dashboardBaseUrl`.
const DEFAULT_DASHBOARD_BASE_URL = 'https://app.brass.build';
// The WS gateway has its own hostname, so it is not derivable from the
// api host and zero config has to supply it alongside the other three.
const DEFAULT_WS_BASE_URL = 'wss://ws.brass.build';

// Production's four origins, which are the only ones the package
// carries: every other stack is addressed by passing its own, so no
// deployment's hostname scheme ships to an app that installs this.
const PROD_ORIGINS = {
  authBaseUrl: DEFAULT_AUTH_BASE_URL,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  wsBaseUrl: DEFAULT_WS_BASE_URL,
  dashboardBaseUrl: DEFAULT_DASHBOARD_BASE_URL,
};

export interface ResolvedBaseUrls {
  authBaseUrl: string;
  apiBaseUrl: string;
  // Whether the app chose the api origin (an explicit `apiBaseUrl`, or
  // zero config, which is production) rather than naming some other
  // surface and leaving this one at its default. Gates init-time profile
  // hydration so auth-only apps never hit the data API.
  apiBaseUrlConfigured: boolean;
  wsBaseUrl: string | null;
  dashboardBaseUrl: string;
}

// Resolve the four base URLs from init options. Zero config applies all
// four production origins (including `wsBaseUrl`, so documents and
// presence work with nothing passed).
//
// Naming ANY `*BaseUrl` withholds the production `wsBaseUrl`: an app that
// overrides `apiBaseUrl` and inherited a production socket would connect to
// the wrong stack and silently drop events, where an unfilled `wsBaseUrl`
// fails loudly on subscribe.
//
// `authBaseUrl`, `apiBaseUrl` and `dashboardBaseUrl` still fall back to their
// production defaults, so a caller who names some but not all of them reaches
// production for the rest. `dashboardBaseUrl` is the one that goes wrong
// quietly: every hosted surface (the picker, share, the version bar) is framed
// from it, so an app on another stack frames production's, which either
// refuses to render or hands back ids the configured API cannot open. Name it
// alongside the others.
//
// Pure so the precedence is unit-testable.
export function resolveBaseUrls(options: BrassInitOptions): ResolvedBaseUrls {
  const anyUrlOverride = Boolean(
    options.authBaseUrl || options.apiBaseUrl || options.wsBaseUrl || options.dashboardBaseUrl,
  );
  const base = anyUrlOverride ? null : PROD_ORIGINS;
  const strip = (url: string): string => url.replace(/\/$/, '');
  return {
    authBaseUrl: options.authBaseUrl
      ? strip(options.authBaseUrl)
      : (base?.authBaseUrl ?? DEFAULT_AUTH_BASE_URL),
    apiBaseUrl: options.apiBaseUrl
      ? strip(options.apiBaseUrl)
      : (base?.apiBaseUrl ?? DEFAULT_API_BASE_URL),
    apiBaseUrlConfigured: Boolean(options.apiBaseUrl) || base !== null,
    wsBaseUrl: options.wsBaseUrl ? strip(options.wsBaseUrl) : (base?.wsBaseUrl ?? null),
    dashboardBaseUrl: options.dashboardBaseUrl
      ? strip(options.dashboardBaseUrl)
      : (base?.dashboardBaseUrl ?? DEFAULT_DASHBOARD_BASE_URL),
  };
}
// Refresh slightly before expiry so callers never see a stale access token.
const REFRESH_LEEWAY_MS = 60_000;
// App id format. The server mints `brass_app_` + random chars; some
// real ids carry a `test`/`live`/`internal` infix. The optional infix
// group accepts both shapes, and the permissive tail keeps minor
// server-side format bumps from stranding SDK consumers.
const APP_ID_PATTERN = /^brass_app_(?:(?:test|live|internal)_)?[A-Za-z0-9_-]+$/;

// What one `/refresh` settled, applied to the client's own state. Carries the
// `no_session` / `unavailable` split `RefreshOutcome` draws, because the two
// are opposite answers for a caller: `no_session` is the server saying this
// app has none, `unavailable` is the absence of an answer.
type RefreshSettlement =
  | { status: 'ok'; tokens: TokenSet }
  | { status: 'no_session' }
  | { status: 'unavailable' };

// The rejection for `unavailable`. A 503 status is what makes the outcome
// legible to the layers that branch on one: an app's own retry, and the
// selection self-heal that clears a persisted doc id on a definitive 403 /
// 404 and leaves a transient alone.
function refreshUnavailableError(): BrassError {
  return new BrassError('The sign-in service is unavailable', { status: 503 });
}

export class BrassClient {
  private appId: string | null = null;
  private authBaseUrl = DEFAULT_AUTH_BASE_URL;
  private apiBaseUrl = DEFAULT_API_BASE_URL;
  private apiBaseUrlConfigured = false;
  // Null only when the caller named some other `*BaseUrl` and not this
  // one; subscribing then fails loudly rather than connecting to a
  // different stack than the override points at.
  private wsBaseUrl: string | null = null;
  // Origin the `/embed/*` hosted-UI pages load from. Unlike `wsBaseUrl`
  // this always has a value (the production default), so the launchers
  // work with zero config in production.
  private _dashboardBaseUrl = DEFAULT_DASHBOARD_BASE_URL;
  // Defaults to `'light'`: the dominant hosted-UI host is light-only
  // (no `prefers-color-scheme: dark` in its CSS). `'auto'` follows the
  // OS preference; `'dark'` pins dark.
  private hostedUiTheme: HostedUiTheme = 'light';
  // See `BrassInitOptions.openIncompatibleDocuments`. When set, every open
  // carries the answer the dialog would otherwise ask for.
  private openIncompatibleDocuments = false;
  // Doc-selection-in-URL sync. On by default; off via
  // `syncDocToUrl: false`. Param names configurable via `docUrlParam` /
  // `branchUrlParam`.
  private syncDocToUrl = true;
  private docUrlParam: string = DEFAULT_DOC_URL_PARAM;
  private branchUrlParam: string = DEFAULT_BRANCH_URL_PARAM;
  // Page-title sync. On by default; off via `syncDocToTitle: false`. The
  // title at the first sync is captured so it can be restored when no
  // document is open.
  private syncDocToTitle = true;
  private originalPageTitle: string | null = null;
  private tokens: TokenSet | null = null;
  private user: BrassUser | null = null;
  // Flips to true exactly once, after `init()` settles (session
  // resolved, none found, or validation failed). Before it flips the
  // user is "unresolved": `this.user` is null only because we haven't
  // checked. Drives two things:
  //   1. `authStatus` (and `session.status`) report `'unknown'` while
  //      false, so a framework app can render a neutral state instead of
  //      its sign-in CTA during bootstrap.
  //   2. Listener firing is gated: pre-init subscribers never see the
  //      misleading initial-`null` emit, only the resolved value;
  //      post-init subscribers get an immediate fire with the current
  //      value.
  // `Brass.user` stays binary `BrassUser | null`; the third state lives
  // on `authStatus`.
  private bootstrapped = false;
  private listeners = new Set<UserChangeListener>();
  // Init-failure listeners. Swallow a listener's throw so one bad handler
  // cannot block the others or mask the original error (already logged).
  private readonly errorListeners = createEmitter<Error>({ onError: () => {} });
  private inflightRefresh: Promise<RefreshSettlement> | null = null;
  // Bumped by every `signOut`, and captured by a `/refresh` when it starts.
  // A refresh that settles against a moved epoch drops its answer: the
  // credentials it would write were cleared by a sign-out while it was in
  // flight, and re-writing them signs the person back in.
  private authEpoch = 0;
  private initialized = false;
  // Incognito / third-party-cookie fallback state. Both null in a normal
  // browser, where the cross-site `brass_auth` cookie carries the session
  // and `/refresh` works without a body.
  //   - `pendingAuthCode`: the one-time `brass_code` pulled off the
  //     landing URL by bootstrap(), consumed at most once by refresh() if
  //     the cookie channel is unavailable.
  //   - `sessionToken`: the app-bound session pointer from a code
  //     exchange. Once set, every refresh() uses it instead of the
  //     cookie. Mirrored into sessionStorage so a reload in a
  //     cookie-blocked browser hydrates it; see session-persistence.ts.
  private pendingAuthCode: string | null = null;
  private sessionToken: string | null = null;
  // Namespaces are lazily built on first access and memoised so
  // repeated reads return the same object.
  private documentsNamespace:
    | (DocumentsNamespace & DocumentsInternalNamespace)
    | null = null;
  // Unlike the other namespaces the session needs no appId, so its
  // getter does not gate on `init`.
  private documentSession: DocumentSession | null = null;
  private hostedUiLauncher: HostedUiLauncher | null = null;
  private documentFactory: DocumentFactory | null = null;
  // The `?brass_link=` token when this page was opened as an anonymous
  // link guest; null on the ordinary signed-in path. Set in `init`.
  private guestLinkTokenValue: string | null = null;
  // The organization this page was launched from (`?brass_org=`), or null
  // when the app was reached some other way. A create that names no
  // destination of its own lands here; see `launch-context.ts`.
  private launchOrganizationId: string | null = null;
  // The app's export backend (`Brass.registerSerializer`), invoked by the
  // platform when a hosted surface downloads an app-owned blob doc. One
  // per app; a later registration replaces the earlier.
  private serializer: DocumentSerializer | null = null;
  // Set only when this bundle was loaded by Brass in a hidden export-mode
  // iframe (`isExportMode`): serializes a handed-in snapshot and never
  // authenticates. `registerSerializer` forwards to it.
  private exportGuest: ExportGuestController | null = null;
  // Open documents by id, so an export request can hand the serializer
  // the right Document. Dropped when a doc goes; a re-open overwrites.
  private openDocuments = new Map<string, Document>();
  // The app's import backend (`Brass.registerImporter`) plus the claim
  // protocol run per opened document. The deps read the documents
  // namespace lazily, so attempts (always post-open) build it on demand.
  private readonly importRunner: ImportRunner = createImportRunner({
    claimImport: (docId) => this.docsInternal().claimImport(docId),
    completeImport: (docId) => this.docsInternal().completeImport(docId),
    reportError: (error) => this.fireError(error),
  });
  // One socket carrying every document topic this client subscribes,
  // built on first open so an app that never opens a document never
  // connects.
  private docWsClient: BrassWsClient | null = null;

  // init ALWAYS resolves: failures (bad/missing app_id) fire onError +
  // console.error rather than rejecting. Otherwise
  // `void Brass.init(typo).then(setup)` would never run .then() (init
  // rejected), hanging the page at its loading state with no visible
  // error. Resolving means .then() fires with `Brass.user === null` and
  // the page transitions to signed-out.
  async init(appId?: string, options: BrassInitOptions = {}): Promise<void> {
    // Start watching for activations here rather than where the hosted-UI
    // launcher is built: the launcher is built on first use, which is inside
    // the click handler that opens a surface, so it would miss the press that
    // opened it and have nothing to hand focus back to on dismissal.
    trackHostedUiActivations();
    try {
      // A Brass-hosted bundle resolves its app id and all four origins from
      // the serving slot's runtime descriptor, which is authoritative: the
      // slot's environment is fixed by the origin, so init args pointing
      // elsewhere (incl. a baked app id, which hosted demo bundles carry and
      // expect the slot to replace) are a cross-environment mismatch. Whether
      // an origin IS a Brass slot is the HOST's call, not the SDK's: the SDK
      // cannot tell a slot from a developer's own hosting by hostname (a
      // custom serving domain / vanity URL is the customer's own name).
      //
      // The serving slot therefore STAMPS the descriptor into the page it
      // serves (`window.__brassRuntime`, injected into `index.html`). The SDK
      // reads that first, synchronously and fetch-free, on any host: its
      // presence means this origin is a Brass slot. A developer self-hosting
      // stamps nothing, so their own config stands with no request made. The
      // same artifact is thus portable unmodified across an external host and
      // any Brass slot (onbrass or a vanity URL). The `.well-known` fetch is a
      // fallback for a served page that predates the injection, kept behind
      // the same heuristic so a self-hosting developer who passes their own
      // origins never triggers it either.
      let hosted: HostedRuntime | null =
        typeof window !== 'undefined' ? readInjectedRuntime(window) : null;
      const reliesOnSlotEnvironment =
        !options.authBaseUrl &&
        !options.apiBaseUrl &&
        !options.wsBaseUrl &&
        !options.dashboardBaseUrl;
      if (typeof window !== 'undefined') {
        if (
          !hosted &&
          (isBrassHostedHost(window.location.hostname) || reliesOnSlotEnvironment)
        ) {
          hosted = await fetchHostedRuntime();
        }
        if (!hosted && !appId && isBrassHostedHost(window.location.hostname)) {
          throw new Error(
            'Brass.init could not load this hosted bundle\'s runtime config ' +
              `(${HOSTED_RUNTIME_PATH}). Deploy the bundle again from your app detail ` +
              'page in the Brass dashboard, or pass an app ID to Brass.init.',
          );
        }
      }
      const effectiveAppId = hosted ? hosted.appId : appId;
      if (!effectiveAppId) {
        throw new Error(
          'Brass.init requires an app ID. Get one from your app detail page in the Brass dashboard.',
        );
      }
      if (!APP_ID_PATTERN.test(effectiveAppId)) {
        // Catches pasting the README placeholder ('brass_app_...')
        // verbatim, or a prefix typo ('bras_app_...').
        throw new Error(
          `Brass.init received an app ID that does not look right (got: ${truncate(effectiveAppId)}). ` +
            `Expected 'brass_app_<id>' as shown on your app detail page in the dashboard.`,
        );
      }
      this.appId = effectiveAppId;
      const urls: ResolvedBaseUrls = hosted
        ? {
            authBaseUrl: hosted.authBaseUrl,
            apiBaseUrl: hosted.apiBaseUrl,
            apiBaseUrlConfigured: true,
            wsBaseUrl: hosted.wsBaseUrl,
            dashboardBaseUrl: hosted.dashboardBaseUrl,
          }
        : resolveBaseUrls(options);
      this.authBaseUrl = urls.authBaseUrl;
      this.apiBaseUrl = urls.apiBaseUrl;
      this.apiBaseUrlConfigured = urls.apiBaseUrlConfigured;
      this.wsBaseUrl = urls.wsBaseUrl;
      this._dashboardBaseUrl = urls.dashboardBaseUrl;
      if (options.openIncompatibleDocuments === true) {
        this.openIncompatibleDocuments = true;
      }
      if (options.hostedUiTheme) {
        this.hostedUiTheme = options.hostedUiTheme;
      }
      if (options.syncDocToUrl === false) {
        this.syncDocToUrl = false;
      }
      if (options.docUrlParam) {
        this.docUrlParam = options.docUrlParam;
      }
      if (options.branchUrlParam) {
        this.branchUrlParam = options.branchUrlParam;
      }
      if (options.syncDocToTitle === false) {
        this.syncDocToTitle = false;
      }
      this.initialized = true;
      if (typeof window !== 'undefined' && isExportMode(window.location.search)) {
        // Loaded by Brass purely to serialize a handed-in snapshot. Skip
        // the auth bootstrap entirely: the guest never calls the API, and
        // the cookie is third-party-partitioned in this framed context
        // anyway. The app's own `registerSerializer` (which it calls after
        // this init resolves) is forwarded to the guest.
        this.exportGuest = startExportGuest();
        if (this.serializer) this.exportGuest.setSerializer(this.serializer);
        return;
      }
      const guestToken =
        typeof window !== 'undefined'
          ? readGuestLinkToken(window.location.search)
          : null;
      if (guestToken) {
        // Anonymous "anyone with the link" open. The token IS the
        // credential, so there is no auth bootstrap: the session opens the
        // document read-only through it. `authStatus` reports `'guest'` and
        // the finally block's initial `onUserChange` emit drives the
        // read-only boot (the session's guest-aware handler calls start()).
        this.guestLinkTokenValue = guestToken;
        return;
      }
      await this.bootstrap();
      await this.hydrateProfile();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // console.error so the failure is visible in DevTools even when no
      // onError listener was registered. Prefixed for grep-ability.
      console.error('[Brass]', error.message);
      this.fireError(error);
      // Deliberately do not re-throw: callers using
      // `void Brass.init(...).then(setup)` should see .then() fire so the
      // page transitions out of its loading state. signIn() etc. continue
      // to throw "Call Brass.init(appId) first" because this.initialized
      // stays false on a validation failure.
    } finally {
      // Single source of truth for the first `onUserChange` emit.
      // `setTokens` inside bootstrap intentionally does not fire while
      // `bootstrapped` is false, so we get exactly one notification per
      // listener once init settles, whether validation rejected the
      // app_id, the refresh found no session, or the refresh resolved a
      // real user. An app that gates `#sign-in` on a single onUserChange
      // callback therefore sees one emit with the actual signed-in
      // state, not a transient `null` (a sign-in-button flicker) while
      // bootstrap is in flight.
      this.bootstrapped = true;
      // An export frame gets no emit. It holds no session and needs none
      // (the guest serializes a handed-in snapshot), so `null` here does not
      // mean the person is signed out, and an app that reads it as that
      // renders a signed-out UI or calls `signIn()`, which navigates the
      // frame away from the export it was loaded to run.
      if (this.exportGuest === null) {
        for (const listener of Array.from(this.listeners)) {
          listener(this.user);
        }
      }
    }
  }

  signIn(): void {
    const appId = this.requireAppId();
    if (typeof window === 'undefined') {
      throw new Error('Brass.signIn must be called in a browser');
    }
    // An export frame stays where it is. It runs a serializer over bytes
    // Brass handed it and never calls the API, so navigating to sign-in
    // would abandon the export mid-flight for a session it has no use for.
    if (this.exportGuest !== null) return;
    window.location.assign(buildSignInUrl(this.authBaseUrl, appId, window.location.href));
  }

  // Per-app sign-out. Revokes this app's server-side approval (subsequent
  // /refresh calls for this app return 401 even on cookie reuse), then makes
  // a top-level navigation to a Brass-hosted page that surfaces the email
  // the user is still signed in to Brass as, and offers a one-click "Sign
  // out of Brass too" link.
  //
  // The navigation is what closes the trust gap of "did sign-out actually
  // happen?"; the revocation rides the credentialed route because the page
  // answers whoever arrives at it and so writes nothing on arrival. The
  // decision to ALSO sign out of the platform belongs to the user, made on
  // the Brass-hosted page; the calling app cannot trigger platform-level
  // sign-out from its own UI.
  signOut(): void {
    const appId = this.requireAppId();
    if (typeof window === 'undefined') {
      throw new Error('Brass.signOut must be called in a browser');
    }
    // Read before the clears below drop it: where the cross-site cookie is
    // blocked, this pointer is the revocation's only credential.
    const credential: RefreshCredential = this.sessionToken
      ? { kind: 'sessionToken', sessionToken: this.sessionToken }
      : { kind: 'cookie' };
    // Fence any `/refresh` already on the wire: landing after the clears
    // below, it writes back the token set, the login hint and the session
    // pointer, and re-emits the signed-in user. The hint and the pointer
    // outlive the page, so that resurrects the session on the next load
    // too, and the navigation below can be delayed or cancelled.
    this.authEpoch += 1;
    this.setTokens(null);
    // Drop any fallback-mode credential too, so a stale session token
    // can't resurrect the session on the next getAccessToken(). Clear
    // both the in-memory copy and the sessionStorage mirror; without
    // the storage clear, a reload after sign-out would hydrate the
    // dead sid and the next refresh would 401 once before recovering.
    this.sessionToken = null;
    this.pendingAuthCode = null;
    clearSessionToken(appId);
    // Forget the login hint so the next cold load after sign-out renders
    // signed-out without probing /refresh.
    clearLoginHint(appId);
    // Clear the per-app selection-persistence layer so the next user
    // on this tab doesn't see the previous user's last selection.
    clearLastSelections(appId);
    const signedOutUrl = buildSignedOutOfAppUrl(this.authBaseUrl, appId, window.location.href);
    // On a Brass-hosted origin, route the sign-out through the edge's
    // /__brass/leave so the first-party brass_site gate cookie is cleared
    // on the way to the confirmation page. Harmless when the app is not
    // gated (the cookie simply isn't there). Off a hosted origin there is
    // no such cookie, so go straight to the confirmation page.
    const target = isBrassHostedHost(window.location.hostname)
      ? `${window.location.origin}/__brass/leave?return_to=${encodeURIComponent(signedOutUrl)}`
      : signedOutUrl;
    // Leave once the revocation settles, so the page reports a sign-out that
    // already happened rather than offering the button that finishes it.
    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      window.location.assign(target);
    };
    const deadline = setTimeout(leave, SIGN_OUT_REVOKE_DEADLINE_MS);
    void revokeAppApproval(this.authBaseUrl, appId, credential).then(() => {
      clearTimeout(deadline);
      leave();
    });
  }

  get currentUser(): BrassUser | null {
    return this.user;
  }

  // The tri-state auth lifecycle. `'unknown'` until `init` settles, then
  // `'signed-in'` / `'signed-out'`, tracking every later sign-in / out.
  // The explicit `'unknown'` is what lets an app render a neutral state
  // during bootstrap rather than defaulting a falsy `user` to the
  // sign-in CTA. Synchronous so a framework app can seed its initial
  // render from it.
  get authStatus(): AuthStatus {
    if (!this.bootstrapped) return 'unknown';
    if (this.guestLinkTokenValue !== null) return 'guest';
    return this.user !== null ? 'signed-in' : 'signed-out';
  }

  // The anonymous public-link token this page was opened with
  // (`?brass_link=`), or null on the ordinary signed-in path. Set during
  // `init` and read by the session to boot the read-only guest document.
  get isGuest(): boolean {
    return this.guestLinkTokenValue !== null;
  }

  // The resolved dashboard origin after `init` (the option's value if
  // provided; the SDK default otherwise), the origin the Hosted UI iframes
  // load from. Returns the default before `init` resolves; never null.
  // @internal
  get dashboardBaseUrl(): string {
    return this._dashboardBaseUrl;
  }

  onUserChange(listener: UserChangeListener): () => void {
    this.listeners.add(listener);
    // Only emit on subscribe once init has settled. Pre-init subscribers
    // (the canonical README pattern: register, then call init) get their
    // first emit from init's finally block with the resolved state, not
    // a flicker through the initial `null`. Post-init subscribers get an
    // immediate emit with the current value, the usual "register and
    // read current state" idiom.
    if (this.bootstrapped && this.exportGuest === null) {
      listener(this.user);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Subscribe to init failures. Fires synchronously inside init's catch
  // block when validation rejects an app_id, so a page can render an
  // error state instead of a silent loading spinner. Register BEFORE
  // calling init() to catch the first error.
  onError(listener: ErrorListener): () => void {
    return this.errorListeners.on(listener);
  }

  private fireError(error: Error): void {
    this.errorListeners.emit(error);
  }

  // The metadata + thumbnail namespace for a document the app already
  // holds an id for (`get` / `setThumbnail` / `getThumbnail`); the
  // editable surface stays on `Brass.openDocumentById` /
  // `Brass.createDocument`. Throws "Call Brass.init(appId) first" before
  // init.
  get documents(): DocumentsNamespace {
    return this.docsInternal();
  }

  // Builds (once) and returns the namespace with its internal methods,
  // for SDK plumbing that reaches past the public `documents` surface.
  private docsInternal(): DocumentsNamespace & DocumentsInternalNamespace {
    this.requireAppId();
    if (!this.documentsNamespace) {
      this.documentsNamespace = createDocumentsNamespace({
        apiBaseUrl: this.apiBaseUrl,
        getAccessToken: () => this.getAccessToken(),
        getAppAssertion: () => this.getAppAssertion(),
      });
    }
    return this.documentsNamespace;
  }

  // Unlike the other namespace getters this does NOT require `init`
  // first: `Brass.session.subscribe(render)` is meant to run BEFORE
  // `Brass.init(...)`, the same ordering `Brass.onUserChange`
  // supports. The session's methods keep their own init guards.
  get session(): DocumentSession {
    if (!this.documentSession) {
      this.documentSession = createDocumentSession({
        isSignedIn: () => this.user !== null,
        authStatus: () => this.authStatus,
        onUserChange: (listener) =>
          this.onUserChange((user) => listener(user !== null)),
        openDocumentById: (docId, options, consent) =>
          this.openDocumentInternal(docId, options, consent),
        guestLinkToken: () => this.guestLinkTokenValue,
        openDocumentByLink: (token, options) =>
          this.openByLinkInternal(token, options),
        createDocumentId: (args) => this.createDocumentIdWithConsent(args),
        selectDocument: () => this.selectDocumentInternal(),
        selectCreateDestination: (options) =>
          this.getHostedUiLauncher().selectCreateDestination(options),
        acquireOrganization: () =>
          this.getHostedUiLauncher().acquireOrganization(),
        documentHistory: (docId, options) =>
          this.documentHistory(docId, options),
        documentSettings: (docId, options) =>
          this.getHostedUiLauncher().documentSettings(docId, options),
        readUrlSelection: () =>
          this.syncDocToUrl
            ? readUrlSelection(this.docUrlParam, this.branchUrlParam)
            : null,
        // The redirect picker's one-shot return channel: consumed on boot
        // regardless of `syncDocToUrl` so a pick opens even when the app runs
        // its own selection.
        takePickSelection: () => takePickFromUrl(),
        writeUrlSelection: (selection, options) => {
          if (this.syncDocToUrl) {
            writeUrlSelection(
              selection,
              this.docUrlParam,
              this.branchUrlParam,
              options,
            );
          }
        },
        clearUrlSelection: () => {
          if (this.syncDocToUrl) {
            clearUrlSelection(this.docUrlParam, this.branchUrlParam);
          }
        },
        onUrlPopState: (cb) =>
          this.syncDocToUrl ? subscribePopState(cb) : () => {},
        setPageTitle: (name) => this.applyPageTitle(name),
        lastSelectedDocument: () => this.lastSelectedDocument(),
        // `this.documents` is read inside the closures, not here, so
        // its `requireAppId` guard runs only when the session
        // actually calls one of these (always post-init).
        documents: {
          get: (docId) => this.documents.get(docId),
          setThumbnail: (docId, input) =>
            this.documents.setThumbnail(docId, input),
        },
        reportError: (error) => this.fireError(error),
      });
    }
    return this.documentSession;
  }

  // SDK-rendered document toolbar. Renders the file menu, document
  // title, location, account menu, and presence roster into
  // `container`; the app fills the returned `tools` slot with its own
  // buttons.
  mountToolbar(
    container: HTMLElement,
    options?: SessionToolbarOptions,
  ): SessionToolbarHandle {
    return createSessionToolbar(container, this.toolbarDeps(), options);
  }

  // The bare header shell for an app that builds its own header but wants
  // the proven responsive layout: mount pieces into the returned
  // `start` / `tools` / `end` slots and the account avatar stays pinned
  // top-right on mobile, never wrapping when the tools wrap.
  mountHeader(container: HTMLElement): SessionHeaderHandle {
    return createSessionHeader(container, this.toolbarDeps());
  }

  // Composable header pieces. An app that builds its own shell drops
  // the standard account menu, presence roster, title, file menu, or
  // undo/redo into it without adopting the whole `mountToolbar` bar.
  // Each renders one cluster and returns `{ destroy(): void }`.
  mountFileMenu(container: HTMLElement): MountedPiece {
    return createFileMenu(container, this.toolbarDeps());
  }
  mountDocumentTitle(container: HTMLElement): MountedPiece {
    return createDocumentTitle(container, this.toolbarDeps());
  }
  mountUndoRedo(container: HTMLElement): MountedPiece {
    return createUndoRedo(container, this.toolbarDeps());
  }
  mountPresenceRoster(container: HTMLElement): MountedPiece {
    return createPresenceRoster(container, this.toolbarDeps());
  }
  mountDriveSync(container: HTMLElement): MountedPiece {
    return createDriveSync(container, this.toolbarDeps());
  }
  mountAccountMenu(container: HTMLElement): MountedPiece {
    return createAccountMenu(container, this.toolbarDeps());
  }
  // The historical-version preview banner (return-to-live during a hosted
  // `history` preview). The full toolbar and the header shell already include
  // it; this standalone mount is only for an app that builds fully custom
  // chrome and still wants the correct preview affordance.
  mountVersionPreview(container: HTMLElement): MountedPiece {
    return createVersionPreview(container, this.toolbarDeps());
  }

  // The capabilities every toolbar piece reads. The full bar and each
  // standalone piece take a subset of this one object.
  private toolbarDeps(): SessionToolbarDeps {
    return {
      session: this.session,
      getUser: () => this.currentUser,
      onUserChange: (listener) => this.onUserChange(listener),
      signIn: () => this.signIn(),
      signOut: () => this.signOut(),
      dashboardBaseUrl: this._dashboardBaseUrl,
      getDocument: (docId) => this.documents.get(docId),
      // The version-preview bar is a hosted embed; it takes the same theme
      // as the other hosted surfaces.
      hostedUiTheme: this.hostedUiTheme,
    };
  }

  // Opens the hosted document picker in a modal iframe and resolves with
  // the document the user picked or created (`null` if they dismissed it).
  // Where the iframe can't be hosted the picker redirects instead: the
  // page navigates away, so this call never resolves on that path, and the
  // pick opens into `Brass.session` on reload. So render the active
  // document from the session (as an app does anyway); the return value is
  // the modal path's inline convenience, correct whenever you receive it.
  // Throws before init.
  async selectDocument(): Promise<SelectDocumentResult | null> {
    const result = await this.selectDocumentInternal();
    if (result) this.maybeWriteDocIdToUrl(result.doc_id);
    return result;
  }

  // See `openDocumentInternal`: the picker path the session uses. It
  // persists the last selection but leaves the URL to the session,
  // which pushes a history entry once it opens the picked document.
  private async selectDocumentInternal(): Promise<SelectDocumentResult | null> {
    const appId = this.requireAppId();
    const result = await this.getHostedUiLauncher().selectDocument();
    if (result) storeLastDocument(appId, result);
    return result;
  }

  // The value the most recent `selectDocument()` resolved with
  // (per-app sessionStorage), or `null` if nothing was picked this
  // tab. The session's boot restore reads it as the bare-URL
  // fallback. Cleared on `signOut()`.
  private lastSelectedDocument(): SelectDocumentResult | null {
    return readLastDocument(this.requireAppId());
  }

  // Opens the hosted multi-tier share dialog (document / project /
  // organization sections in one UI) focused on the given document.
  // Fire-and-forget, iframe-first with redirect fallback. Throws "Call
  // Brass.init(appId) first" before init.
  shareDocument(docId: string): Promise<void> {
    return this.getHostedUiLauncher().shareDocument(docId);
  }

  // The hosted document history modal for one document. Pass `branch`
  // to scope the timeline to a branch; omit for the default. Resolves
  // with a `DocumentHistoryResult` (`{ branch_id }` for a forked
  // branch, `{ branch_id, version }` for a read-only past version) or
  // `null` if the user closed without doing either. Rejects with
  // `BrassError` when the iframe cannot be hosted. Throws "Call
  // Brass.init(appId) first" before init.
  documentHistory(
    docId: string,
    options?: { branch?: string },
  ): Promise<DocumentHistoryResult | null> {
    return this.getHostedUiLauncher().documentHistory(docId, options);
  }

  private getHostedUiLauncher(): HostedUiLauncher {
    const appId = this.requireAppId();
    if (!this.hostedUiLauncher) {
      this.hostedUiLauncher = createHostedUiLauncher({
        dashboardBaseUrl: this._dashboardBaseUrl,
        callingAppId: appId,
        theme: this.hostedUiTheme,
        serializeForExport: (docId) => this.serializeForExport(docId),
        // The hosted delete surface reports a local delete over the bridge so
        // the session returns to the empty state on the user's own delete,
        // rather than the remote-eviction error surface that keeps the URL.
        onLocalDelete: (docId, active) => {
          if (active) this.session._noteLocalDelete(docId);
          else this.session._clearLocalDelete(docId);
        },
        // Name the user this app is acting as, so the embed can refuse to
        // act as anyone else. The embed authenticates from the dashboard
        // origin's platform-session cookie, which moves when a second
        // account signs in on another tab, while this app keeps serving the
        // token it already holds.
        getActingSub: () => this.currentUser?.sub ?? null,
        // The embed resolved a different user, which means this app's token
        // is the stale half. Re-authenticate so the SDK reflects the session
        // the browser actually has (signed out, when this app is not
        // approved on it) instead of rendering a user who has been replaced.
        // The user asked, from the refusal surface, to put this app on the
        // account the browser holds. `signIn()` navigates to the hosted
        // sign-in for this app, which lands on the consent screen for that
        // account.
        onSignInRequested: () => {
          this.signIn();
        },
        // The picker falls back to a full-page redirect where the iframe
        // can't be hosted, returning the pick on these one-shot params, which
        // the session consumes on boot. Independent of `syncDocToUrl`: the
        // hand-off params are the SDK's own, not the app's selection sync, so
        // the fallback works even for an app that manages its own URL.
        pickReturn: { docParam: PICK_DOC_PARAM, branchParam: PICK_BRANCH_PARAM },
      });
    }
    return this.hostedUiLauncher;
  }

  // Returns a fully editable `Document`. Throws "Call Brass.init(appId)
  // first" before init.
  //
  // Editing requires `wsBaseUrl` in `Brass.init` options. When it's
  // absent, the returned Document still materialises against the
  // snapshot (HTTP path works) and `mutate` still updates local state,
  // but the local op never ships to the server. We do not throw in
  // that case because the HTTP join path stays useful for read-mostly
  // tools (admin viewers, migration scripts); the on-error signal is
  // observable via `Brass.onError` if the caller wants to surface
  // "live editing unavailable" in the UI.
  async openDocumentById(
    docId: string,
    options?: OpenDocumentByIdOptions,
  ): Promise<OpenedDocument> {
    const opened = await this.openDocumentInternal(docId, options);
    // The URL names the document the reader is looking at, and the session
    // owns that whenever it holds one: this open is detached, so claiming the
    // URL would leave the address bar naming a document the session is not
    // showing, and a reload would swap the reader onto it. An app with no
    // session document still gets the sync, which is the read-mostly caller
    // this method exists for.
    if (this.session.document === null) this.maybeWriteDocIdToUrl(opened.id);
    return opened;
  }

  // Open a document READ-ONLY from a public-link token (the "anyone with
  // the link" anonymous path). No sign-in: the token is the credential and
  // the server serves a read-only, member-stripped snapshot with no live
  // subscription. `Brass.session` drives this from the URL on boot when the
  // page carries `?brass_link=`.
  private async openByLinkInternal(
    token: string,
    options?: OpenDocumentByIdOptions,
  ): Promise<OpenedDocument> {
    const factory = this.getDocumentFactory();
    const opened = await factory.openByLink(token, options);
    this.trackOpenDocument(opened);
    return opened;
  }

  // The open path shared by the public `openDocumentById` and the
  // session. It does NOT write the URL: the public method pins the id
  // (`replaceState`) for direct multi-doc callers, while the session
  // owns its own push / replace history writes so a single-doc open
  // becomes a back-navigable entry without the two layers double-writing.
  private async openDocumentInternal(
    docId: string,
    options?: OpenDocumentByIdOptions,
    consent: 'offer' | 'skip' = 'offer',
  ): Promise<OpenedDocument> {
    const factory = this.getDocumentFactory();
    // After getDocumentFactory() resolves, requireAppId() has run and
    // this.appId is a string.
    const appId = this.appId as string;
    // An app that declared it opens these carries the answer on every open,
    // so nothing is asked and nothing is refused.
    const withConsent: OpenDocumentByIdOptions | undefined = this
      .openIncompatibleDocuments
      ? { ...options, acceptSchemaConflict: true }
      : options;
    try {
      const opened = await factory.open(docId, withConsent);
      this.trackOpenDocument(opened);
      return opened;
    } catch (err) {
      // The platform refuses to join a document this app's schema cannot
      // read. Unlike the install consent below, this one is offered on a
      // BACKGROUND open too: a bookmark, a reload and a restored session are
      // exactly the paths that reach an open having asked nobody, and they
      // are what the refusal exists for.
      if (isSchemaConflict(err)) {
        const { openAnyway } = await askSchemaConflict(err.message, err.title);
        if (!openAnyway) throw err;
        const opened = await factory.open(docId, {
          ...withConsent,
          acceptSchemaConflict: true,
        });
        this.trackOpenDocument(opened);
        return opened;
      }
      // A denial because the document's org has no install of this app
      // is a consent moment, not a stale selection: surface the hosted
      // install dialog so the person decides (install, or send the
      // admin request), then retry once if an install landed. Only for
      // an open the person initiated: the session's background opens
      // (boot restore, history navigation) pass `consent: 'skip'`
      // because a consent dialog nobody asked for pops over the app
      // before they touch anything.
      if (consent === 'offer' && (await this.offerInstallConsent(err))) {
        const opened = await factory.open(docId, options);
        this.trackOpenDocument(opened);
        return opened;
      }
      if (isAppNotInstalled(err)) throw err;
      // Self-heal the selection-persistence layer when the persisted
      // doc has gone stale (deleted, access revoked, or never owned by
      // this user). Without this an app that restores from
      // `lastSelectedDocument()` on boot would loop on the same
      // failure across every subsequent reload until the user picks a
      // new doc by hand. 403 / 404 are the unambiguously-stale cases;
      // 401 (not signed in) and 5xx (transient) are left alone. The URL's
      // `?doc=` id is deliberately NOT cleared here: the session parks in
      // its 'error' state on a failed open, and that error surface belongs
      // to the id the URL names, so stripping it would strand the failure
      // (a reload would forget the doc) and lose the id a user needs to
      // copy when requesting access. `lastSelectedDocument` is a private
      // convenience with no such visible anchor, so clearing it is safe.
      if (
        err instanceof BrassError &&
        (err.status === 403 || err.status === 404)
      ) {
        const last = readLastDocument(appId);
        if (last && last.doc_id === docId) {
          clearLastSelections(appId);
        }
      }
      throw err;
    }
  }

  async createDocument(options?: CreateDocumentOptions): Promise<OpenedDocument> {
    const opened = await this.createDocumentInternal(options);
    this.maybeWriteDocIdToUrl(opened.id);
    return opened;
  }

  // See `openDocumentInternal`: the create path the session uses, which
  // leaves the URL to the session's own history writes.
  private async createDocumentInternal(
    options?: CreateDocumentOptions,
  ): Promise<OpenedDocument> {
    const factory = this.getDocumentFactory();
    try {
      const opened = await factory.create(options);
      this.trackOpenDocument(opened);
      return opened;
    } catch (err) {
      if (await this.offerInstallConsent(err)) {
        const opened = await factory.create(options);
        this.trackOpenDocument(opened);
        return opened;
      }
      throw err;
    }
  }

  // Create-only for the session: classify the outcome (created / needs a
  // destination / needs an organization) so the session drives the picker /
  // acquire surface itself. An `app_not_installed` denial on the resolved
  // org opens the install-consent dialog and retries once, the same reactive
  // install the open / low-level-create paths get.
  private async createDocumentIdWithConsent(
    args: CreateDocumentArgs,
  ): Promise<CreateDocumentResult> {
    const factory = this.getDocumentFactory();
    try {
      return await factory.createDocumentId(args);
    } catch (err) {
      if (await this.offerInstallConsent(err)) {
        return factory.createDocumentId(args);
      }
      throw err;
    }
  }

  // The `app_not_installed` denial names the org; open the hosted
  // install-consent dialog for it so the person decides: an admin (or a
  // member of an `open`-policy org) installs, a member under `request`
  // sends the admin request from the same dialog. Nothing is installed
  // or requested implicitly. Resolves true only when an install landed,
  // in which case the caller retries the denied call once.
  private async offerInstallConsent(err: unknown): Promise<boolean> {
    if (!isAppNotInstalled(err) || !err.organizationId) return false;
    try {
      const result = await this.getHostedUiLauncher().installApp(
        err.organizationId,
      );
      return result !== null;
    } catch {
      // Hosted UI unavailable here (no DOM, or the dialog failed); the
      // original denial stands.
      return false;
    }
  }

  // Register the app's export backend. The platform calls it when a
  // hosted surface downloads an app-owned (blob) document: it receives
  // the open Document and returns the source file's bytes, the inverse of
  // the parse the app ran on `doc.sourceBlob()`. The app never invokes it
  // and never delivers the bytes itself; the platform stages + downloads
  // what it returns. One serializer per app.
  registerSerializer(serializer: DocumentSerializer): void {
    this.serializer = serializer;
    // In export-mode the guest may already hold the snapshot, waiting on
    // this registration to run it.
    this.exportGuest?.setSerializer(serializer);
  }

  // Register the app's import backend: parses a stored source file into
  // the document's records. The SDK claims the import with the platform
  // on each open, so exactly one client runs it; the other open clients
  // receive the records live. One importer per app; a later registration
  // replaces the earlier. Documents already open (registration raced the
  // first open) get their attempt here.
  registerImporter(importer: DocumentImporter): void {
    this.importRunner.setImporter(importer);
    if (this.guestLinkTokenValue !== null) return;
    for (const doc of this.liveOpenDocuments()) {
      void this.importRunner.attempt(doc);
    }
  }

  // Track an opened document so an export request can resolve its id to
  // the live Document. A re-open overwrites.
  private trackOpenDocument(doc: OpenedDocument): void {
    this.openDocuments.set(doc.id, doc);
    doc.onGone(() => {
      if (this.openDocuments.get(doc.id) === doc) {
        this.openDocuments.delete(doc.id);
      }
    });
    // Every open path funnels through here, so this is where a registered
    // importer gets its per-document attempt. A guest open is read-only
    // with no API credential, so no import runs for it.
    if (this.guestLinkTokenValue === null) {
      void this.importRunner.attempt(doc);
    }
  }

  // The tracked documents still open, dropping the rest as it goes.
  // `onGone` covers only a server-side eviction, and two ordinary paths
  // retire a Document without one: an app's `close()` (which parks it, so
  // the public surface throws while the instance lives on in the park
  // cache) and that cache's LRU eviction (a full teardown, no listener
  // left to fire). Reading through this is what keeps a retired wrapper
  // out of an answer, and what keeps the set from growing for the life of
  // the page.
  private liveOpenDocuments(): Document[] {
    const live: Document[] = [];
    for (const [docId, doc] of this.openDocuments) {
      if (doc._isLive) live.push(doc);
      else this.openDocuments.delete(docId);
    }
    return live;
  }

  private liveOpenDocument(docId: string): Document | null {
    const doc = this.openDocuments.get(docId);
    if (!doc) return null;
    if (doc._isLive) return doc;
    this.openDocuments.delete(docId);
    return null;
  }

  // Publish a document to a drive, supplying the bytes when the platform has
  // no writer for it.
  //
  // Where the export of this document runs in THIS app, the SDK runs the
  // registered serializer in process and the push carries its bytes, rather
  // than sending the reader through the hosted export frame. That is what
  // makes a publish from inside an app one click, and it is the same on the
  // publish that creates the drive file and on every push after it: the
  // caller's own app either writes this document or it does not.
  //
  // Everything else is the route's, including refusing bytes from an app the
  // exporter setting does not name, which it does by name rather than the
  // client predicting it.
  private async pushDocumentToDrive(
    doc: Document,
    input: PushToDriveInput,
  ): Promise<PushToDriveResult> {
    const docId = doc.id;
    if (docId === null || !doc._exportRunsHere) {
      return await this.docsInternal().pushToDrive(doc, input);
    }
    const serialized = await this.serializeForExport(docId);
    if (!serialized.ok) {
      throw new BrassError(
        `This app could not write the document out to publish it: ${serialized.message}`,
        { status: 400 },
      );
    }
    return await this.docsInternal().pushToDrive(doc, {
      ...input,
      bytes: serialized.bytes,
    });
  }

  // Run the registered serializer for an export request from a hosted
  // surface. Resolves the doc from the open set (the active session doc is
  // the fallback for an app that drives it through the session), then hands
  // it to the serializer. A missing serializer is the ordinary "this app
  // does not export" outcome, not an error. A document the app has closed
  // reports `no_document`: running the serializer against it would throw
  // out of the app's own record reads and report `serializer_failed`, which
  // names the app's code for a state the platform is holding.
  private async serializeForExport(docId: string): Promise<ExportSerializeOutcome> {
    if (!this.serializer) {
      return { ok: false, code: 'no_serializer', message: 'No serializer registered.' };
    }
    const sessionDoc = this.documentSession?.document ?? null;
    const doc =
      this.liveOpenDocument(docId) ??
      (sessionDoc && sessionDoc.id === docId && sessionDoc._isLive ? sessionDoc : null);
    if (!doc) {
      return { ok: false, code: 'no_document', message: 'Document is not open.' };
    }
    try {
      // A serializer runs detached, with no subscription to have been fed by,
      // and it needs the document once, so it is handed the containers whole
      // (`StoredDocument`) rather than the fed surface an app holds.
      const bytes = await this.serializer(doc as StoredDocument & Document);
      return { ok: true, bytes };
    } catch (err) {
      return {
        ok: false,
        code: 'serializer_failed',
        message: err instanceof Error ? err.message : 'Serializer failed.',
      };
    }
  }

  private maybeWriteDocIdToUrl(docId: string): void {
    if (!this.syncDocToUrl) return;
    writeDocIdToUrl(docId, this.docUrlParam);
  }

  // Set the page title to the active document's name, suffixed with the app
  // name (`Doc · App`), or restore the page's original title when no document
  // is open. Gated by `syncDocToTitle`. The original title is captured on the
  // first sync so close / sign-out can put it back rather than leaving a stale
  // doc name in the tab, and it doubles as the app-name suffix (see
  // `composePageTitle`).
  private applyPageTitle(name: string | null): void {
    if (!this.syncDocToTitle) return;
    if (typeof document === 'undefined') return;
    if (this.originalPageTitle === null) {
      this.originalPageTitle = document.title;
    }
    setPageTitle(composePageTitle(name, this.originalPageTitle));
  }

  private getDocumentFactory(): DocumentFactory {
    const appId = this.requireAppId();
    if (!this.documentFactory) {
      const wsClient = this.getDocWsClient(appId);
      const docsNs = this.documents;
      // Internal-typed handle for the methods on the internal namespace
      // (createCheckpoint, listBranches / createBranch, pushToDrive).
      // The getter above initialized the field, so it is non-null here.
      const docsInternal = this.documentsNamespace!;
      this.documentFactory = createOpenDocument({
        appId,
        apiBaseUrl: this.apiBaseUrl,
        getAccessToken: () => this.getAccessToken(),
        getAppAssertion: () => this.getAppAssertion(),
        identity: () => this.user?.sub ?? null,
        ...(wsClient ? { wsClient } : {}),
        branchProvider: {
          list: (docId) => docsInternal.listBranches(docId),
          create: (docId, input) => docsInternal.createBranch(docId, input),
        },
        streamProvider: {
          list: (docId, branchId) => docsInternal.listStreams(docId, branchId),
          // Forward ALL create params. A narrower-arity lambda type-checks,
          // so a wrapper that pinches off a param reaches the
          // wire unstamped while each layer's own tests stay green.
          create: (docId, branchId, name) =>
            docsInternal.createStream(docId, branchId, name),
        },
        thumbnailUploader: (doc, image, width, height) =>
          docsNs.setThumbnail(doc, { image, width, height }),
        checkpointCreator: (doc) => docsInternal.createCheckpoint(doc),
        drivePusher: (doc, input) => this.pushDocumentToDrive(doc, input),
        sourceBlobFetcher: (doc) => docsInternal.sourceBlob(doc),
        hostedUiProvider: {
          documentHistory: (docId, options) =>
            this.documentHistory(docId, options),
          documentSettings: (docId, options) =>
            this.getHostedUiLauncher().documentSettings(docId, options),
          refreshName: async (docId) => {
            try {
              const record = await docsNs.get(docId);
              return record.name;
            } catch {
              return null;
            }
          },
          // Whether the share command's label names a download. The
          // server resolves it from the apps installed on the document's
          // organization, so this is a read rather than anything the SDK
          // can work out from the open document. A failed read answers
          // `null` (could not tell) rather than `false`, which is what
          // lets the label try again later.
          documentDownloadable: async (docId) => {
            try {
              const record = await docsNs.get(docId);
              return record.downloadable === true;
            } catch {
              return null;
            }
          },
          // The doc's `history` built-in delegates cross-branch /
          // fork outcomes here. Routing through the session keeps
          // the active-doc swap consistent (URL sync, command list
          // re-render, branch-list refresh on the new doc).
          openSiblingDoc: async (docId, options) => {
            await this.session.open(docId, options);
          },
          selectBranch: (docId, options) =>
            this.getHostedUiLauncher().selectBranch(docId, options),
          // `doc.resolveDrive()` opens the hosted resolution surface;
          // a take-source / keep-both outcome re-opens onto the new
          // mirror doc through `openSiblingDoc` above.
          driveResolve: (docId) =>
            this.getHostedUiLauncher().driveResolve(docId),
          // Zero-org fallback for a no-arg `createDocument`: open the
          // hosted acquire-organization surface so an app-only caller
          // picks how to get their first org, then the create retries
          // against it.
          acquireOrganization: () =>
            this.getHostedUiLauncher().acquireOrganization(),
        },
        launchOrganizationId: () => this.launchOrganizationId,
        reportError: (err) => this.fireError(err),
      });
    }
    return this.documentFactory;
  }

  private getDocWsClient(appId: string): BrassWsClient | undefined {
    if (!this.wsBaseUrl) return undefined;
    if (this.docWsClient) return this.docWsClient;
    this.docWsClient = new BrassWsClient({
      wsBaseUrl: this.wsBaseUrl,
      appId,
      getAccessToken: () => this.getAccessToken(),
      // Anonymous link guest: with no access token the socket connects with
      // this link token and the server admits a read-only doc subscription.
      getGuestLinkToken: () => this.guestLinkTokenValue,
      // Attests the socket with the same assertion the HTTP calls carry so
      // the server enforces Layer 2 on op-write; a first-party client
      // resolves null here and connects un-gated.
      getAppAssertion: () => this.getAppAssertion(),
      fireError: (error) => this.fireError(error),
    });
    return this.docWsClient;
  }

  // Resolves null only when the server answered that this app has no live
  // session, and rejects with a 503 `BrassError` when a `/refresh` found no
  // answer at all. The two outcomes drive opposite handling: null is the
  // signed-out state a caller renders a sign-in CTA for, where a rejection
  // is a momentary outage the caller retries. Collapsing them into null
  // reports a 401-shaped "Not signed in" to a signed-in user whose network
  // blipped, and hides the transient from every layer that self-heals on it.
  async getAccessToken(): Promise<string | null> {
    this.requireInit();
    // On a `?brass_link=` page the link token is the credential and `init`
    // runs no auth bootstrap, so answer null rather than probing /refresh.
    // A visitor with no session would draw a 401 the browser logs; one who
    // holds a session for this app would get a real token, and a caller
    // that prefers a token over the link token (the socket does) would then
    // present membership where the page's whole authority is the link.
    if (this.guestLinkTokenValue !== null) return null;
    const current = this.tokens;
    if (current && current.expiresAt - REFRESH_LEEWAY_MS > Date.now()) {
      return current.accessToken;
    }
    const settled = await this.refresh();
    if (settled.status === 'unavailable') throw refreshUnavailableError();
    return settled.status === 'ok' ? settled.tokens.accessToken : null;
  }

  // The acting-app assertion paired with the current access token, or
  // null when the proxy issued none. Mirrors `getAccessToken`'s
  // freshness check so the two stay in lockstep: a request builder that
  // calls `getAccessToken()` then this reads the same (possibly just
  // refreshed) token set without forcing a second refresh. Rejects on a
  // transient outage for the same reason `getAccessToken` does.
  async getAppAssertion(): Promise<string | null> {
    this.requireInit();
    // Paired with `getAccessToken`: a link guest holds no token to assert
    // an acting app against, and reaching /refresh here would authenticate
    // the page the same way.
    if (this.guestLinkTokenValue !== null) return null;
    const current = this.tokens;
    if (current && current.expiresAt - REFRESH_LEEWAY_MS > Date.now()) {
      return current.appAssertion ?? null;
    }
    const settled = await this.refresh();
    if (settled.status === 'unavailable') throw refreshUnavailableError();
    return settled.status === 'ok' ? (settled.tokens.appAssertion ?? null) : null;
  }

  private async bootstrap(): Promise<void> {
    if (typeof window === 'undefined') return;
    const appId = this.requireAppId();
    // Every successful sign-in 302s back to return_to with the
    // platform-session cookie set AND a one-time `brass_code` query
    // parameter. The cookie
    // is the primary channel; the code is the incognito / Safari ITP /
    // post-third-party-cookie fallback for when the browser drops the
    // cross-site cookie on our /refresh XHR.
    //
    // Pull the code off the URL immediately (before any /refresh)
    // and strip it via history.replaceState so it never lingers in the
    // address bar, browser history, or a referrer header. It is held in
    // memory and consumed at most once, only if the cookie refresh
    // turns out to fail (see refresh()).
    //
    // No app-controlled silent-mint path: the SDK never auto-fires
    // Brass.signIn() based on a URL hint. New app approvals always
    // require an explicit click on the auth-hosted picker.
    // Same treatment for the launching organization: read it off the URL
    // and strip it here, so a client-side navigation later in the session
    // cannot lose it and the address bar stays the app's own.
    this.launchOrganizationId = consumeLaunchOrganizationId();
    this.pendingAuthCode = consumeAuthCodeParam();
    if (this.pendingAuthCode) {
      // A fresh sign-in just landed. Burn any previously-stored
      // session_token so a stale one (different account, server-side
      // revoke between tabs) cannot preempt the fresh code. The new
      // code's exchange in refresh() will overwrite this with its own.
      clearSessionToken(appId);
      // Record the login hint optimistically: a code on the URL means a
      // sign-in just happened, so a session exists. Writing it now (not
      // only after the refresh resolves) closes the window where an app
      // does a client-side navigation immediately after sign-in: the
      // re-bootstrapped page then still has a reason to probe. If the
      // code exchange ultimately fails, refresh() clears the hint again.
      storeLoginHint(appId);
    } else {
      // No fresh code on the URL. Hydrate the fallback session_token
      // from a prior run on this tab so a reload in a cookie-blocked
      // browser keeps the user signed in. Null in the common (cookie-
      // works) case where the fallback path never ran, in which case
      // refresh() still tries the cookie channel first.
      this.sessionToken = readSessionToken(appId);
    }
    // Probe /refresh only when there's a positive reason to believe a
    // session exists: a fresh sign-in code just landed, a hydrated
    // fallback session token, or a stored login hint from a prior
    // successful auth on this app. The platform-session cookie is
    // httpOnly + cross-site, so the SDK cannot read it to know, and
    // POSTing /refresh blindly for a signed-out or not-yet-approved
    // visitor returns a 401 the browser logs to the console even though
    // we handle it. With none of these signals, treat the user as
    // signed-out: no network call, no console error. A returning,
    // approved user still gets a silent restore (the hint persists in
    // localStorage), and a new-app visitor signs in with the same
    // explicit click as before (which lands a brass_code and probes).
    if (
      this.pendingAuthCode !== null ||
      this.sessionToken !== null ||
      readLoginHint(appId)
    ) {
      await this.refresh();
    }
    // The code is a landing credential, so it expires with the landing. Past
    // bootstrap it is a pointer to the session that was live when this page
    // loaded, and the browser can since have moved to another one (a second
    // account signed in on another tab). A later refresh falling through to
    // it would re-authenticate this app as the account the browser has left,
    // and pin that account's `sid` for the tab, so the app would keep acting
    // as someone this browser can no longer reach.
    this.pendingAuthCode = null;
  }

  private async refresh(): Promise<RefreshSettlement> {
    if (this.inflightRefresh) return this.inflightRefresh;
    const appId = this.requireAppId();
    const epoch = this.authEpoch;
    this.inflightRefresh = (async (): Promise<RefreshSettlement> => {
      const outcome = await this.runRefresh(appId);
      // No answer means no change: the token set, the login hint, and any
      // fallback session token stay as they are, and a later attempt settles
      // the session.
      if (outcome.status === 'unavailable') return { status: 'unavailable' };
      // A sign-out landed while this round-trip was in flight, so whatever
      // it resolved belongs to a session the person has left. Report it as
      // no session and write nothing: the caller waiting on this token gets
      // the signed-out answer the sign-out established.
      if (this.authEpoch !== epoch) return { status: 'no_session' };
      const result = outcome.status === 'ok' ? outcome.result : null;
      this.setTokens(result?.tokens ?? null);
      // Remember whether a live session exists for this app so the next
      // cold load knows whether to probe /refresh (see bootstrap). A
      // success proves a session; `no_session` is the server saying there
      // is none, so drop the hint and the next signed-out load stays silent.
      if (result) {
        storeLoginHint(appId);
      } else {
        clearLoginHint(appId);
      }
      if (result?.sessionToken) {
        this.sessionToken = result.sessionToken;
        // Mirror into sessionStorage so a reload on this tab can
        // hydrate it (the cookie channel is unavailable in this
        // browser by construction; we only get here via the code or
        // sid channels). The pointer is bound to this app id, so what
        // is stored authenticates this app and nothing else.
        storeSessionToken(appId, result.sessionToken);
      }
      return result ? { status: 'ok', tokens: result.tokens } : { status: 'no_session' };
    })().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  // Picks the credential channel for a single /refresh round-trip. The
  // cookie path is primary and untouched for browsers that send the
  // third-party cookie; the one-time code is consumed only when that
  // cookie path resolved no session. Once a fallback session
  // token is in hand (the cross-site cookie is proven unavailable for
  // this page's life), every later refresh uses it directly.
  //
  // A rung falls through to the next only on `no_session`. Each one discards
  // a credential as it passes (the stale sid, the one-time code), and an
  // `unavailable` says nothing about the credential it just tried.
  private async runRefresh(appId: string): Promise<RefreshOutcome> {
    if (this.sessionToken) {
      const viaSession = await refreshTokens(this.authBaseUrl, appId, {
        kind: 'sessionToken',
        sessionToken: this.sessionToken,
      });
      if (viaSession.status !== 'no_session') return viaSession;
      // Stored sid is stale (server-side revoke, row expiry). Drop both
      // the in-memory copy and the sessionStorage mirror, then fall
      // through to the cookie / code paths. Without this, a hydrated-
      // but-dead sid would block every refresh for the rest of the
      // tab's life even when the cookie or a landed `brass_code` could
      // recover the session.
      this.sessionToken = null;
      clearSessionToken(appId);
    }
    const viaCookie = await refreshTokens(this.authBaseUrl, appId);
    if (viaCookie.status !== 'no_session') return viaCookie;
    // Cookie channel resolved no session. Fall back to the one-time code if
    // we landed with one. Clear it first: it is single-use server-side, so a
    // failed exchange must not be retried.
    const code = this.pendingAuthCode;
    if (!code) return viaCookie;
    this.pendingAuthCode = null;
    return refreshTokens(this.authBaseUrl, appId, { kind: 'code', code });
  }

  private setTokens(next: TokenSet | null): void {
    const nextUser = next ? decodeIdToken(next.idToken) : null;
    // A different person on this page. `/refresh` resolves whichever platform
    // session the browser holds, so the identity behind a page that never
    // navigated can become someone else's (another tab signs out and a second
    // person signs in). Run the retirement first, as its own transition, so
    // what the previous identity left open is retired before the new one is
    // announced rather than inherited by it.
    if (
      this.user !== null &&
      nextUser !== null &&
      this.user.sub !== nextUser.sub
    ) {
      this.setTokens(null);
    }
    this.tokens = next;
    if (sameUser(this.user, nextUser)) return;
    this.user = nextUser;
    // Suppress emits while init is still in flight: init's finally
    // block fires the single canonical emit once bootstrap settles.
    // Without this guard, a bootstrap that resolves a real user would
    // fire here (null -> user) AND fire again from init's finally
    // (the same user), double-emitting on every signed-in app load.
    if (!this.bootstrapped) return;
    // Copied before the walk: a listener that detaches another would otherwise
    // remove it before its turn, and a `Set` never visits such an entry.
    for (const listener of Array.from(this.listeners)) {
      listener(nextUser);
    }
    // After the listeners, because the session closes the active document as
    // it hears the sign-out and a close PARKS the Document. A parked Document
    // answers the next open of its key out of memory, with no token and no
    // request, so one left behind here is the previous person's document
    // handed to whoever signs in next.
    if (nextUser === null) clearParkedDocuments();
  }

  private async hydrateProfile(): Promise<void> {
    if (!this.user) return;
    if (!this.apiBaseUrlConfigured) return;
    const token = this.tokens?.accessToken;
    if (!token) return;
    try {
      const res = await fetch(
        `${this.apiBaseUrl}/users/${encodeURIComponent(this.user.sub)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return;
      const profile = (await res.json()) as {
        display_name?: string;
        avatar_url?: string;
      };
      if (this.user) {
        if (profile.display_name) this.user.display_name = profile.display_name;
        if (profile.avatar_url) this.user.avatar_url = profile.avatar_url;
      }
    } catch {
      // Profile hydration is best-effort; the app works without it.
    }
  }

  private requireInit(): void {
    if (!this.initialized) throw new Error('Call Brass.init(appId) first');
  }

  private requireAppId(): string {
    this.requireInit();
    if (!this.appId) throw new Error('Brass.init was called without an app ID');
    return this.appId;
  }
}

// Reads the one-time `brass_code` the auth proxy appended to return_to
// and strips it from the visible URL in the same tick. Returns null when
// there is no code (a hard reload, or a browser where the cookie channel
// works and the proxy's code went unused). Best-effort: any failure
// (exotic URL, history API unavailable) just yields null and the SDK
// falls back to the cookie-only path.
function consumeAuthCodeParam(): string | null {
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('brass_code');
    if (!code) return null;
    url.searchParams.delete('brass_code');
    window.history.replaceState(window.history.state, '', url.toString());
    return code;
  } catch {
    return null;
  }
}

function sameUser(a: BrassUser | null, b: BrassUser | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.sub === b.sub && a.email === b.email;
}

function truncate(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
}

function isSchemaConflict(err: unknown): err is BrassError {
  return err instanceof BrassError && err.code === 'schema_conflict';
}

function isAppNotInstalled(err: unknown): err is BrassError {
  return err instanceof BrassError && err.code === 'app_not_installed';
}
