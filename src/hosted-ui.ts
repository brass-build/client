// The hosted-UI launcher core.
//
// "Hosted UI" surfaces are Brass-owned pages (document picker, share dialog) a
// third-party app opens without building the UI. The app calls e.g.
// `Brass.selectDocument()`; this loads `${dashboardBaseUrl}/embed/<surface>`
// in a modal iframe, runs a postMessage handshake with the embed page's
// bridge, and resolves with whatever the user did.
//
// Iframe-first. When the iframe can't complete the handshake (CSP
// `frame-ancestors`, a partitioned third-party auth cookie, ...) the launcher
// falls back per surface:
//   - `reject`: throw `BrassError` `code: 'iframe_unavailable'`. Used by
//     value-returning launchers with nowhere else to send the user.
//   - `redirect`: navigate the top window to the standalone
//     `/embed/<surface>?...&return_to=<here>` page. Used by fire-and-forget
//     launchers; the returned promise never settles (the page is gone).
//   - `redirect-with-value`: the same navigation for a surface that still
//     owes the caller a value, which comes home on one-shot URL params (the
//     document picker).
//
// Bridge protocol (envelope `__brass_embed: 1`):
//   iframe -> host:  ready | resize{height} | result{payload} | cancel |
//                    error{code,message}
//   host -> iframe:  init{surface,params}
// The host validates `event.origin === dashboardOrigin` and
// `event.source === iframe.contentWindow` on every inbound message; the embed
// page learns the host origin from `init` and targets outbound at it (never
// `*`).

import { BrassError } from './errors.js';
import { EMBED_ENVELOPE, EMBED_PROTOCOL_VERSION } from './embed-protocol.js';

// No `ready` within this window means the iframe is unusable (CSP, origin
// unreachable, bridge threw). What the window is worth is set by what the
// fallback costs the user, not by which fallback runs.
//
// Only a plain `redirect` can afford the short window: the surface returns
// nothing, the standalone page finishes the same job, and the user keeps
// their place, so eating ten seconds of blank modal is the bigger cost.
//
// `reject` and `redirect-with-value` both end with the caller worse off (a
// thrown error, or the user navigated out of the host app with the value
// routed home through a URL round trip), so they wait long enough that only
// a genuinely unusable iframe times out. The embed page is a full
// application boot behind a cross-origin request, so a merely slow link
// clears the short window while the iframe is perfectly capable.
const READY_TIMEOUT_LONG_MS = 10_000;
const READY_TIMEOUT_SHORT_MS = 4_000;

// What a launcher does when the handshake never completes. See the timeout
// constants above for the window each one gets.
type UnavailableMode = 'reject' | 'redirect' | 'redirect-with-value';

// The embed page posts `resize` with its measured height; the host clamps to
// this range so a malformed or hostile height can't collapse the dialog or
// paint the whole viewport.
const INITIAL_IFRAME_HEIGHT = 480;
const MIN_IFRAME_HEIGHT = 160;
const MAX_IFRAME_HEIGHT = 760;

// Light/dark mode for the modal + embed page. Defaults to `'light'`: the
// dominant host is light-only (an app whose CSS ignores
// `prefers-color-scheme`), so the modal must render light regardless of OS
// preference. `'auto'` is the explicit opt-in for OS-following apps. Host apps
// that force a theme pass the matching value so the modal doesn't mismatch.
export type HostedUiTheme = 'light' | 'dark' | 'auto';

// Which aspect the hosted settings surface opens focused on. Intent, not
// layout: the hosted UI decides presentation (so dropping the tab bar needs
// no SDK change). `'details'` is name + location; `'share'` is the multi-tier
// share surface and the default (matches `shareDocument`); `'delete'` is
// soft-delete.
export type DocumentSettingsFocus = 'details' | 'share' | 'delete';

// Result of `Brass.selectDocument()`. `null` when dismissed. `project_id` is
// `string | null`: a "loose document" lives directly under an organization,
// so apps branching on project context must handle `null`. `role` is the
// caller's effective role, resolved via the scope-loop (an org-admin not
// granted the doc directly still surfaces as `owner`).
export interface SelectDocumentResult {
  doc_id: string;
  project_id: string | null;
  organization_id: string;
  role: 'owner' | 'editor' | 'viewer';
  name: string;
  created_at: string;
  updated_at: string;
  branch_id?: string;
}

// Result of the hosted create-destination dialog: where a new document goes,
// plus the chosen name. The dialog resolves a destination only; the SDK does
// the create itself so the app's credential path stamps `creating_app_id` and
// carries `app_metadata` / `documentOptions`. `project_id` is null for a loose
// document; `organization_id` is always the destination org.
export interface CreateDestinationResult {
  organization_id: string;
  project_id: string | null;
  name: string;
}

// Result of the hosted acquire-organization surface: the organization a
// zero-org caller ended up with, whether they created a private space,
// created an organization, or accepted a pending invite.
export interface AcquireOrganizationResult {
  organization_id: string;
}

