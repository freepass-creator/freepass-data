import { getAuth } from 'firebase-admin/auth';
import { adminApp } from './firebase.mjs';

/**
 * Verifies the caller's Firebase ID token server side. A token the browser merely
 * claims to hold is not verification (docs/IDENTITY-AND-ACCESS.md §2).
 *
 * `checkRevoked` makes a disabled or signed-out account stop working immediately
 * instead of lingering until the token's own expiry.
 */
export async function verifyBearer(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(authorizationHeader.trim());
  if (!match) return null;
  let decoded;
  try {
    decoded = await getAuth(adminApp()).verifyIdToken(match[1], true);
  } catch {
    return null;
  }
  if (!decoded?.email) return null;
  return {
    uid: decoded.uid,
    email: String(decoded.email).toLowerCase(),
    // Unverified mail must not be able to claim an id, above all the master id.
    emailVerified: decoded.email_verified === true
  };
}
