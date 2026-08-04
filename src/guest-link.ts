// The anonymous "anyone with the link" boot signal. When Brass routes a
// no-sign-in share link into an app, it appends `?brass_link=<token>` to
// the app's URL. `Brass.init` reads it here and opens the document
// read-only through the token (`GET /links/:token/view`), with no sign-in.
//
// Pure + search-string-in so it stays testable, mirroring
// `isExportMode(search)`.

export const GUEST_LINK_PARAM = 'brass_link';

export function readGuestLinkToken(search: string): string | null {
  const value = new URLSearchParams(search).get(GUEST_LINK_PARAM);
  return value && value.trim() !== '' ? value : null;
}