// Result of the internal document-history launcher (opened by the
// session's `history` file-menu command). Three outcomes:
//   - `{ branch_id }`: forked a NEW branch; open editable with
//     `openDocumentById(docId, { branch: branch_id })`.
//   - `{ branch_id, version }`: opened an EXISTING point; open read-only with
//     `openDocumentById(docId, { branch: branch_id, version })`.
//   - `null`: reviewed and closed without forking or opening (a pin persists
//     server-side regardless, so pinning alone still resolves `null`).
export interface DocumentHistoryResult {
  // The branch: the new branch for a fork, the version's branch for a version
  // open. Pass it as `branch` to `openDocumentById`.
  branch_id: string;
  // Present only on a version open (not a fork). Pass alongside `branch_id`
  // for a read-only historical open.
  version?: number;
  // The reader asked to browse versions in the application itself rather
  // than pick one in the dialog, so the host shows its version bar over the
  // live document. Carries no `version`: browsing starts where the reader
  // already is.
  browse?: boolean;
}

// Result of the internal install-consent launcher (`offerInstallConsent`
// opens it when a create / open hits an `app_not_installed` denial): the
// install row the hosted consent UI minted. The row's `scopes` is the
// granted set the admin actually approved, which may differ from the
// calling app's `requested_scopes` (e.g. the admin downgraded one entry
// before confirming).
export interface InstallAppResult {
  organization_id: string;
  app_id: string;
  installed_by: string;
  installed_at: string;
  scopes: string[];
  app_name: string | null;
}

// Result of the `drive-resolve` surface (from `Document.resolveDrive()`):
// how a `behind` / `diverged` drive-linked doc was resolved. `null` when
// dismissed.
export interface DriveResolveResult {
  // The fresh mirror doc that took over the link (take-source / keep-both
  // re-import the remote into a new doc); `null` when publish-over resolved
  // in place.
  newDocId: string | null;
}

// Result of the `document-settings` surface. Present only when the user
// duplicated the document and chose to open the copy; the copy is its own
// document, so the dialog reports its id and the caller opens it.
export interface DocumentSettingsResult {
  newDocId: string;
}

// Result of running the app's serializer for an export. The host answers an
// embed page's `export-request` with the bytes or a failure reason.
// `no_serializer` is the ordinary "this app does not export" outcome; the
// rest are genuine failures.
export type ExportSerializeOutcome =
  | { ok: true; bytes: Uint8Array }
  | {
      ok: false;
      code: 'no_serializer' | 'no_document' | 'serializer_failed';
      message: string;
    };

export interface HostedUiLauncher {
  // Hosted document picker (single-selection, with an inline new-document
  // branch). Resolves with the chosen / created document or `null`.
  // Iframe-only with a `BrassError` reject (a returned value can't survive a
  // redirect fallback).
  selectDocument(): Promise<SelectDocumentResult | null>;
  // The document picker opened straight on its New panel to ask where a new
  // document goes. Used by `Brass.session.create()` when a cold create is
  // ambiguous across multiple orgs, so the user picks rather than the SDK
  // guessing. Resolves with the destination (the dialog does NOT create the
  // document) or `null`. Iframe-only, same rationale as `selectDocument`.
  selectCreateDestination(options?: {
    name?: string;
  }): Promise<CreateDestinationResult | null>;
  // Org-acquisition surface for a zero-org caller: create a private space,
  // create an org, or accept a pending invite. Used by `createDocument` when
  // implicit-org resolution finds no org. Resolves with the org or `null`.
  // Iframe-only with a `BrassError` reject (the caller needs the id back).
  acquireOrganization(): Promise<AcquireOrganizationResult | null>;
  // Hosted multi-tier share dialog: "This document" (direct grants), "This
  // project" (when present), "This organization", each with member list +
  // add-by-email + role; effective access shown read-only on top.
  // Fire-and-forget; iframe-first with redirect fallback.
  shareDocument(docId: string): Promise<void>;
  // Hosted document settings, absorbing Details / Share / Duplicate /
  // Delete for one document. Pass `focus` to open on an aspect; defaults to
  // `'share'` so `documentSettings(docId)` and `shareDocument(docId)`
  // resolve to the same surface. Resolves with a `DocumentSettingsResult`
  // when the user duplicated the document and asked to open the copy,
  // `null` otherwise. Same iframe-first, redirect-fallback lifecycle as
  // `shareDocument`, and the redirect arm resolves `null` (a navigated-away
  // page reports nothing).
  documentSettings(
    docId: string,
    options?: { focus?: DocumentSettingsFocus },
  ): Promise<DocumentSettingsResult | null>;
  // Hosted version-timeline modal (scrub, named pins, branch-from-a-version)
  // for one document. Pass `branch` to scope to a branch; omit for the
  // default. Resolves with a `DocumentHistoryResult` (`{ branch_id }` for a
  // fork, `{ branch_id, version }` for a version open,
  // `{ branch_id, browse: true }` to browse in the app, `null` otherwise).
  // Iframe-only with a `BrassError` reject, same rationale as
  // `selectDocument`.
  documentHistory(
    docId: string,
    options?: { branch?: string },
  ): Promise<DocumentHistoryResult | null>;
  selectBranch(
    docId: string,
    options?: { branch?: string },
  ): Promise<{ branch_id: string } | null>;
  // Hosted install-consent UI: the org admin reviews the requested scopes in
  // plain language and confirms / rejects; on confirm the backend writes the
  // `ORGANIZATION#/INSTALL#` row. Resolves with the row or `null` on cancel.
  // Iframe-only with a `BrassError` reject (the caller needs the row back).
  // `organizationId` optional: omit to let the user pick inside the dialog
  // (default selection is the only org, or the first by membership time).
  installApp(organizationId?: string): Promise<InstallAppResult | null>;
  // Hosted drive-divergence resolution (from `Document.resolveDrive()`):
  // publish over the source, take the source, or keep both. Take-source /
  // keep-both mint a fresh mirror doc (its id rides the result for the app to
  // switch onto); publish-over resolves in place (`newDocId: null`). Resolves
  // with the outcome or `null`. Iframe-only with a `BrassError` reject.
  driveResolve(docId: string): Promise<DriveResolveResult | null>;
}

