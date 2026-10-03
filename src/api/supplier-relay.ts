import { createHash } from 'node:crypto';
import Fastify from 'fastify';

export const SUPPLIER_DISPATCH = Object.freeze({
  id: 'iancar-15m', cron: '2,17,32,47 * * * *', writerGroup: 'erp5-inventory-publish', hold: false,
  repository: 'freepass-creator/freepasserp4', workflow: 'erp5-ssot-refresh.yml', ref: 'main',
  inputs: Object.freeze({ iancar_only: 'true', iancar_apply: 'true', apply: 'false', target: 'ALL' }),
});
export const SUPPLIER_RELAY_ALLOWLIST = Object.freeze([
  SUPPLIER_DISPATCH,
  Object.freeze({ id: 'hourly-all', repository: 'freepass-creator/freepasserp4',
    workflow: 'erp5-ssot-refresh.yml', ref: 'main', cron: '17 * * * *',
    writerGroup: 'erp5-inventory-publish', hold: true,
    // No dispatch combination reproduces scheduled IANCAR_SYNC_REQUESTED/APPLY.
    inputs: Object.freeze({ iancar_only: 'false', iancar_apply: 'false', apply: 'false', target: 'ALL' }) }),
]);
export type SupplierRelayEntry = typeof SUPPLIER_RELAY_ALLOWLIST[number];
export type RelayOutcome = 'SKIPPED_BUSY' | 'UNKNOWN' | 'ACCEPTED_PENDING' | 'FAILED';
export type RelayReceipt = { key: string; jobName: string; scheduleTime: string };
export type SupplierRelayPorts = {
  /** Verify Google issuer/signature/expiry, exact audience and Scheduler SA subject.
   * Header presence is not authentication. No permissive/default implementation.
   */
  verifyScheduler: (authorization: string) => Promise<boolean>;
  /** Read-only preflight, never acquires admission or writes receipts. */
  verifyReadOnly: () => Promise<{ status: 'VERIFIED' | 'UNKNOWN'; checks: Record<string, string> }>;
  receipts: {
    /** Durable create-only (e.g. ifGenerationMatch=0), not read-then-write. */
    createOnly: (receipt: RelayReceipt) => Promise<'CREATED' | 'EXISTS'>;
    pending: () => Promise<{ key: string; outcome: RelayOutcome | 'RESERVED'; runId: string | null; reason?: string } | null>;
    /** Append completion evidence and compare-and-release exactly this accepted
     * owner/run. UNKNOWN or an owner changed by another request must not be cleared.
     */
    completePending: (key: string, runId: string) => Promise<void>;
    /** Atomic admission across this writer group's schedule keys/instances. Persist owner key
     * before returning ACQUIRED. Existing unresolved/UNKNOWN admission => BUSY.
     * No lease expiry: crash after dispatch must never authorize another dispatch.
     */
    acquirePending: (key: string) => Promise<'ACQUIRED' | 'BUSY' | 'UNKNOWN'>;
    /** Append-only outcome, unique key. Never store token, key material or raw HTTP errors. */
    recordOutcome: (key: string, outcome: RelayOutcome, runId: string | null, reason?: string) => Promise<void>;
    /** Owner-checked release only after confirmed no-dispatch + durable SKIPPED_BUSY.
     * ACCEPTED/UNKNOWN needs separate authorized run reconciliation; not this service.
     */
    releaseWithoutDispatch: (key: string) => Promise<void>;
  };
  /** Read one existing Secret Manager fine-grained PAT into memory; token is
   * scoped to SUPPLIER_DISPATCH.repository, Actions write + Metadata read only.
   * No token value/config accepted through the HTTP request. No App minting required.
   */
  actionsToken: () => Promise<string>;
  /** ALL incomplete writer runs, including queued/waiting/pending hourly/watchdog.
   * A truncated page or failed read MUST return UNKNOWN, never IDLE.
   */
  writerRuns: (token: string, excludeRunId?: string) => Promise<'IDLE' | 'BUSY' | 'UNKNOWN'>;
  /** Exact correlated run in the fixed repository/workflow. 404 or failed read is UNKNOWN. */
  runStatus: (token: string, runId: string) => Promise<'COMPLETED' | 'FAILED' | 'INCOMPLETE' | 'UNKNOWN'>;
  /** One request only, no automatic retry (including SDK/proxy retries).
   * A response without correlated run ID is UNKNOWN; reconciliation is external.
   */
  dispatch: (token: string, request: SupplierRelayEntry) => Promise<{
    status: 'ACCEPTED' | 'UNKNOWN'; runId?: string;
  }>;
};

