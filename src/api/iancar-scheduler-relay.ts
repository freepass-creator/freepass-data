import { createHash } from 'node:crypto';
import Fastify from 'fastify';

export const IANCAR_DISPATCH = Object.freeze({
  repository: 'freepass-creator/freepasserp4', workflow: 'erp5-ssot-refresh.yml', ref: 'main',
  inputs: Object.freeze({ iancar_only: 'true', iancar_apply: 'true', apply: 'false', target: 'ALL' }),
});
export type RelayOutcome = 'SKIPPED_BUSY' | 'UNKNOWN' | 'ACCEPTED_PENDING';
export type RelayReceipt = { key: string; jobName: string; scheduleTime: string };
export type IancarRelayPorts = {
  /** Verify Google issuer/signature/expiry, exact audience and Scheduler SA subject.
   * Header presence is not authentication. No permissive/default implementation.
   */
  verifyScheduler: (authorization: string) => Promise<boolean>;
  receipts: {
    /** Durable create-only (e.g. ifGenerationMatch=0), not read-then-write. */
    createOnly: (receipt: RelayReceipt) => Promise<'CREATED' | 'EXISTS'>;
    pending: () => Promise<{ key: string; outcome: RelayOutcome | 'RESERVED'; runId: string | null } | null>;
    /** Append completion evidence and compare-and-release exactly this accepted
     * owner/run. UNKNOWN or an owner changed by another request must not be cleared.
     */
    completePending: (key: string, runId: string) => Promise<void>;
    /** Atomic global admission across ALL schedule keys/instances. Persist owner key
     * before returning ACQUIRED. Existing unresolved/UNKNOWN admission => BUSY.
     * No lease expiry: crash after dispatch must never authorize another dispatch.
     */
    acquirePending: (key: string) => Promise<'ACQUIRED' | 'BUSY' | 'UNKNOWN'>;
    /** Append-only outcome, unique key. Never store token, key material or raw HTTP errors. */
    recordOutcome: (key: string, outcome: RelayOutcome, runId: string | null) => Promise<void>;
    /** Owner-checked release only after confirmed no-dispatch + durable SKIPPED_BUSY.
     * ACCEPTED/UNKNOWN needs separate authorized run reconciliation; not this service.
     */
    releaseWithoutDispatch: (key: string) => Promise<void>;
  };
  /** Read existing Secret Manager App key in memory; mint one installation token
   * scoped to IANCAR_DISPATCH.repository, Actions write + Metadata read only.
   * No key value/config accepted through the HTTP request. No concrete transport here.
   */
  installationToken: () => Promise<string>;
  /** ALL incomplete writer runs, including queued/waiting/pending hourly/watchdog.
   * A truncated page or failed read MUST return UNKNOWN, never IDLE.
   */
  writerRuns: (token: string) => Promise<'IDLE' | 'BUSY' | 'UNKNOWN'>;
  /** Exact correlated run in the fixed repository/workflow. 404 or failed read is UNKNOWN. */
  runStatus: (token: string, runId: string) => Promise<'COMPLETED' | 'INCOMPLETE' | 'UNKNOWN'>;
  /** One request only, no automatic retry (including SDK/proxy retries).
   * A response without correlated run ID is UNKNOWN; reconciliation is external.
   */
  dispatch: (token: string, request: typeof IANCAR_DISPATCH) => Promise<{
    status: 'ACCEPTED' | 'UNKNOWN'; runId?: string;
  }>;
};