export interface HostedUiLauncherOptions {
  // Origin the embed pages are served from. `Brass.init`'s `dashboardBaseUrl`,
  // defaulted by the client.
  dashboardBaseUrl: string;
  // Threaded into param payloads for surfaces that need it (`installApp`).
  // Every Brass app shares one sign-in client, so the JWT can't
  // disambiguate the asking app; the embed page reads `appId` off the bridge.
  // Optional so non-install fixtures can omit it.
  callingAppId?: string;
  // Pins the modal + embed page to a theme. Defaults to `'light'`; pass
  // `'auto'` to follow OS preference. Host apps that force a theme pass it so
  // the modal doesn't mismatch (the close button sits over the iframe and
  // goes invisible when chrome and content land on opposite sides).
  theme?: HostedUiTheme;
  // The export backend: a hosted Download asks the running app to serialise
  // its open doc; this runs the app's serializer for `docId`. Omitted by
  // fixtures that never export.
  serializeForExport?: (docId: string) => Promise<ExportSerializeOutcome>;
  // The hosted delete surface signals over the bridge that the local user is
  // deleting `docId` (`active: true`), or that the delete failed
  // (`active: false`, a retraction). The client routes this to the session so
  // the incoming `doc_gone` for the user's own delete returns to the empty
  // state instead of parking the remote-eviction error surface. Signalled
  // pre-flight, so the note beats the server's `doc_gone` frame.
  onLocalDelete?: (docId: string, active: boolean) => void;
  // The `sub` of the user this app is currently acting as, read at
  // dialog-open time and posted in the bridge `init`. The embed page
  // authenticates from the dashboard origin's own platform-session cookie,
  // which can name a different user than the token this app holds (a second
  // account signed in on another tab replaces the browser's session, and
  // this app keeps serving its cached token until it expires). Naming the
  // user here is what lets the embed refuse to act as anyone else.
  getActingSub?: () => string | null;
  // Called when the user takes the refusal surface's sign-in action. The
  // embed cannot run it: signing in inside the iframe authenticates that
  // frame, not the app around it, so the host navigates its own page to the
  // Brass sign-in for its app. A user gesture on the pinned dashboard origin
  // is the only thing that reaches this, so it does not open a path for an
  // app to trigger a sign-in on its own.
  onSignInRequested?: () => void;
  // The one-shot query params the picker's redirect fallback returns the pick
  // on. When set, the document picker degrades to a full-page redirect
  // instead of rejecting where the iframe can't be hosted: the standalone
  // picker navigates home with these params and the SDK consumes them on
  // boot. The SDK always sets this in production; a fixture that omits it
  // keeps the picker iframe-only (reject).
  pickReturn?: { docParam: string; branchParam: string };
}

interface EmbedOutcome {
  payload: unknown;
}

