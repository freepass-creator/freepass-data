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
  // 자격증명이 없어서 못 여는 것과 토큰이 틀린 것은 다른 사건이다. 둘을 같은 catch로 덮으면
  // 키를 빠뜨린 서버가 모두에게 "로그인이 필요합니다"라고 답하고, 사람은 제 비밀번호를 의심한다.
  const auth = getAuth(adminApp());
  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1], true);
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
