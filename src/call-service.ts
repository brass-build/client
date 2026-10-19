// One brokered call to an outside service.
//
// The app names a HOST its manifest declares and a path on it. Brass holds the
// credential for that host, attaches it, applies the owner's caps, and returns
// the service's answer, so the key never reaches the browser.

import { applyAppAssertionHeader, applyClientVersionHeader } from './api-headers.js';
import { BrassError } from './errors.js';

// A body the SDK may send twice. An install-consent retry re-sends whatever
// the caller passed, and a stream cannot be read a second time, so the stream
// members of `BodyInit` are deliberately not here.
export type CallServiceBody = string | Blob | FormData | URLSearchParams;

export interface CallServiceOptions {
  /** Defaults to `'POST'`. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * Sent to the service as-is, whatever a vendor asks for. The credential is
   * not among them; Brass attaches that.
   */
  headers?: Record<string, string>;
  body?: CallServiceBody;
  /**
   * Whether Brass asks the user for anything the call is missing: a
   * credential at the host, consent to install the app in their
   * organization, or which organization to act in. The call is sent again
   * once they answer.
   *
   * Defaults to false, so the refusal comes back with its `code` for the
   * app's own surface to answer, and `Brass.connectService(host)` opens the
   * credential dialog when the reader asks for it.
   */
  requestMissingCredentials?: boolean;
}

// The headers the app named for the SERVICE travel as the value of one header
// on the Brass request, rather than spread across it. Two things follow, and
// they are the reason this shape exists. A browser preflights a cross-origin
// request header by name, so a vendor header spread onto the request would
// have to be allow-listed by the api before an app could send it at all, and
// `anthropic-version` could not be sent; carried as data, one allow-listed
// name covers every vendor. And what the platform sends the service is then
// exactly this set, with no rule needed to keep Brass's own headers out of it.
//
// Percent-encoded JSON, so a value carrying a newline or a character outside
// ASCII is representable on the header line that carries it.
export function encodeServiceHeaders(headers: Record<string, string>): string {
  return encodeURIComponent(JSON.stringify(headers));
}

// The path reaches the service verbatim, so a caller's own percent-encoding
// survives: a service is entitled to whatever encoding it was given. Only the
// leading separator is the SDK's to normalize, since the caller writing
// `/v1/messages` and `v1/messages` means the same request.
//
// A call at the service's ROOT ends here rather than at a separator with
// nothing after it, because a trailing slash is a different path to a gateway
// and to some services, and `callService(host, '/')` is asking for the root
// rather than for a child of it.
// A host is case-insensitive to DNS and exact to the lookup that finds the
// declaration, so the two are reconciled here rather than at each caller: an
// app that spells one the way its vendor's console does is asking for the
// service it declared, not for one nothing declares.
export function normalizeServiceHost(host: string): string {
  return host.toLowerCase();
}

