// Runtime config resolution for Brass-hosted bundles.
//
// A bundle served by app hosting gets its identity and environment from the
// serving slot, not from code: the platform stamps a runtime descriptor into
// the served prefix, and `Brass.init()` reads it back same-origin and adopts
// it wholesale. It is authoritative on a hosted origin, so the same artifact
// picks up each environment's config from whichever origin serves it and a
// bundle that hardcodes one environment can't carry it onto another's slot.
// `isBrassHostedHost` recognizes the default `*.onbrass.app` slots by
// hostname; a custom serving domain (a vanity URL) is not recognizable that
// way, so the SDK also reads the descriptor whenever a bundle relies on the
// slot for its environment (no `*BaseUrl` passed to `Brass.init`), on any
// host. A present descriptor is authoritative and overrides even a
// baked app id. A developer on their own hosting passes explicit origins and
// never triggers the fetch.

export const HOSTED_RUNTIME_PATH = '/.well-known/brass-runtime.json';

// The window global a Brass serving slot stamps into the served `index.html`
// as an inline script. This is the primary,
// fetch-free path: the HOST decides whether a bundle is on a Brass slot by
// whether the served page carries this global, so the SDK never guesses from
// the hostname (a custom serving domain is indistinguishable from
// self-hosting by name) nor makes a request that 404s off a slot. The name is
// part of the serving contract, so it is fixed rather than configurable.
const HOSTED_RUNTIME_GLOBAL = '__brassRuntime';

// The apex app hosting serves bundles under. Every hosting origin is some
// host below `onbrass.app`, and the descriptor each serves carries its
// environment's config, so the SDK only recognizes the apex, never parses
// the host itself.
const HOSTING_APEX = 'onbrass.app';

/** True when `hostname` is a Brass app-hosting serving origin. */
export function isBrassHostedHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(`.${HOSTING_APEX}`);
}

export interface HostedRuntime {
  appId: string;
  authBaseUrl: string;
  apiBaseUrl: string;
  wsBaseUrl: string;
  dashboardBaseUrl: string;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null;
  return value.replace(/\/$/, '');
}

function wssUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('wss://')) return null;
  return value.replace(/\/$/, '');
}

/**
 * Parse + validate descriptor JSON into a `HostedRuntime`, or null when
 * any required field is missing or malformed. All-or-nothing: a partial
 * descriptor would mix descriptor and default origins, the exact
 * cross-environment drift the descriptor exists to remove.
 */
export function parseHostedRuntime(value: unknown): HostedRuntime | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const appId = record['app_id'];
  if (typeof appId !== 'string' || !appId.startsWith('brass_app_')) return null;
  const authBaseUrl = httpsUrl(record['auth_base_url']);
  const apiBaseUrl = httpsUrl(record['api_base_url']);
  const wsBaseUrl = wssUrl(record['ws_base_url']);
  const dashboardBaseUrl = httpsUrl(record['dashboard_base_url']);
  if (!authBaseUrl || !apiBaseUrl || !wsBaseUrl || !dashboardBaseUrl) return null;
  return { appId, authBaseUrl, apiBaseUrl, wsBaseUrl, dashboardBaseUrl };
}

/**
 * Read the descriptor a serving slot stamped into the page as
 * `window.__brassRuntime`, or null when it is absent or malformed. Synchronous
 * and fetch-free: this is the primary path, and its presence is the host's
 * signal that this origin is a Brass slot (see `HOSTED_RUNTIME_GLOBAL`).
 */
export function readInjectedRuntime(scope: unknown = globalThis): HostedRuntime | null {
  if (typeof scope !== 'object' || scope === null) return null;
  const value = (scope as Record<string, unknown>)[HOSTED_RUNTIME_GLOBAL];
  return value === undefined ? null : parseHostedRuntime(value);
}

/**
 * Fetch + parse the serving slot's runtime descriptor, or null when the
 * fetch fails or the body doesn't parse. The fetch fallback for a served page
 * that predates the injected global; callers try `readInjectedRuntime` first.
 * Null is a soft signal (the caller falls back to explicit init args), so
 * every failure mode collapses to it.
 */
export async function fetchHostedRuntime(
  fetchFn: typeof fetch = fetch,
): Promise<HostedRuntime | null> {
  try {
    const res = await fetchFn(HOSTED_RUNTIME_PATH);
    if (!res.ok) return null;
    return parseHostedRuntime(await res.json());
  } catch {
    return null;
  }
}
