import type { BrassUser } from './types.js';

export function decodeIdToken(idToken: string): BrassUser | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const payloadPart = parts[1];
  if (!payloadPart) return null;
  try {
    // A JWT payload is UTF-8, and `atob` answers one latin1 character per
    // byte, so a claim with any non-ASCII character (an accented name in
    // `email`) needs the bytes decoded rather than the string used as is.
    const bytes = Uint8Array.from(
      atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/')),
      (ch) => ch.charCodeAt(0),
    );
    const json = new TextDecoder().decode(bytes);
    const claims = JSON.parse(json) as { sub?: unknown; email?: unknown };
    if (typeof claims.sub !== 'string') return null;
    const user: BrassUser = { sub: claims.sub };
    if (typeof claims.email === 'string') user.email = claims.email;
    return user;
  } catch {
    return null;
  }
}
