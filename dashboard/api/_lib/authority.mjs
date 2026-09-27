/**
 * Authority only. Credentials live in Firebase Authentication by contract
 * (docs/IDENTITY-AND-ACCESS.md §1), so nothing here hashes or stores a password.
 */

export const APPLICATION = 'audit-dashboard';

/** Ids are lowercased so "A@b.com" and "a@b.com" cannot become two authority records. */
export function normalizeAccountId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  if (id.length < 3 || id.length > 120) return null;
  if (!/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}$/.test(id)) return null;
  return id;
}

/**
 * The master is approved and granted by definition, otherwise the only account that
 * can approve anyone would be waiting for an approval that cannot arrive.
 */
export function accountView(account, masterId) {
  if (!account || !masterId) return null;
  const isMaster = account.id === masterId;
  const grants = Array.isArray(account.grants) ? account.grants.filter((g) => typeof g === 'string') : [];
  return {
    id: account.id,
    status: isMaster ? 'APPROVED' : account.status,
    role: isMaster ? 'MASTER' : 'MEMBER',
    grants: isMaster ? [...new Set([...grants, APPLICATION])] : grants,
    createdAt: account.createdAt ?? null,
    approvedAt: isMaster ? (account.createdAt ?? null) : (account.approvedAt ?? null),
    approvedBy: isMaster ? 'SELF_MASTER' : (account.approvedBy ?? null)
  };
}

/** Approved means "a real colleague", not "may open everything": the grant is separate. */
export function canEnter(view, application = APPLICATION) {
  return !!view && view.status === 'APPROVED' && view.grants.includes(application);
}

export function pendingRecord(id, masterId, now = new Date().toISOString()) {
  const isMaster = id === masterId;
  return {
    id,
    status: isMaster ? 'APPROVED' : 'PENDING',
    grants: isMaster ? [APPLICATION] : [],
    createdAt: now,
    approvedAt: isMaster ? now : null,
    approvedBy: isMaster ? 'SELF_MASTER' : null
  };
}

export function decisionRecord(decision, masterId, now = new Date().toISOString()) {
  const approved = decision === 'APPROVED';
  return {
    status: decision,
    grants: approved ? [APPLICATION] : [],
    approvedAt: approved ? now : null,
    approvedBy: approved ? masterId : null
  };
}
