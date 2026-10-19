import type { HostedUiTheme } from './hosted-ui.js';

export interface BrassUser {
  sub: string;
  email?: string;
  display_name?: string;
  avatar_url?: string;
}

export interface BrassInitOptions {
  // With nothing passed, the SDK resolves all four production origins.
  // Naming any one of the four below opts out of that entirely, so a
  // stack is addressed by its own origins rather than by a mix.
  authBaseUrl?: string;
  // Origin for the Brass data API (documents, organizations, users). The
  // auth surface uses `authBaseUrl`.
  apiBaseUrl?: string;
  // WebSocket endpoint for document op and presence subscriptions. On
  // its own hostname, so it cannot be derived from `apiBaseUrl`. Passing
  // any other `*BaseUrl` leaves it unset on purpose: a production ws
  // origin beside a hand-overridden HTTP origin would connect to a
  // different stack and silently drop events, whereas unset fails loudly
  // on `subscribe`.
  wsBaseUrl?: string;
  // Origin the Brass-hosted UI pages are served from. The hosted-UI
  // launchers load `${dashboardBaseUrl}/embed/*` in a modal iframe.
  dashboardBaseUrl?: string;
  // Pin the hosted-UI modal + embed page to a theme. Defaults to
  // `'light'`; `'auto'` follows the OS preference. An app that forces
  // its own theme should pass the matching value so the modal doesn't
  // mismatch the page that opened it.
  hostedUiTheme?: HostedUiTheme;
  /** How the session opens documents. `readOnly: true` opens every document
   *  the session opens read-only (the URL on boot and reload, Open, a followed
   *  link, `session.open`), and `doc.reopen()` reopens the bound one for
   *  editing. A document the session creates opens editable. Default
   *  editable. */
  open?: { readOnly?: boolean };
  // Mirror the active document selection to the page URL (default on):
  // writes the doc id (and non-default branch) using `pushState` for a
  // genuine open / branch switch and `replaceState` to pin the boot
  // selection, and restores from the URL on boot and `popstate`. The
  // document the URL named is bound as `Brass.session.document`, so an
  // app reads the active id from `session.document?.id`. Opt out with
  // `false` for an app that owns its URL state (e.g. its own router).
  syncDocToUrl?: boolean;
  // Query-parameter name for the active doc id (default `'doc'`). Set to
  // disambiguate when the app's URL already uses `doc`.
  docUrlParam?: string;
  // Query-parameter name for a non-default branch (default `'branch'`).
  // Present only when the active document is on a non-default branch.
  branchUrlParam?: string;
  // Set `document.title` to the active document's name (default on), so
  // history entries are distinguishable, restoring the original title
  // when no document is open. While a document is open the title is
  // suffixed with the app name (`Doc name · App name`), taken from the
  // page's own `<title>` at the first sync. Opt out with `false` for an
  // app that manages its own title.
  syncDocToTitle?: boolean;
}

// `'unknown'` is the bootstrap window before `Brass.init` settles,
// distinct from `'signed-out'` (init settled, no user) so an app can
// render a neutral state instead of flashing its sign-in CTA at a user
// who turns out to be signed in. Then tracks every sign-in / sign-out.
// `'guest'` is the anonymous-link case: the page was opened via a
// public-link token (`?brass_link=`), so there is no signed-in user but
// the session still opens a read-only document. An app renders its
// working surface for `'signed-in'` OR `'guest'` (read-only), and its
// sign-in CTA only for `'signed-out'`.
export type AuthStatus = 'unknown' | 'signed-in' | 'signed-out' | 'guest';

export type UserChangeListener = (user: BrassUser | null) => void;

// Fired when Brass.init fails (bad / missing app_id, etc.). Register
// before init to get visibility into failures that an init wrapped
// without a `.catch()` would otherwise swallow silently.
export type ErrorListener = (error: Error) => void;

export interface UndoControllerOptions {
  // Cap on retained undo steps. Older steps drop off the bottom of the
  // stack as new ones land.
  maxUndoSteps?: number;
}

/**
 * A document's own view of how its sync is going, as the client sees it.
 *
 * The server records what reached it, so the facts that separate a write
 * that was lost from a client that is merely slow live only here.
 *
 * @internal Read on demand by Brass's own surfaces, through the `@internal`
 * `Document.diagnostics()`. An app reads `savingCount` to know a save is
 * outstanding and `Brass.onError` to hear a failure; the SDK resolves a
 * stuck save itself.
 */
export interface DocSyncDiagnostics {
  /** Ops committed locally that the server has not acknowledged. */
  unackedOps: number;
  /** How long the oldest of them has been waiting, in ms. 0 when none. */
  oldestUnackedMs: number;
  /**
   * The oldest unacked op's correlator. The same id rides the op to the
   * server, so it is what an operator matches a stuck save against the
   * server's record of the write.
   */
  oldestClientOpId: string | null;
  /**
   * Sockets the SDK has opened since it was constructed, past the first.
   * Every open document shares one socket, so this is a fact about the
   * client rather than about this document, and it counts a deliberate
   * close and re-open alongside a drop.
   */
  reconnects: number;
  /**
   * Since any acknowledgement landed on this socket, in ms, or null when
   * none ever has. A connection answering nothing and one merely behind
   * look the same from a single op's age; this is what tells them apart.
   */
  lastAckAgeMs: number | null;
  /** Bytes on the socket against the transport's in-flight budget. */
  inFlightBytes: number;
  /** Ops too large for the socket, travelling over HTTP right now. */
  httpOpsInFlight: number;
  /** Rounds the durability handshake has spent reconciling. */
  healRounds: number;
  /** Whether the page is hidden, which throttles the client's timers. */
  hidden: boolean;
}
