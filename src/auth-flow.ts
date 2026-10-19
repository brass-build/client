import { SDK_CLIENT_ID } from './version.js';
import { fetchWithRetry, RETRY_READ, RETRY_WRITE_503 } from './fetch-retry.js';

// Fallback token lifetime when a /refresh response carries no usable
// `expires_in`. The server always sends a positive number (so this is
// forward-compat robustness), and every other value stamps an `expiresAt` the
// client's freshness check `expiresAt - leeway > Date.now()` can never
// satisfy: `undefined` and a non-numeric make it NaN, and 0 or a negative
// makes it already past. Either way every getAccessToken() would fire a fresh
// /refresh round-trip. Mirrors the CLI's same guard.
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

// The lifetime to stamp a token set with, given whatever `expires_in` the
// response carried.
function tokenTtlSeconds(expiresIn: unknown): number {
  return typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
    ? expiresIn
    : DEFAULT_TOKEN_TTL_SECONDS;
}

export interface TokenSet {
  accessToken: string;
  idToken: string;
  expiresAt: number;
  // The acting-app assertion minted at /refresh, forwarded to the data
  // API as `X-Brass-App-Assertion`. Absent when the proxy has no signing
  // secret configured.
  appAssertion?: string;
}

interface RefreshResponse {
  access_token: string;
  id_token: string;
  expires_in: number;
  app_assertion?: string;
  // Present only for a fallback-mode request (a `brass_code` exchange or a
  // `sid` echo): an opaque pointer, bound server-side to this app id, that the
  // SDK holds in memory to keep refreshing without the cross-site cookie.
  session_token?: string;
}

// The credential the SDK presents to POST /refresh.
//   - `cookie`: the default; the browser attaches the `__Host-brass_auth` cookie
//      and nothing is sent in the body. Works wherever the third-party
//      cookie is allowed.
//   - `code`: a one-time `brass_code` from the sign-in redirect, exchanged
//      for tokens + a `session_token`. The incognito / Safari ITP fallback,
//      used only after a `cookie` refresh came back empty.
//   - `sessionToken`: the opaque pointer from a prior `code` exchange,
//      echoed on every refresh once the cookie channel is known unavailable.
export type RefreshCredential =
  | { kind: 'cookie' }
  | { kind: 'code'; code: string }
  | { kind: 'sessionToken'; sessionToken: string };

export interface RefreshResult {
  tokens: TokenSet;
  // Set only for fallback-mode refreshes (`code` / `sessionToken`). The
  // SDK stores this and presents it as the `sessionToken` credential on
  // later refreshes.
  sessionToken?: string;
}

// The result of one /refresh attempt, carrying whether a failure was the
// server's answer or the absence of one.
//
// `no_session`: this credential resolves no live session (revoked, expired,
// or never approved for this app). The caller signs the user out.
//
// `unavailable`: the request threw, or a transient status outlived the
// retries. Nothing was learned about the session, so the caller keeps the
// credentials it holds and lets a later attempt settle it. Treating this as
// `no_session` ends a live session over a momentary network failure.
export type RefreshOutcome =
  | { status: 'ok'; result: RefreshResult }
  | { status: 'no_session' }
  | { status: 'unavailable' };

// Attempts for a /refresh, raised from `fetchWithRetry`'s default of 3
// (~0.9s of backoff) so the call outlasts the few-second network gap a
// machine waking from sleep produces.
const REFRESH_ATTEMPTS = 5;

// Statuses that mean the request found no answer. A 5xx is in the set
// because the auth proxy reports an upstream failure as one, so it says
// nothing about whether the session is live.
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

export function buildSignInUrl(authBaseUrl: string, appId: string, returnTo: string): string {
  const url = new URL(`${authBaseUrl}/sign-in`);
  url.searchParams.set('app_id', appId);
  url.searchParams.set('return_to', returnTo);
  return url.toString();
}

export function buildSignedOutOfAppUrl(
  authBaseUrl: string,
  appId: string,
  returnTo: string,
): string {
  const url = new URL(`${authBaseUrl}/signed-out-of-app`);
  url.searchParams.set('app_id', appId);
  url.searchParams.set('return_to', returnTo);
  return url.toString();
}

// Drops this app's approval off the platform session, presenting the same
// credential a refresh does. Never rejects: the sign-out navigation follows
// either way, and the page it lands on offers the button that finishes a
// revocation this call could not deliver.
export async function revokeAppApproval(
  authBaseUrl: string,
  appId: string,
  credential: RefreshCredential = { kind: 'cookie' },
): Promise<void> {
  const url = `${authBaseUrl}/sign-out-of-app?${new URLSearchParams({
    app_id: appId,
  }).toString()}`;
  const init: RequestInit = { method: 'POST', credentials: 'include' };
  if (credential.kind === 'sessionToken') {
    // A URLSearchParams body keeps this a CORS simple request, as on
    // /refresh: the auth API serves no preflight OPTIONS.
    const body = new URLSearchParams();
    body.set('sid', credential.sessionToken);
    init.body = body;
  }
  try {
    await fetch(url, init);
  } catch {
    // Swallowed on purpose: see above.
  }
}

export async function refreshTokens(
  authBaseUrl: string,
  appId: string,
  credential: RefreshCredential = { kind: 'cookie' },
): Promise<RefreshOutcome> {
  // `client` rides a query param, not a header: /refresh is deliberately
  // a CORS simple request (no preflight), and any custom header would
  // trip one. The server folds it into the token_refresh audit so the
  // deployed SDK version distribution is measurable.
  const url = `${authBaseUrl}/refresh?${new URLSearchParams({
    app_id: appId,
    client: SDK_CLIENT_ID,
  }).toString()}`;
  const init: RequestInit = { method: 'POST', credentials: 'include' };
  if (credential.kind !== 'cookie') {
    // A URLSearchParams body sends `Content-Type:
    // application/x-www-form-urlencoded`, which keeps this a CORS
    // "simple request" with no preflight OPTIONS, which the auth API
    // does not serve. A JSON content-type would trip preflight.
    const body = new URLSearchParams();
    if (credential.kind === 'code') body.set('brass_code', credential.code);
    else body.set('sid', credential.sessionToken);
    init.body = body;
  }
  // Retry a transient failure (a cold-start 5xx / 429, or a network blip)
  // before reporting it. A definitive 401/403 is not in either replay set, so
  // it still returns fast. The one-time `brass_code` exchange is single-use
  // server-side, so its channel replays ONLY a pre-handler 503 (never a
  // network throw, which might mean the code was already consumed); the
  // cookie / sid channels are idempotent and replay the full transient set.
  const policy = credential.kind === 'code' ? RETRY_WRITE_503 : RETRY_READ;
  let response: Response;
  try {
    response = await fetchWithRetry(() => fetch(url, init), {
      policy,
      maxAttempts: REFRESH_ATTEMPTS,
    });
  } catch {
    return { status: 'unavailable' };
  }
  if (!response.ok) {
    return isTransientStatus(response.status)
      ? { status: 'unavailable' }
      : { status: 'no_session' };
  }
  const json = (await response.json()) as RefreshResponse;
  const result: RefreshResult = {
    tokens: {
      accessToken: json.access_token,
      idToken: json.id_token,
      expiresAt: Date.now() + tokenTtlSeconds(json.expires_in) * 1000,
      ...(json.app_assertion ? { appAssertion: json.app_assertion } : {}),
    },
  };
  if (json.session_token) result.sessionToken = json.session_token;
  return { status: 'ok', result };
}
