import type { BrassUser } from './types.js';

export function decodeIdToken(idToken: string): BrassUser | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const payloadPart = parts[1];
  if (!payloadPart) return null;
  try {
    const json = atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { sub?: unknown; email?: unknown };
    if (typeof claims.sub !== 'string') return null;
    const user: BrassUser = { sub: claims.sub };
    if (typeof claims.email === 'string') user.email = claims.email;
    return user;
  } catch {
    return null;
  }
}
