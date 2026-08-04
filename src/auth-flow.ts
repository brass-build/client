import { SDK_CLIENT_ID } from './version.js';
import { fetchWithRetry, RETRY_READ, RETRY_WRITE_503 } from './fetch-retry.js';

// Fallback token lifetime if a /refresh response omits `expires_in`. The
// server always sends it (so this is forward-compat robustness), but without a
// fallback `Date.now() + undefined * 1000` is NaN, and the client's freshness
// check `expiresAt - leeway > Date.now()` is then always false, so every
// getAccessToken() would fire a fresh /refresh round-trip. Mirrors the CLI's
// same guard.
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

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
  // Present only for a fallback-mode request (a `brass_code` exchange or
  // a `sid` echo): the opaque platform-session pointer the SDK holds in
  // memory to keep refreshing without the cross-site cookie.
  session_token?: string;
}

// The credential the SDK presents to POST /refresh.
//   - `cookie`: the default; the browser attaches the `brass_auth` cookie
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

export async function refreshTokens(
  authBaseUrl: string,
  appId: string,
  credential: RefreshCredential = { kind: 'cookie' },
): Promise<RefreshResult | null> {
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
  // rather than collapsing it into the same `null` a definitive 401 returns:
  // `null` signs the user out and clears the login hint, so without a retry one
  // hourly-refresh blip tears down a live session that was fine server-side. A
  // definitive 401/403 is not in either replay set, so it still returns fast.
  // The one-time `brass_code` exchange is single-use server-side, so its
  // channel replays ONLY a pre-handler 503 (never a network throw, which might
  // mean the code was already consumed); the cookie / sid channels are
  // idempotent and replay the full transient set.
  const policy = credential.kind === 'code' ? RETRY_WRITE_503 : RETRY_READ;
  let response: Response;
  try {
    response = await fetchWithRetry(() => fetch(url, init), { policy });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const json = (await response.json()) as RefreshResponse;
  const result: RefreshResult = {
    tokens: {
      accessToken: json.access_token,
      idToken: json.id_token,
      expiresAt: Date.now() + (json.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000,
      ...(json.app_assertion ? { appAssertion: json.app_assertion } : {}),
    },
  };
  if (json.session_token) result.sessionToken = json.session_token;
  return result;
}
