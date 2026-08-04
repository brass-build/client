// The shared HTTP request wrapper: resolve token → 401 if missing →
// auth header → app-assertion → fetch → parse → throw `BrassError` on
// non-2xx → return parsed. Read paths that need the raw status without
// throwing stay hand-written but still throw `BrassError`.

import { applyAppAssertionHeader, applyClientVersionHeader } from './api-headers.js';
import { BrassError } from './errors.js';
import { fetchWithRetry } from './fetch-retry.js';

export interface ApiRequest {
  // Defaults to `GET`.
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  // JSON-encoded when present; sets `content-type: application/json`.
  body?: unknown;
}

interface ApiFetchOptions {
  apiBaseUrl: string;
  getAccessToken: () => Promise<string | null>;
  getAppAssertion?: () => Promise<string | null>;
}

export type ApiFetch = <T>(req: ApiRequest) => Promise<T>;

export function createApiFetch(opts: ApiFetchOptions): ApiFetch {
  const baseUrl = opts.apiBaseUrl.replace(/\/$/, '');

  return async function apiFetch<T>(req: ApiRequest): Promise<T> {
    const token = await opts.getAccessToken();
    if (!token) {
      // Reject before fetch: a deterministic 401, no network round-trip.
      throw new BrassError('Not signed in', { status: 401 });
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    applyClientVersionHeader(headers);
    await applyAppAssertionHeader(headers, opts.getAppAssertion);

    const method = req.method ?? 'GET';
    const init: RequestInit = { method, headers };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);

    const url = `${baseUrl}${req.path}`;
    // A GET is idempotent, so ride out a cold-API transient 5xx / 429
    // (e.g. a 503 while the API scales into a concurrent read burst)
    // rather than surfacing it as a hard failure; a write is never
    // replayed here.
    const response =
      method === 'GET'
        ? await fetchWithRetry(() => fetch(url, init))
        : await fetch(url, init);
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Leave `parsed` undefined; a non-2xx falls back to the generic
        // message, a 2xx surfaces as the caller's own malformed-body guard.
      }
    }
    if (!response.ok) {
      throw brassErrorFromBody(response.status, parsed);
    }
    return parsed as T;
  };
}

function isErrorBody(body: unknown): body is { error: string } {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { error?: unknown }).error === 'string'
  );
}

// Build the BrassError for a non-2xx response body. Every SDK fetch
// (apiFetch and the hand-written document open / create paths) throws
// through here so the server's machine-readable denials, in particular
// `code: "app_not_installed"`, survive into the error the caller (and
// the SDK's own install-consent offer) can branch on.
export function brassErrorFromBody(status: number, parsed: unknown): BrassError {
  const message = isErrorBody(parsed) ? parsed.error : 'Request failed';
  if (isNotInstalledBody(parsed)) {
    return new BrassError(message, {
      status,
      code: 'app_not_installed',
      organizationId: parsed.organization_id,
    });
  }
  if (isSchemaConflictBody(parsed)) {
    const title = (parsed as Record<string, unknown>)['title'];
    return new BrassError(message, {
      status,
      code: 'schema_conflict',
      ...(typeof title === 'string' ? { title } : {}),
    });
  }
  return new BrassError(message, { status });
}

// The platform refuses to join a document this app's declared schema cannot
// read, so a bookmark or a reload does not silently open one. The message is
// the server's own line, which the client's dialog renders verbatim rather
// than composing a reason of its own out of a shape it would have to keep in
// step with the platform's.
function isSchemaConflictBody(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { code?: unknown }).code === 'schema_conflict'
  );
}

function isNotInstalledBody(
  value: unknown,
): value is { error: string; code: 'app_not_installed'; organization_id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { code?: unknown }).code === 'app_not_installed' &&
    typeof (value as { organization_id?: unknown }).organization_id === 'string'
  );
}