// Full-page fallback when the iframe can't be hosted: navigate the top
// window to the standalone embed page, threading the surface params plus a
// `return_to` so the standalone page can send the user home when done.
function redirectToStandalone(
  baseUrl: string,
  surface: string,
  params: Record<string, unknown>,
  theme: HostedUiTheme,
): void {
  const url = new URL(`${baseUrl}/embed/${surface}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set('return_to', window.location.href);
  // Thread the theme only when it overrides the `'light'` default, keeping the
  // URL stable for the no-config path (mirrors the iframe-src construction).
  if (theme !== 'light') {
    url.searchParams.set('theme', theme);
  }
  window.location.assign(url.toString());
}

// Resolved light/dark for the modal chrome. `'auto'` reads the host's
// `prefers-color-scheme` once on open; the embed page still receives the
// unresolved `'auto'` so its own rule keeps tracking OS preference.
function resolveChromeTheme(theme: HostedUiTheme): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme;
  const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
  return mql?.matches ? 'dark' : 'light';
}

interface ChromeTokens {
  backdrop: string;
  cardBackground: string;
  cardShadow: string;
  closeButtonColor: string;
  // Spinner colours for the loader that sits over the iframe until
  // the embed page's bridge handshake completes.
  spinnerTrack: string;
  spinnerAccent: string;
}

function chromeTokensFor(resolved: 'light' | 'dark'): ChromeTokens {
  if (resolved === 'dark') {
    return {
      backdrop: 'rgba(0, 0, 0, 0.65)',
      cardBackground: '#11141b',
      cardShadow: '0 20px 60px rgba(0, 0, 0, 0.55)',
      closeButtonColor: '#e7eaf0',
      spinnerTrack: 'rgba(231, 234, 240, 0.18)',
      spinnerAccent: '#e7eaf0',
    };
  }
  return {
    backdrop: 'rgba(15, 23, 42, 0.55)',
    cardBackground: '#fff',
    cardShadow: '0 20px 60px rgba(15, 23, 42, 0.35)',
    closeButtonColor: '#0f172a',
    spinnerTrack: 'rgba(15, 23, 42, 0.12)',
    spinnerAccent: '#0f172a',
  };
}

const CHROME_STYLE_ID = 'brass-hosted-ui-chrome';

// The chrome dims the page with the dialog element's own themed background, so
// the UA's `::backdrop` would stack a second, unthemed dim beneath it. A
// pseudo-element cannot be styled inline, which is why the chrome injects a
// stylesheet at all; everything else it paints is an inline style.
const CHROME_CSS = `dialog[data-brass-hosted-ui]::backdrop { background: transparent; }`;

function injectChromeStyles(doc: Document): void {
  if (doc.getElementById(CHROME_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = CHROME_STYLE_ID;
  style.textContent = CHROME_CSS;
  doc.head.appendChild(style);
}

// The control the reader last acted on, which is who a dismissed surface hands
// focus back to. `document.activeElement` when the launcher is called looks
// like the answer and is often `<body>` by then: a host that disables its
// trigger for the life of the dialog does so before calling, and disabling a
// focused control blurs it. Tracking the activation instead survives that.
let lastActivated: HTMLElement | null = null;
let trackingActivations = false;

const ACTIVATABLE =
  'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function trackActivation(event: Event): void {
  // Enter and Space are the keys that press a control; every other keystroke
  // is someone typing, and typing is not what a dialog returns focus to.
  if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') {
    return;
  }
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  lastActivated = target.closest<HTMLElement>(ACTIVATABLE) ?? target;
}

/**
 * Start recording which control the reader last pressed, so a dismissed
 * surface can hand the keyboard back to it. Idempotent.
 *
 * @internal
 */
export function trackHostedUiActivations(): void {
  if (trackingActivations || typeof document === 'undefined') return;
  trackingActivations = true;
  document.addEventListener('pointerdown', trackActivation, true);
  document.addEventListener('keydown', trackActivation, true);
}

// Who a dismissal should put the keyboard back on: whatever holds focus when
// the surface opens, or the last control the reader pressed when nothing does.
function resolveOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  return lastActivated;
}

// Opens `${baseUrl}/embed/<surface>` in a modal iframe and drives the bridge
// handshake. Resolves with the `result` payload or `null` on cancel; rejects
// on not-in-browser / embed error. On the ready timeout it rejects
// (`unavailable: 'reject'`) or redirects and never settles (the two
// `redirect` modes).
function openEmbed(
  baseUrl: string,
  dashboardOrigin: string,
  surface: string,
  params: Record<string, unknown>,
  unavailable: UnavailableMode,
  theme: HostedUiTheme,
  // Handles an `export-request`: serialise the surface's `docId` and post the
  // bytes back. Only the document surfaces (with a Download button) pass it.
  onExportRequest?: (docId: string) => Promise<ExportSerializeOutcome>,
  // Notified when the delete surface reports a local delete (or its
  // retraction) for a doc id, so the session can classify the matching
  // `doc_gone`. Only the document-settings / share surface emits it.
  onLocalDelete?: (docId: string, active: boolean) => void,
  // Notified when the user takes the refusal surface's sign-in action.
  onSignInRequested?: () => void,
): Promise<EmbedOutcome | null> {
  return new Promise<EmbedOutcome | null>((resolve, reject) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      reject(
        new BrassError('Hosted UI requires a browser environment.', {
          code: 'not_in_browser',
        }),
      );
      return;
    }

    const resolvedChrome = resolveChromeTheme(theme);
    const tokens = chromeTokensFor(resolvedChrome);

    injectChromeStyles(document);

    // A `<dialog>` opened with `showModal()` (below), which is what makes the
    // host page inert while the surface is up: the reader tabs around the
    // dialog instead of through the app behind it, and the browser enforces
    // that rather than a key handler here. The UA box styles for a dialog (a
    // content-sized, centered, bordered, padded box with a max-width) are all
    // wrong for a full-viewport backdrop, so each is zeroed.
    const overlay = document.createElement('dialog');
    overlay.setAttribute('data-brass-hosted-ui', surface);
    overlay.setAttribute('data-brass-theme', theme);
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      margin: '0',
      padding: '0',
      border: '0',
      width: 'auto',
      height: 'auto',
      maxWidth: 'none',
      maxHeight: 'none',
      // Above effectively everything; this is a foreground modal. The top
      // layer already outranks any z-index, so this is what keeps the chrome
      // in front on the fallback path where `showModal` is unavailable.
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: tokens.backdrop,
    } satisfies Partial<CSSStyleDeclaration>);

    const card = document.createElement('div');
    // Expose the frame as a labelled modal dialog: the overlay behind it is
    // the backdrop, and the embed page inside the iframe carries its own
    // heading. The close button / Escape dismiss it (below); a backdrop
    // click does not.
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Brass');
    Object.assign(card.style, {
      position: 'relative',
      width: 'min(420px, calc(100vw - 32px))',
      background: tokens.cardBackground,
      borderRadius: '12px',
      overflow: 'hidden',
      boxShadow: tokens.cardShadow,
    } satisfies Partial<CSSStyleDeclaration>);

    const iframe = document.createElement('iframe');
    // Thread the theme on the iframe URL (not the bridge `init` payload) so
    // the embed page pins its `color-scheme` before it paints, avoiding a
    // wrong-theme flash while the handshake is in flight. Omit the `'light'`
    // default to keep the URL stable for the no-config path.
    if (theme === 'light') {
      iframe.src = `${baseUrl}/embed/${surface}`;
    } else {
      const iframeUrl = new URL(`${baseUrl}/embed/${surface}`);
      iframeUrl.searchParams.set('theme', theme);
      iframe.src = iframeUrl.toString();
    }
    iframe.title = 'Brass';
    // The dialogs offer copy-to-clipboard actions (the share surface's
    // document link); a cross-origin iframe only gets the Clipboard API
    // when its embedder delegates it, so writeText throws NotAllowedError
    // without this.
    iframe.allow = 'clipboard-write';
    // `colorScheme` + `background` on the iframe ELEMENT defend against a
    // flash through the OS color while the embed HTML + JS loads: until the
    // embed page's `applyEmbedTheme()` pins `color-scheme` on its own
    // `<html>`, the browser paints the iframe's default background from the OS
    // `prefers-color-scheme` (a black flash on a dark-OS phone opening a
    // light modal). Pinning here paints the resolved color before any request
    // leaves the wire. `'auto'` follows OS preference, matching the embed page
    // once loaded.
    Object.assign(iframe.style, {
      display: 'block',
      border: '0',
      width: '100%',
      height: `${INITIAL_IFRAME_HEIGHT}px`,
      colorScheme: theme === 'auto' ? 'light dark' : resolvedChrome,
      background: tokens.cardBackground,
    } satisfies Partial<CSSStyleDeclaration>);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.textContent = '×';
    Object.assign(closeButton.style, {
      position: 'absolute',
      top: '6px',
      right: '8px',
      width: '28px',
      height: '28px',
      border: '0',
      borderRadius: '6px',
      background: 'transparent',
      color: tokens.closeButtonColor,
      fontSize: '20px',
      lineHeight: '1',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);

    card.appendChild(closeButton);
    card.appendChild(iframe);

    // Loading spinner over the iframe until the `ready` handshake. Without it
    // the user sees a blank panel for ~300-1000ms while the iframe boots,
    // reading as "the click did nothing". It can't sit BEHIND the iframe
    // because the iframe paints its own background synchronously (the
    // OS-color-flash defense above), so it goes on top and hides on `ready`.
    const loader = document.createElement('div');
    Object.assign(loader.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: tokens.cardBackground,
      zIndex: '1',
      // Brief fade so the spinner-to-content transition isn't abrupt.
      transition: 'opacity 120ms ease-out',
    } satisfies Partial<CSSStyleDeclaration>);
    const spinner = document.createElement('div');
    Object.assign(spinner.style, {
      width: '32px',
      height: '32px',
      borderRadius: '50%',
      border: `3px solid ${tokens.spinnerTrack}`,
      borderTopColor: tokens.spinnerAccent,
      boxSizing: 'border-box',
    } satisfies Partial<CSSStyleDeclaration>);
    // Web Animations API rather than a `<style>` @keyframes, so no CSS is
    // injected into the host page (which would need scoping to avoid leaking).
    if (typeof spinner.animate === 'function') {
      spinner.animate(
        [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        { duration: 800, iterations: Infinity, easing: 'linear' },
      );
    }
    loader.appendChild(spinner);
    card.appendChild(loader);

    overlay.appendChild(card);

    let settled = false;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;

    // Where to put the reader back. Dismissal detaches the dialog rather than
    // closing it in place, so this is the launcher's job; a reader left on
    // `<body>` resumes tabbing from the top of the page instead of from the
    // control that opened the surface.
    const opener = resolveOpener();

    function restoreFocus(): void {
      if (!opener?.isConnected) return;
      opener.focus();
      if (document.activeElement === opener) return;
      // A host that disabled its trigger for the life of the dialog re-enables
      // it when the launcher settles, which happens after this runs, so the
      // press above landed on a disabled control and did nothing. Try again
      // past the caller's own reaction, and only while nothing has taken focus
      // since, so a host that moves focus itself on the result keeps it.
      setTimeout(() => {
        const active = document.activeElement;
        if (active !== null && active !== document.body) return;
        if (opener.isConnected) opener.focus();
      }, 0);
    }

    function teardown(): void {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKeydown, true);
      overlay.removeEventListener('cancel', onCancel);
      if (readyTimer !== undefined) clearTimeout(readyTimer);
      if (overlay.open) overlay.close();
      overlay.remove();
      restoreFocus();
    }

    function settleResolve(value: EmbedOutcome | null): void {
      if (settled) return;
      settled = true;
      teardown();
      resolve(value);
    }

    function settleReject(error: BrassError): void {
      if (settled) return;
      settled = true;
      teardown();
      reject(error);
    }

    function onMessage(event: MessageEvent): void {
      // Origin + source pinning: only the embed page we opened, in the
      // dashboard origin, can drive this handshake.
      if (event.origin !== dashboardOrigin) return;
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data[EMBED_ENVELOPE] !== EMBED_PROTOCOL_VERSION) return;

      switch (data['type']) {
        case 'ready': {
          if (readyTimer !== undefined) clearTimeout(readyTimer);
          iframe.contentWindow?.postMessage(
            { [EMBED_ENVELOPE]: EMBED_PROTOCOL_VERSION, type: 'init', surface, params },
            dashboardOrigin,
          );
          // Embed page mounted; fade the loader out (delayed removal so the
          // last 120ms is a fade, not a snap).
          loader.style.opacity = '0';
          window.setTimeout(() => {
            loader.style.display = 'none';
          }, 150);
          // Hand the keyboard to the embed now that there is something inside
          // to receive it: opening the dialog leaves focus on the close
          // button, which is the right place to wait while the frame boots and
          // the wrong place to stay once it has. Only when the reader has not
          // moved in the meantime, since taking focus back off a control they
          // tabbed to during the load is worse than leaving it where it is.
          if (document.activeElement === closeButton) iframe.focus();
          break;
        }
        case 'resize': {
          const height = data['height'];
          if (typeof height === 'number' && Number.isFinite(height)) {
            const clamped = Math.min(
              MAX_IFRAME_HEIGHT,
              Math.max(MIN_IFRAME_HEIGHT, Math.round(height)),
            );
            iframe.style.height = `${clamped}px`;
          }
          break;
        }
        case 'export-request': {
          // The Download button asks this host to serialise its open doc. The
          // docId is the surface's own param, not the child's to choose, so
          // the app never serialises a doc the page wasn't opened for. The
          // dialog stays open; do not settle the promise.
          const requestId = data['requestId'];
          const docId = typeof params['docId'] === 'string' ? params['docId'] : '';
          const reply = (outcome: ExportSerializeOutcome): void => {
            iframe.contentWindow?.postMessage(
              { [EMBED_ENVELOPE]: EMBED_PROTOCOL_VERSION, type: 'export-result', requestId, ...outcome },
              dashboardOrigin,
            );
          };
          if (!onExportRequest) {
            reply({ ok: false, code: 'no_serializer', message: 'Export is not supported.' });
            break;
          }
          void onExportRequest(docId).then(reply, (err: unknown) => {
            reply({
              ok: false,
              code: 'serializer_failed',
              message: err instanceof Error ? err.message : 'Serializer failed.',
            });
          });
          break;
        }
        case 'request-sign-in': {
          // The user clicked the refusal surface's sign-in action. Settle the
          // launcher first (this dialog is over; the host is about to
          // navigate) so the caller's promise does not dangle on a page that
          // is going away, then run the host's sign-in.
          settleResolve(null);
          onSignInRequested?.();
          break;
        }
        case 'document-deleted':
        case 'document-delete-failed': {
          // The delete surface reports that the local user is deleting a doc
          // (or that the attempt failed). Fire-and-forget: the dialog settles
          // separately through its own `result` / `cancel`, so do not settle
          // the promise here.
          const docId = data['docId'];
          if (onLocalDelete && typeof docId === 'string' && docId) {
            onLocalDelete(docId, data['type'] === 'document-deleted');
          }
          break;
        }
        case 'result': {
          settleResolve({ payload: data['payload'] });
          break;
        }
        case 'cancel': {
          settleResolve(null);
          break;
        }
        case 'error': {
          const message =
            typeof data['message'] === 'string' && data['message']
              ? (data['message'] as string)
              : 'The hosted UI could not be opened.';
          settleReject(new BrassError(message, { code: 'embed_error' }));
          break;
        }
        default:
          break;
      }
    }

    // The close button dismisses. A backdrop click does NOT: these surfaces
    // hold in-progress work (connecting a drive, sharing, picking a
    // destination), so a stray click outside the card must not throw it away.
    // Dismissal is the explicit close button or Escape only.
    closeButton.addEventListener('click', () => settleResolve(null));

    // Escape dismisses too, matching the close button. This host-side
    // listener fires for an Escape landing on the modal chrome (the close
    // button) or the host page behind it; an Escape pressed while focus is
    // inside the cross-origin iframe never reaches the host, so the embed
    // page relays it as a `cancel` over the bridge. Capture phase so the
    // foreground modal wins over any Escape handler the host app registered.
    function onKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !settled) {
        event.stopPropagation();
        settleResolve(null);
      }
    }
    window.addEventListener('keydown', onKeydown, true);

    // An open dialog answers Escape itself, and closing it that way would
    // leave the launcher's promise unsettled. Route it into the one dismissal
    // path instead; `onKeydown` above normally gets there first, so this is
    // the backstop for an Escape it does not see.
    function onCancel(event: Event): void {
      event.preventDefault();
      settleResolve(null);
    }
    overlay.addEventListener('cancel', onCancel);

    window.addEventListener('message', onMessage);
    const readyTimeoutMs =
      unavailable === 'redirect'
        ? READY_TIMEOUT_SHORT_MS
        : READY_TIMEOUT_LONG_MS;
    readyTimer = setTimeout(() => {
      if (unavailable !== 'reject') {
        // Graceful fallback: tear down the never-loaded modal and navigate to
        // the standalone page. The promise never settles (this page is about
        // to be replaced).
        if (settled) return;
        settled = true;
        teardown();
        redirectToStandalone(baseUrl, surface, params, theme);
        return;
      }
      settleReject(
        new BrassError(
          'The Brass hosted UI did not load. This browser or app context ' +
            'may block third-party iframes.',
          { code: 'iframe_unavailable' },
        ),
      );
    }, readyTimeoutMs);

    document.body.appendChild(overlay);
    // The call that makes the dialog modal: without it the chrome paints
    // identically and Tab keeps walking the host app behind it. Guarded so a
    // browser without the top layer still gets the chrome, non-modal, rather
    // than no dialog at all.
    if (typeof overlay.showModal === 'function') overlay.showModal();
  });
}

// Warm the connection to the origin the embed pages come from. An app talks to
// the api and auth origins, never this one, so the first hosted surface a
// reader opens otherwise pays DNS, TCP and TLS before the iframe's document
// request can even start. Idempotent, since an app may build more than one
// launcher.
function preconnectToDashboard(origin: string): void {
  if (typeof document === 'undefined') return;
  const links = document.head.querySelectorAll('link[rel="preconnect"]');
  for (const link of links) {
    if (link.getAttribute('href') === origin) return;
  }
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  document.head.appendChild(link);
}

export function createHostedUiLauncher(
  opts: HostedUiLauncherOptions,
): HostedUiLauncher {
  const baseUrl = opts.dashboardBaseUrl.replace(/\/$/, '');
  // Parsed once for the postMessage origin checks; a malformed
  // `dashboardBaseUrl` throws here, at construction, not mid-handshake.
  const dashboardOrigin = new URL(baseUrl).origin;
  preconnectToDashboard(dashboardOrigin);
  // Watch for activations from here on, so a surface opened later knows which
  // control the reader pressed to get there.
  trackHostedUiActivations();
  // Default `'light'`: most hosts are light-only, and an `'auto'` default
  // would put a dark embed inside a light host on a dark-OS user.
  const theme: HostedUiTheme = opts.theme ?? 'light';

  // Name the user this app is acting as in every surface's bridge params.
  // Read at open time, not launcher-construction time, since the app may
  // authenticate after the launcher is built. Every embed surface checks the
  // same way, so this is cross-cutting rather than per-surface like `appId`.
  const withActingSub = (
    params: Record<string, unknown>,
  ): Record<string, unknown> => {
    const actingSub = opts.getActingSub?.();
    return {
      ...params,
      ...(actingSub ? { actingSub } : {}),
    };
  };

  // Open a hosted surface and unwrap its bridge outcome: `null` is a user
  // dismissal, otherwise the payload. `exportDoc` threads the export
  // serializer for the document surfaces whose page offers a Download
  // action.
  const launch = async <T>(
    surface: string,
    params: Record<string, unknown>,
    unavailable: UnavailableMode,
    exportDoc?: boolean,
  ): Promise<T | null> => {
    const outcome = await openEmbed(
      baseUrl,
      dashboardOrigin,
      surface,
      withActingSub(params),
      unavailable,
      theme,
      exportDoc ? opts.serializeForExport : undefined,
      // Only the document-settings / share surface deletes; harmless to pass
      // for all, since the message arrives only from that surface.
      opts.onLocalDelete,
      opts.onSignInRequested,
    );
    if (!outcome) return null;
    return outcome.payload as T;
  };

  // Every Brass app shares one sign-in client, so a request's JWT
  // does not say which app made it. Surfaces that must name the caller
  // (its scopes on the install screen, its documents in the picker, the app
  // a share link should open in) read this off the bridge instead.
  const callerAppParam = (): Record<string, string> =>
    opts.callingAppId !== undefined ? { appId: opts.callingAppId } : {};

  return {
    async selectDocument(): Promise<SelectDocumentResult | null> {
      // Thread the calling app id over the bridge (every Brass app shares one
      // sign-in client, so the origin can't otherwise tell which
      // app opened the picker). The embed page uses it for a "only documents
      // this app can open" filter.
      const params: Record<string, unknown> = {};
      if (opts.callingAppId !== undefined) params['appId'] = opts.callingAppId;
      // Where the iframe can't be hosted (cookie-partitioning browsers), the
      // picker falls back to a full-page redirect: the standalone page returns
      // the pick on these one-shot params, which the SDK consumes on boot to
      // open the document, first-party and top-level, the context the iframe
      // fails in. A returned value can't survive that navigation, so the raw
      // promise resolves only on the in-iframe path; the pick otherwise
      // arrives through the session.
      //
      // That fallback ejects the user from the host app, so the picker takes
      // the long handshake window (`redirect-with-value`): degrading early on
      // a slow-but-working iframe costs the user their place for nothing.
      const pickReturn = opts.pickReturn;
      if (pickReturn) {
        params['docParam'] = pickReturn.docParam;
        params['branchParam'] = pickReturn.branchParam;
      }
      return launch<SelectDocumentResult>(
        'select-document',
        params,
        pickReturn ? 'redirect-with-value' : 'reject',
      );
    },
    async selectCreateDestination(options?: {
      name?: string;
    }): Promise<CreateDestinationResult | null> {
      // The `select-document` surface opened on its New panel via
      // `intent: 'create'`: the embed page resolves a destination and sends
      // it back instead of creating the doc, so the create stays on the SDK's
      // credential path. `name` pre-fills the dialog.
      const params: Record<string, unknown> = { intent: 'create' };
      if (opts.callingAppId !== undefined) params['appId'] = opts.callingAppId;
      if (options?.name !== undefined) params['name'] = options.name;
      return launch<CreateDestinationResult>('select-document', params, 'reject');
    },
    async acquireOrganization(): Promise<AcquireOrganizationResult | null> {
      const params: Record<string, unknown> = {};
      if (opts.callingAppId !== undefined) params['appId'] = opts.callingAppId;
      return launch<AcquireOrganizationResult>(
        'acquire-organization',
        params,
        'reject',
      );
    },
    async shareDocument(docId: string): Promise<void> {
      // The share-focused dialog, on the same surface `documentSettings`
      // reaches with `focus: 'share'`. It discards the outcome, so it passes
      // no `canOpenCopy`: that flag says the caller will route a duplicate's
      // `newDocId` into `openSiblingDoc`, and this one cannot.
      await launch(
        'share-document',
        { ...callerAppParam(), docId, focus: 'share' },
        'redirect',
        true,
      );
    },
    async documentSettings(
      docId: string,
      options?: { focus?: DocumentSettingsFocus },
    ): Promise<DocumentSettingsResult | null> {
      // The embed page reads `focus` from `init.params`. Defaults to
      // `'share'` so passing only docId matches the `shareDocument(docId)`
      // surface.
      const focus = options?.focus ?? 'share';
      return launch<DocumentSettingsResult>(
        // The surface names one dialog with two entry points, and it is what
        // the overlay carries as `data-brass-hosted-ui`, so it follows what
        // is on screen rather than which method was called. A host that
        // selects the share dialog matches it whether the app opened it or
        // the toolbar's Share did.
        focus === 'share' ? 'share-document' : 'document-settings',
        // `canOpenCopy` tells the surface this caller routes a duplicate's
        // `newDocId` into `openSiblingDoc`. The hosted page is served
        // fresh against pinned SDKs, so it offers the Open only to a host
        // that says it will honour it.
        { ...callerAppParam(), docId, focus, canOpenCopy: true },
        'redirect',
        true,
      );
    },
    async documentHistory(
      docId: string,
      options?: { branch?: string },
    ): Promise<DocumentHistoryResult | null> {
      const params: Record<string, unknown> = { docId };
      if (options?.branch !== undefined) params['branch'] = options.branch;
      return launch<DocumentHistoryResult>('document-history', params, 'reject');
    },
    async selectBranch(
      docId: string,
      options?: { branch?: string },
    ): Promise<{ branch_id: string } | null> {
      const params: Record<string, unknown> = { docId };
      if (options?.branch !== undefined) params['branch'] = options.branch;
      return launch<{ branch_id: string }>('select-branch', params, 'reject');
    },
    async installApp(organizationId?: string): Promise<InstallAppResult | null> {
      // Thread the caller's `appId` over the bridge so the embed page renders
      // the right app's name + scopes (every Brass app shares one sign-in
      // user-pool client, so the JWT can't disambiguate). On confirm the
      // embed page POSTs the install server-side and forwards the response.
      const params: Record<string, unknown> = {};
      if (opts.callingAppId !== undefined) params['appId'] = opts.callingAppId;
      if (organizationId !== undefined) params['organizationId'] = organizationId;
      return launch<InstallAppResult>('install-app', params, 'reject');
    },
    async driveResolve(docId: string): Promise<DriveResolveResult | null> {
      return launch<DriveResolveResult>('drive-resolve', { docId }, 'reject');
    },
  };
}
