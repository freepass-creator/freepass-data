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
export function supplierRelayHandler(ports, expectedJobName) {
    if (!/^projects\/freepasserp5\/locations\/[a-z0-9-]+\/jobs\/[a-zA-Z0-9_-]+$/.test(expectedJobName))
        throw new Error('RELAY_JOB_BINDING_INVALID');
    const entry = SUPPLIER_RELAY_ALLOWLIST.find(item => expectedJobName.endsWith(`/jobs/supplier-relay-${item.id}`));
    if (!entry)
        throw new Error('RELAY_JOB_NOT_ALLOWLISTED');
    return async (input) => {
        let authenticated = false;
        try {
            authenticated = await ports.verifyScheduler(input.authorization);
        }
        catch { /* fail closed */ }
        if (!authenticated)
            return { status: 'UNAUTHORIZED' };
        const parseableTime = input.scheduleTime.replace(/(\.\d{3})\d+Z$/, '$1Z');
        // The Scheduler body is deliberately empty. Caller-selected dispatch inputs are rejected.
        if (input.jobName !== expectedJobName || input.body === null || typeof input.body !== 'object'
            || Array.isArray(input.body) || Object.keys(input.body).length !== 0
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(input.scheduleTime)
            || !Number.isFinite(Date.parse(parseableTime)))
            return { status: 'INVALID_REQUEST' };
        const scheduleTime = new Date(parseableTime).toISOString();
        if (scheduleTime.slice(0, 19) !== input.scheduleTime.slice(0, 19))
            return { status: 'INVALID_REQUEST' };
        if (entry.hold)
            return { status: 'HOLD', reason: 'NO_EQUIVALENT_HOURLY_DISPATCH' };
        const key = createHash('sha256').update(JSON.stringify([expectedJobName, scheduleTime])).digest('hex');
        const unknown = async (reason = 'UNRESOLVED', runId = null) => {
            try {
                await ports.receipts.recordOutcome(key, 'UNKNOWN', runId, reason);
            }
            catch { /* claim remains unresolved */ }
            return { status: 'UNKNOWN', key, reason };
        };
        try {
            if (await ports.receipts.createOnly({ key, jobName: expectedJobName, scheduleTime }) === 'EXISTS')
                return { status: 'DUPLICATE', key };
            let token;
            const getToken = async () => {
                token ??= await ports.actionsToken();
                if (!token || /\s/.test(token))
                    throw new Error('RELAY_AUTH_UNKNOWN');
                return token;
            };
            const pending = await ports.receipts.pending();
            if (pending) {
                if (pending.outcome !== 'ACCEPTED_PENDING' || !pending.runId) {
                    await ports.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
                    return { status: 'SKIPPED_BUSY', key };
                }
                const priorRun = await ports.runStatus(await getToken(), pending.runId);
                if (priorRun === 'UNKNOWN')
                    return unknown();
                if (priorRun === 'FAILED') {
                    await ports.receipts.recordOutcome(key, 'FAILED', pending.runId, 'PRIOR_RUN_FAILED_OR_CANCELLED');
                    return { status: 'FAILED', key };
                }
                if (priorRun !== 'COMPLETED') {
                    await ports.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
                    return { status: 'SKIPPED_BUSY', key };
                }
                await ports.receipts.completePending(pending.key, pending.runId);
            }
            const admission = await ports.receipts.acquirePending(key);
            if (admission === 'BUSY') {
                await ports.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
                return { status: 'SKIPPED_BUSY', key };
            }
            if (admission !== 'ACQUIRED')
                return unknown();
            const actionsToken = await getToken();
            const runs = await ports.writerRuns(actionsToken);
            if (runs === 'BUSY') {
                await ports.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
                await ports.receipts.releaseWithoutDispatch(key);
                return { status: 'SKIPPED_BUSY', key };
            }
            if (runs !== 'IDLE')
                return unknown();
            // No retry, including when response parsing, persistence or token transport fails.
            const response = await ports.dispatch(actionsToken, entry);
            if (response.status !== 'ACCEPTED' || !response.runId || !/^[1-9]\d*$/.test(response.runId))
                return unknown();
            // Observation closes one race window but cannot atomically lock GitHub cron.
            const overlap = await ports.writerRuns(actionsToken, response.runId);
            if (overlap !== 'IDLE')
                return unknown(overlap === 'BUSY' ? 'OVERLAP' : 'POST_DISPATCH_READ_UNKNOWN', response.runId);
            const ownRun = await ports.runStatus(actionsToken, response.runId);
            if (ownRun === 'UNKNOWN')
                return unknown('POST_DISPATCH_RUN_UNKNOWN', response.runId);
            if (ownRun === 'FAILED')
                return unknown('DISPATCHED_RUN_FAILED_OR_CANCELLED', response.runId);
            await ports.receipts.recordOutcome(key, 'ACCEPTED_PENDING', response.runId);
            return { status: 'ACCEPTED_PENDING', key, runId: response.runId };
        }
        catch {
            return unknown();
        }
    };
}
/** Cloud Run HTTP service factory. Nothing listens, reads secrets or dispatches on import.
 * Concrete receipt/OIDC/Actions-token ports and authorized deployment are separate rollout gates.
 */