export function brokeredCallUrl(
  apiBaseUrl: string,
  organizationId: string,
  host: string,
  path: string,
): string {
  const base = apiBaseUrl.replace(/\/$/, '');
  const tail = path.replace(/^\//, '');
  const call = `${base}/organizations/${encodeURIComponent(organizationId)}/call/${encodeURIComponent(host)}`;
  return tail === '' || tail.startsWith('?') ? `${call}${tail}` : `${call}/${tail}`;
}

// The path is appended to the broker URL, and a URL parser resolves dot and
// backslash segments before the request leaves the browser: `../x` and
// `..\x` climb out of the `/call/<host>/` prefix and land the credentialed
// request on another Brass route, and a `#` truncates the request at the
// fragment. The server refuses each of these per DECODED segment
// (`resolveTargetPath`), but that refusal is unreachable once the parser has
// already rewritten the path, so the same check runs here before anything is
// sent. It matches the server's verdicts: whole `/`-segments only (an encoded
// `%2f` stays inside one segment and is the service's own to decode), the tail
// after the one leading slash the broker URL itself normalizes.
export function invalidServicePath(path: string): boolean {
  const tail = path.replace(/^\//, '');
  // A fragment is dropped by the parser, so the request past it is silently
  // lost; a service path carries a literal `#` as `%23`. Read across the
  // whole tail rather than the pathname, since a `#` after the query starts
  // the fragment exactly as one before it does.
  if (tail.includes('#')) return true;
  const pathname = tail.split('?', 1)[0] ?? '';
  // Browsers fold `\` into `/`, so a raw backslash is a separator that this
  // split would miss; the server refuses one outright, and a service path
  // carries a literal backslash as `%5C`.
  if (pathname.includes('\\')) return true;
  // A scheme prefix (`https:`) makes the tail an absolute URL to the parser.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathname)) return true;
  for (const segment of pathname.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === '..' || decoded === '.') return true;
  }
  return false;
}

// The same shape every other refusal on this path takes: a Response the app
// reads a `code` off, carrying the server's own code for a path it would
// itself refuse. Returned before the request is built, so a path that would
// escape the broker never travels with the caller's credentials.
function invalidPathRefusal(): Response {
  return new Response(
    JSON.stringify({
      error: 'The service path is not a valid request path',
      code: 'path_invalid',
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
}

export interface CallServiceDeps {
  apiBaseUrl: string;
  getAccessToken: () => Promise<string | null>;
  getAppAssertion: () => Promise<string | null>;
  /**
   * Which organization this call uses, resolved from context. `ask` is true
   * only where the caller asked for the missing pieces, and the resolve
   * otherwise answers null for a page whose reader would have to be asked.
   */
  resolveOrganization: (ask: boolean) => Promise<string | null>;
  /** Offers the hosted install dialog; true once an install landed. */
  offerInstallConsent: (err: unknown) => Promise<boolean>;
  /**
   * Offers the hosted service-credential dialog for one host; true once that
   * host became usable.
   */
  offerServiceCredential: (
    organizationId: string,
    host: string,
  ) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to the real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

export async function callService(
  deps: CallServiceDeps,
  host: string,
  path: string,
  options: CallServiceOptions = {},
): Promise<Response> {
  // Resolved once, before the first send, so a retry below uses the same
  // organization and cannot open the resolve dialog a second time.
  //
  // The chooser is a question for the person exactly as the two dialogs below
  // are, so the one option governs it too.
  const mayAsk = options.requestMissingCredentials === true;
  // Refused before resolving an organization or opening a chooser: a path that
  // cannot reach the service is answered without spending either.
  if (invalidServicePath(path)) return invalidPathRefusal();
  const organizationId = await deps.resolveOrganization(mayAsk);
  if (organizationId === null) return unresolvedOrganization();
  const send = async (): Promise<Response> => {
    const token = await deps.getAccessToken();
    if (!token) throw new BrassError('Not signed in', { status: 401 });
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (options.headers && Object.keys(options.headers).length > 0) {
      headers['x-brass-service-headers'] = encodeServiceHeaders(options.headers);
    }
    applyClientVersionHeader(headers);
    await applyAppAssertionHeader(headers, deps.getAppAssertion);
    const doFetch = deps.fetchImpl ?? fetch;
    return doFetch(brokeredCallUrl(deps.apiBaseUrl, organizationId, host, path), {
      method: options.method ?? 'POST',
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
  };

  const response = await sendThroughFrontDoor(send, deps);
  // The service's own status is the answer, so nothing here throws on one.
  // The exceptions are the refusals that are a question for the person rather
  // than a result for the app: offer the hosted surface that asks it, and send
  // the call again once the answer lands.
  if (response.ok) return response;
  if (!mayAsk) return response;
  const ask = response.headers.get(BRASS_ASK_HEADER);
  if (ask === 'credential') {
    return (await deps.offerServiceCredential(organizationId, host))
      ? sendThroughFrontDoor(send, deps)
      : response;
  }
  if (ask !== 'install') return response;
  const denial = await notInstalledDenial(response);
  if (!denial) return response;
  return (await deps.offerInstallConsent(denial))
    ? sendThroughFrontDoor(send, deps)
    : response;
}

// Every answer from Brass carries this header, and the broker drops any header
// under that prefix a service sends. Without it, in the gateway's own body, the
// answer came from the gateway in front of Brass: a `429` from its rate limit,
// or a quick `503` from a call it could not start because the brokered call's
// concurrency was all in use. Nothing behind the gateway ran for either, so
// sending it again is safe whatever the method. The gateway's `503` for a call
// that ran past its 30s limit has the same body, and that call may have reached
// the service, so a `503` counts only when it came back well inside that limit.
const ANSWERED_BY_BRASS_HEADER = 'x-brass-answered';

// A quick 503 lasts until a call already running ends, which is within the
// gateway's 30s limit, so the resend lasts that long. The backoff stays short
// so the call starts soon after room frees.
const FRONT_DOOR_WINDOW_MS = 30_000;
const FRONT_DOOR_BASE_DELAY_MS = 300;
const FRONT_DOOR_MAX_DELAY_MS = 2_000;
const FRONT_DOOR_MESSAGES: Record<number, string> = {
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};
const FRONT_DOOR_503_WITHIN_MS = 10_000;

async function shedByFrontDoor(response: Response, elapsedMs: number): Promise<boolean> {
  const message = FRONT_DOOR_MESSAGES[response.status];
  if (message === undefined || response.headers.has(ANSWERED_BY_BRASS_HEADER)) return false;
  if (response.status === 503 && elapsedMs >= FRONT_DOOR_503_WITHIN_MS) return false;
  try {
    const body = (await response.clone().json()) as unknown;
    return (
      typeof body === 'object' &&
      body !== null &&
      Object.keys(body).length === 1 &&
      (body as { message?: unknown }).message === message
    );
  } catch {
    return false;
  }
}

async function sendThroughFrontDoor(
  send: () => Promise<Response>,
  deps: Pick<CallServiceDeps, 'sleep' | 'now'>,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const firstSentAt = now();
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    const startedAt = now();
    response = await send();
    if (!(await shedByFrontDoor(response, now() - startedAt))) return response;
    const delay =
      Math.min(FRONT_DOOR_BASE_DELAY_MS * 2 ** attempt, FRONT_DOOR_MAX_DELAY_MS) +
      Math.random() * FRONT_DOOR_BASE_DELAY_MS;
    if (now() + delay - firstSentAt > FRONT_DOOR_WINDOW_MS) break;
    await sleep(delay);
  }
  // Still shed after the window: answered with the code of Brass's own
  // limit, so an app branches on one `code` for both, and with an `error`
  // naming the gateway's status, so a report says which one turned it away.
  return new Response(
    JSON.stringify({
      error: `The gateway in front of Brass turned the call away (${response.status})`,
      code: 'rate_limited',
    }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  );
}

// No organization resolved, for a caller that did not ask for the chooser.
//
// Answered as a refusal rather than thrown, because every other refusal on
// this path arrives as a Response the app reads a `code` off, and a caller
// reading ahead should not need a second shape for the case where it has not
// acted yet. The code is the server's own for the same state.
function unresolvedOrganization(): Response {
  return new Response(
    JSON.stringify({
      error: 'No organization resolved for this app yet',
      code: 'destination_required',
    }),
    { status: 409, headers: { 'content-type': 'application/json' } },
  );
}

// Which hosted surface a refusal is asking for, in Brass's own words.
//
// Brass states this rather than the SDK inferring it from the `code`, for two
// reasons that both come down to the body being the service's. A declared
// service answers with whatever status and body it likes, so a refusal shaped
// like Brass's own would open a dialog the SERVICE asked for; the platform
// refuses to relay any header under this prefix, so this one is Brass's alone.
// And two of the codes cover a credential the app's author owns as well as one
// the reader can supply, which are the same word for a question somebody can
// answer and one nobody can. Only Brass knows which. A credential-shaped
// refusal added after this SDK shipped therefore still opens the dialog.
const BRASS_ASK_HEADER = 'x-brass-ask';

// Reads the machine-readable install denial out of a refusal, leaving the
// response untouched for a caller that gets it back: the body is read from a
// clone, since a caller reading a consumed body sees an empty one.
async function notInstalledDenial(response: Response): Promise<BrassError | null> {
  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { code?: unknown }).code !== 'app_not_installed' ||
    typeof (parsed as { organization_id?: unknown }).organization_id !== 'string'
  ) {
    return null;
  }
  const body = parsed as { error?: unknown; organization_id: string };
  return new BrassError(typeof body.error === 'string' ? body.error : 'App not installed', {
    status: response.status,
    code: 'app_not_installed',
    organizationId: body.organization_id,
  });
}

// One service this app declares, told against the organization it is acting
// in. `ready: false` carries the same `code` a refused call answers with, so an
// app reading ahead and an app reacting to a refusal branch on one vocabulary.
export interface AppServiceState {
  host: string;
  /**
   * The pattern your manifest declared, where it declared one
   * (`*.myshopify.com`). One entry per tenant connected under it carries it,
   * plus one naming the pattern itself while none is connected. Absent on a
   * host declared literally.
   */
  declared_as?: string;
  /**
   * Whether `Brass.connectService(host)` can lead somewhere here. True where
   * somebody using your app can supply what this host needs; false where it is
   * waiting on the credential you enter as the app's author, which nobody on
   * the page can settle.
   */
  connectable: boolean;
  ready: boolean;
  code?: string;
  /**
   * Values your manifest marked `readable`, for the account this call would
   * spend. Use them to build a path the platform cannot build for you, such as
   * the account id Cloudflare puts in every URL. Present only on a ready
   * service, since only then is there an account to name.
   */
  values?: Record<string, string>;
}

// Which of this app's declared services would serve a call right now.
//
// The platform answers with the CALL's own verdict rather than a second
// derivation of it, so a host reported ready is one the broker will spend.
export async function listAppServices(
  deps: Pick<
    CallServiceDeps,
    'apiBaseUrl' | 'getAccessToken' | 'getAppAssertion' | 'fetchImpl'
  >,
  organizationId: string,
): Promise<AppServiceState[]> {
  const token = await deps.getAccessToken();
  if (!token) throw new BrassError('Not signed in', { status: 401 });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  applyClientVersionHeader(headers);
  await applyAppAssertionHeader(headers, deps.getAppAssertion);
  const base = deps.apiBaseUrl.replace(/\/$/, '');
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(
    `${base}/organizations/${encodeURIComponent(organizationId)}/services`,
    { method: 'GET', headers },
  );
  if (!response.ok) {
    let message = 'Could not read this app\'s services';
    let notInstalled = false;
    try {
      const body = (await response.json()) as { error?: unknown; code?: unknown };
      if (typeof body.error === 'string') message = body.error;
      notInstalled = body.code === 'app_not_installed';
    } catch {
      // Leaves the generic message, which the status already qualifies.
    }
    // Only the code the SDK itself acts on is typed onto the error. The rest
    // of the platform's refusal vocabulary describes one host rather than this
    // read, and none of it reaches a read that returned nothing.
    //
    // The organization rides the install denial because that is what the
    // hosted install dialog installs into: the read named one organization, so
    // the refusal is about that one and the dialog does not have to ask where
    // a second time.
    throw new BrassError(message, {
      status: response.status,
      ...(notInstalled
        ? { code: 'app_not_installed' as const, organizationId }
        : {}),
    });
  }
  // An answer that is not the platform's own reaches here as a 200: an edge
  // or a proxy serves its own page under whatever status it chooses. Reading
  // it through the same error type as every refusal on this path leaves one
  // shape for an app to catch, and a `services` that is not a list is read as
  // none rather than handed to the app typed as an array it can iterate.
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new BrassError('Could not read this app\'s services', { status: 502 });
  }
  const services = (parsed as { services?: unknown } | null)?.services;
  return Array.isArray(services) ? (services as AppServiceState[]) : [];
}
