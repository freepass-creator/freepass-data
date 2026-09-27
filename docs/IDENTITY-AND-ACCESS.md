# FreePass Identity and Access Contract

Status: **CONTRACT AGREED / IMPLEMENTATION IN PROGRESS**
Decided: 2026-09-27
Scope: every FreePass application that signs a human in.

## 1. The split that makes this safe

FreePass Data is the authority for **who may do what**. It is deliberately not the
place where passwords live.

| Concern | Owner | Why |
| --- | --- | --- |
| Credential storage, password reset, session revocation, MFA | Firebase Authentication (email/password) in the FreePass Data Firebase project | Getting these wrong breaks every application at once, so they are not hand-rolled |
| Approval state, role, per-application grants, audit of who granted what | FreePass Data, in Firestore | This is business authority and belongs with the data platform |

Federated sign-in with Google is **not** part of this contract. Accounts are email
and password under FreePass control.

## 2. Rules every application follows

- An application **must not** store passwords, issue its own session tokens, or keep
  its own list of who is allowed in.
- An application verifies the Firebase ID token **server side** on every request.
  A token verified only in the browser is not verification.
- After verifying the token, the application resolves authority through FreePass Data
  and **fails closed**: unknown account, unapproved account, missing grant, or an
  unreachable authority all mean deny.
- An application may cache a resolved authority for at most 5 minutes. Revocation
  must take effect within that window.
- Local development may point at an emulator, never at another application's account store.

## 3. Account lifecycle

```
register → PENDING → (master approves) → APPROVED → (master revokes) → REJECTED
```

- A new account is `PENDING` and can read nothing.
- Only the master may approve, reject or grant application access.
- The master id is configuration (`DASHBOARD_MASTER_ID` for the audit dashboard, the
  same value for the shared authority), and the account matching it is approved by
  definition so the master can never be locked out of its own approval queue.
- Whoever registers the master id first holds it. Register it before sharing any URL.
- Approval is recorded with who approved it and when. Revocation keeps the record.

## 4. Authority record

Firestore holds one document per account. It never contains a password or a hash.

| Field | Meaning |
| --- | --- |
| `id` | normalized account id (lowercased) |
| `status` | `PENDING` / `APPROVED` / `REJECTED` |
| `role` | `MASTER` / `MEMBER` |
| `grants` | applications this account may enter, e.g. `['audit-dashboard', 'freepass-admin']` |
| `createdAt`, `approvedAt`, `approvedBy` | provenance of the decision |

An `APPROVED` account with no grant for an application is still denied by that
application. Approval means "this is a real colleague", not "this person may open
everything".

## 5. Migration order

Applications join one at a time. Each step ends with a real sign-in through the new
path before the old one is removed; no application runs two account systems at once
for longer than its own cutover.

1. **Audit dashboard** — first citizen, proves the contract end to end.
2. **freepass-admin** — currently Google OAuth plus an `ADMIN_EMAILS` allowlist; the
   allowlist becomes `grants` and the OAuth path is removed.
3. **freepass-sales**, **freepass-estimate** — next, once the admin cutover holds.
4. **kakao-ops** and other operational tooling — last, because they run unattended and
   need a service identity story rather than a human one.

Service-to-service access is a separate contract and stays on the consumer bearer
tokens in `src/api/consumer-gateway.ts`. Do not blend the two: a human account must
never be able to act as a registered consumer, and a consumer token must never
resolve to a human.

## 6. What is not decided yet

- Whether the shared authority is exposed as an HTTP endpoint or a published module.
- Session length and idle timeout per application class.
- Whether MFA is required for `MASTER`.

These stay open until the audit dashboard cutover has run in production; decisions
made before that would be guesses.