export function buildSupplierRelayServer(ports, jobBinding) {
    const server = Fastify({ logger: false, bodyLimit: 1024 });
    const prefix = jobBinding.includes('/jobs/') ? jobBinding.split('/jobs/')[0] + '/jobs/' : jobBinding;
    const bindings = SUPPLIER_RELAY_ALLOWLIST.map(entry => {
        const jobName = `${prefix}supplier-relay-${entry.id}`;
        const scopedPorts = typeof ports === 'function' ? ports(entry) : ports;
        return { entry, jobName, ports: scopedPorts, handle: supplierRelayHandler(scopedPorts, jobName) };
    });
    const bindingFor = (header) => typeof header === 'string'
        ? bindings.find(item => item.jobName === header || (!header.includes('/') && item.jobName === `${prefix}${header}`))
        : undefined;
    const reject = (path, code, reason) => {
        console.log(JSON.stringify({ event: 'supplier_relay_reject', path, code, reason }));
    };
    server.post('/verify', async (request, reply) => {
        const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
        const binding = bindingFor(request.headers['x-cloudscheduler-jobname']);
        const authPorts = binding?.ports ?? bindings[0].ports;
        let authorized = false;
        try {
            authorized = await authPorts.verifyScheduler(authorization);
        }
        catch { /* fail closed */ }
        if (!authorized) {
            reject('/verify', 401, 'AUTH');
            return reply.code(401).send({ status: 'UNAUTHORIZED' });
        }
        if (!binding) {
            reject('/verify', 400, 'JOB_NOT_ALLOWLISTED');
            return reply.code(400).send({ status: 'INVALID_REQUEST' });
        }
        if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
            || Object.keys(request.body).length) {
            reject('/verify', 400, 'BODY_NOT_EMPTY_OBJECT');
            return reply.code(400).send({ status: 'INVALID_REQUEST' });
        }
        try {
            return await binding.ports.verifyReadOnly();
        }
        catch {
            return { status: 'UNKNOWN', checks: { preflight: 'UNKNOWN' } };
        }
    });
    server.post('/schedule', async (request, reply) => {
        const header = (name) => typeof request.headers[name] === 'string' ? request.headers[name] : '';
        const binding = bindingFor(request.headers['x-cloudscheduler-jobname']);
        if (!binding) {
            let authenticated = false;
            try {
                authenticated = await bindings[0].ports.verifyScheduler(header('authorization'));
            }
            catch { /* fail closed */ }
            reject('/schedule', authenticated ? 400 : 401, authenticated ? 'JOB_NOT_ALLOWLISTED' : 'AUTH');
            return reply.code(authenticated ? 400 : 401).send({ status: authenticated ? 'INVALID_REQUEST' : 'UNAUTHORIZED' });
        }
        const outcome = await binding.handle({ authorization: header('authorization'), jobName: binding.jobName,
            scheduleTime: header('x-cloudscheduler-scheduletime'), body: request.body });
        if (outcome.status === 'UNAUTHORIZED')
            reject('/schedule', 401, 'AUTH');
        if (outcome.status === 'INVALID_REQUEST')
            reject('/schedule', 400, 'BODY_OR_SCHEDULE_TIME');
        // UNKNOWN is acknowledged to prevent transport retries. It is never a refresh success.
        return reply.code(outcome.status === 'UNAUTHORIZED' ? 401 : outcome.status === 'INVALID_REQUEST' ? 400 : 200).send(outcome);
    });
    return server;
}