export function supplierRelayHandler(ports: SupplierRelayPorts, expectedJobName: string) {
  if (!/^projects\/freepasserp5\/locations\/[a-z0-9-]+\/jobs\/[a-zA-Z0-9_-]+$/.test(expectedJobName))
    throw new Error('RELAY_JOB_BINDING_INVALID');
  const entry = SUPPLIER_RELAY_ALLOWLIST.find(item => expectedJobName.endsWith(`/jobs/supplier-relay-${item.id}`));
  if (!entry) throw new Error('RELAY_JOB_NOT_ALLOWLISTED');
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
    if (entry.hold) return { status: 'HOLD' as const, reason: 'NO_EQUIVALENT_HOURLY_DISPATCH' };
    const key = createHash('sha256').update(JSON.stringify([expectedJobName, scheduleTime])).digest('hex');
    const unknown = async (reason = 'UNRESOLVED', runId: string | null = null) => {
      try { await ports.receipts.recordOutcome(key, 'UNKNOWN', runId, reason); } catch { /* claim remains unresolved */ }
      return { status: 'UNKNOWN' as const, key, reason };
    };
    try {
      if (await ports.receipts.createOnly({ key, jobName: expectedJobName, scheduleTime }) === 'EXISTS')
        return { status: 'DUPLICATE' as const, key };
      let token: string | undefined;
      const getToken = async () => {
        token ??= await ports.actionsToken();
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
        if (priorRun === 'FAILED') {
          await ports.receipts.recordOutcome(key, 'FAILED', pending.runId, 'PRIOR_RUN_FAILED_OR_CANCELLED');
          return { status: 'FAILED' as const, key };
        }
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
      const actionsToken = await getToken();
      const runs = await ports.writerRuns(actionsToken);
      if (runs === 'BUSY') {
        await ports.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
        await ports.receipts.releaseWithoutDispatch(key);
        return { status: 'SKIPPED_BUSY' as const, key };
      }
      if (runs !== 'IDLE') return unknown();
      // No retry, including when response parsing, persistence or token transport fails.
      const response = await ports.dispatch(actionsToken, entry);
      if (response.status !== 'ACCEPTED' || !response.runId || !/^[1-9]\d*$/.test(response.runId)) return unknown();
      // Observation closes one race window but cannot atomically lock GitHub cron.
      const overlap = await ports.writerRuns(actionsToken, response.runId);
      if (overlap !== 'IDLE') return unknown(overlap === 'BUSY' ? 'OVERLAP' : 'POST_DISPATCH_READ_UNKNOWN', response.runId);
      const ownRun = await ports.runStatus(actionsToken, response.runId);
      if (ownRun === 'UNKNOWN') return unknown('POST_DISPATCH_RUN_UNKNOWN', response.runId);
      if (ownRun === 'FAILED') return unknown('DISPATCHED_RUN_FAILED_OR_CANCELLED', response.runId);
      await ports.receipts.recordOutcome(key, 'ACCEPTED_PENDING', response.runId);
      return { status: 'ACCEPTED_PENDING' as const, key, runId: response.runId };
    } catch { return unknown(); }
  };
}

/** Cloud Run HTTP service factory. Nothing listens, reads secrets or dispatches on import.
 * Concrete receipt/OIDC/Actions-token ports and authorized deployment are separate rollout gates.
 */
export function buildSupplierRelayServer(ports: SupplierRelayPorts | ((entry: SupplierRelayEntry) => SupplierRelayPorts), jobBinding: string) {
  const server = Fastify({ logger: false, bodyLimit: 1024 });
  const prefix = jobBinding.includes('/jobs/') ? jobBinding.split('/jobs/')[0]! + '/jobs/' : jobBinding;
  const bindings = SUPPLIER_RELAY_ALLOWLIST.map(entry => {
    const jobName = `${prefix}supplier-relay-${entry.id}`;
    const scopedPorts = typeof ports === 'function' ? ports(entry) : ports;
    return { entry, jobName, ports: scopedPorts, handle: supplierRelayHandler(scopedPorts, jobName) };
  });
  server.post('/verify', async (request, reply) => {
    const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
    const binding = bindings.find(item => item.jobName === request.headers['x-cloudscheduler-jobname']);
    const authPorts = binding?.ports ?? bindings[0]!.ports;
    let authorized = false;
    try { authorized = await authPorts.verifyScheduler(authorization); } catch { /* fail closed */ }
    if (!authorized) return reply.code(401).send({ status: 'UNAUTHORIZED' });
    if (!binding || !request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).length) return reply.code(400).send({ status: 'INVALID_REQUEST' });
    try { return await binding.ports.verifyReadOnly(); }
    catch { return { status: 'UNKNOWN', checks: { preflight: 'UNKNOWN' } }; }
  });
  server.post('/schedule', async (request, reply) => {
    const header = (name: string) => typeof request.headers[name] === 'string' ? request.headers[name] as string : '';
    const binding = bindings.find(item => item.jobName === header('x-cloudscheduler-jobname'));
    if (!binding) {
      let authenticated = false;
      try { authenticated = await bindings[0]!.ports.verifyScheduler(header('authorization')); } catch { /* fail closed */ }
      return reply.code(authenticated ? 400 : 401).send({ status: authenticated ? 'INVALID_REQUEST' : 'UNAUTHORIZED' });
    }
    const outcome = await binding.handle({ authorization: header('authorization'), jobName: header('x-cloudscheduler-jobname'),
      scheduleTime: header('x-cloudscheduler-scheduletime'), body: request.body });
    // UNKNOWN is acknowledged to prevent transport retries. It is never a refresh success.
    return reply.code(outcome.status === 'UNAUTHORIZED' ? 401 : outcome.status === 'INVALID_REQUEST' ? 400 : 200).send(outcome);
  });
  return server;
}