export function iancarRelayHandler(ports: IancarRelayPorts, expectedJobName: string) {
  if (!/^projects\/freepasserp5\/locations\/[a-z0-9-]+\/jobs\/[a-zA-Z0-9_-]+$/.test(expectedJobName))
    throw new Error('RELAY_JOB_BINDING_INVALID');
  return async (input: { authorization: string; jobName: string; scheduleTime: string; body: unknown }) => {
    let authenticated = false;
    try { authenticated = await ports.verifyScheduler(input.authorization); } catch { /* fail closed */ }
    if (!authenticated) return { status: 'UNAUTHORIZED' as const };
    // The Scheduler body is deliberately empty. Caller-selected dispatch inputs are rejected.
    if (input.jobName !== expectedJobName || input.body === null || typeof input.body !== 'object'
      || Array.isArray(input.body) || Object.keys(input.body).length !== 0
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.scheduleTime)
      || !Number.isFinite(Date.parse(input.scheduleTime))) return { status: 'INVALID_REQUEST' as const };
    const scheduleTime = new Date(input.scheduleTime).toISOString();
    if (scheduleTime.slice(0, 19) !== input.scheduleTime.slice(0, 19)) return { status: 'INVALID_REQUEST' as const };
    const key = createHash('sha256').update(JSON.stringify([expectedJobName, scheduleTime])).digest('hex');
    const unknown = async () => {
      try { await ports.receipts.recordOutcome(key, 'UNKNOWN', null); } catch { /* claim remains unresolved */ }
      return { status: 'UNKNOWN' as const, key };
    };
    try {
      if (await ports.receipts.createOnly({ key, jobName: expectedJobName, scheduleTime }) === 'EXISTS')
        return { status: 'DUPLICATE' as const, key };
      let token: string | undefined;
      const getToken = async () => {
        token ??= await ports.installationToken();
        if (!token || /\s/.test(token)) throw new Error('RELAY_AUTH_UNKNOWN');
        return token;
      };
      const pending = await ports.receipts.pending();
      if (pending) {
        if (pending.outcome !== 'ACCEPTED_PENDING' || !pending.runId) {
          await ports.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
          return { status: 'SKIPPED_BUSY' as const, key };
        }
        const priorRun = await ports.runStatus(await getToken(), pending.runId);
        if (priorRun === 'UNKNOWN') return unknown();
        if (priorRun !== 'COMPLETED') {
          await ports.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
          return { status: 'SKIPPED_BUSY' as const, key };
        }
        await ports.receipts.completePending(pending.key, pending.runId);
      }
      const admission = await ports.receipts.acquirePending(key);
      if (admission === 'BUSY') {
        await ports.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
        return { status: 'SKIPPED_BUSY' as const, key };
      }
      if (admission !== 'ACQUIRED') return unknown();
      const installationToken = await getToken();
      const runs = await ports.writerRuns(installationToken);
      if (runs === 'BUSY') {
        await ports.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
        await ports.receipts.releaseWithoutDispatch(key);
        return { status: 'SKIPPED_BUSY' as const, key };
      }
      if (runs !== 'IDLE') return unknown();
      // No retry, including when response parsing, persistence or token transport fails.
      const response = await ports.dispatch(installationToken, IANCAR_DISPATCH);
      if (response.status !== 'ACCEPTED' || !response.runId || !/^[1-9]\d*$/.test(response.runId)) return unknown();
      await ports.receipts.recordOutcome(key, 'ACCEPTED_PENDING', response.runId);
      return { status: 'ACCEPTED_PENDING' as const, key, runId: response.runId };
    } catch { return unknown(); }
  };
}

/** Cloud Run HTTP service factory. Nothing listens, reads secrets or dispatches on import.
 * Concrete receipt/OIDC/App ports and authorized deployment are separate rollout gates.
 */
export function buildIancarRelayServer(ports: IancarRelayPorts, expectedJobName: string) {
  const server = Fastify({ logger: false, bodyLimit: 1024 });
  const handle = iancarRelayHandler(ports, expectedJobName);
  server.post('/schedule', async (request, reply) => {
    const header = (name: string) => typeof request.headers[name] === 'string' ? request.headers[name] as string : '';
    const outcome = await handle({ authorization: header('authorization'), jobName: header('x-cloudscheduler-jobname'),
      scheduleTime: header('x-cloudscheduler-scheduletime'), body: request.body });
    // UNKNOWN is acknowledged to prevent transport retries. It is never a refresh success.
    return reply.code(outcome.status === 'UNAUTHORIZED' ? 401 : outcome.status === 'INVALID_REQUEST' ? 400 : 200).send(outcome);
  });
  return server;
}
