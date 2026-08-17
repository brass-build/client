// The organization a launch came from. Brass appends
// `?brass_org=<organization_id>` to the app URL it opens from an
// organization's dashboard, so the first document an app creates lands in
// the organization the person was standing in when they clicked Open. A
// member of several organizations has already answered "which one" with
// that click; without the parameter the create reaches the server with no
// destination and comes back asking again.
//
// `brass_` prefixed like the platform's other boot parameters so it cannot
// collide with an app's own query string, and stripped from the address bar
// on read so it does not linger in history or a referrer.
//
// The dashboard writes this parameter when it opens an app, and the published
// SDK cannot import the dashboard's source, so the name is spelled in both
// places.

export const LAUNCH_ORGANIZATION_PARAM = 'brass_org';

// Pure + search-string-in so it stays testable, mirroring
// `readGuestLinkToken(search)`.
export function readLaunchOrganizationId(search: string): string | null {
  const value = new URLSearchParams(search).get(LAUNCH_ORGANIZATION_PARAM);
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

// Reads the parameter and strips it from the visible URL in the same tick.
// Best-effort on the strip: an exotic URL or an unavailable history API
// leaves the parameter in the address bar, which costs nothing, the value
// is already in hand.
export function consumeLaunchOrganizationId(): string | null {
  if (typeof window === 'undefined') return null;
  const organizationId = readLaunchOrganizationId(window.location.search);
  if (!organizationId) return null;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(LAUNCH_ORGANIZATION_PARAM);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* address-bar tidiness only */
  }
  return organizationId;
}
