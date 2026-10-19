import type { ApiFetch } from './api-fetch.js';
import { inDevelopment } from './in-development.js';

const LOCAL_MANIFEST_PATH = '/.well-known/brass-app.json';

let checked = false;

export interface ManifestDriftDeps {
  appId: string;
  origin: string;
  apiFetch: ApiFetch;
  fetchImpl?: typeof fetch;
}

// Development builds only. Brass enforces the manifest it read from the
// app's published origin, so a local edit has no effect until publish.
// Runs once per page load and never holds up its caller.
export function checkManifestDrift(deps: ManifestDriftDeps): void {
  if (checked || !inDevelopment()) return;
  checked = true;
  void compare(deps).catch(() => undefined);
}

async function compare(deps: ManifestDriftDeps): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${deps.origin}${LOCAL_MANIFEST_PATH}`, {
    cache: 'no-store',
  });
  if (!response.ok) return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(await response.text());
  } catch {
    return;
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return;
  const { differing } = await deps.apiFetch<{ differing?: unknown }>({
    method: 'POST',
    path: `/apps/${encodeURIComponent(deps.appId)}/manifest-drift`,
    body: { manifest },
    idempotent: true,
  });
  if (!Array.isArray(differing) || differing.length === 0) return;
  const fields = differing.filter((f): f is string => typeof f === 'string');
  if (fields.length === 0) return;
  console.warn(
    `[brass] This page's ${LOCAL_MANIFEST_PATH} differs from the manifest Brass is enforcing for this app in: ${fields.join(', ')}. Brass reads the manifest from the published app, so the change applies once the app is published.`,
  );
}

/** @internal Test seam: forget that this page load already checked. */
export function _resetManifestDriftCheck(): void {
  checked = false;
}
