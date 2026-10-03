import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { resolveTargetProject } from '../infra/firebase-target.js';
import { SUPPLIER_DISPATCH, SUPPLIER_RELAY_ALLOWLIST, type SupplierRelayEntry, type SupplierRelayPorts, type RelayOutcome } from './supplier-relay.js';

export function relayConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (key: string) => {
    const value = env[key];
    if (!value || /\s/.test(value)) throw new Error('RELAY_CONFIG_INVALID');
    return value;
  };
  const project = resolveTargetProject(env);
  const audience = required('SUPPLIER_RELAY_AUDIENCE');
  const schedulerEmail = required('SUPPLIER_RELAY_SCHEDULER_EMAIL');
  const jobPrefix = required('SUPPLIER_RELAY_JOB_PREFIX');
  const bucket = required('SUPPLIER_RELAY_PRIVATE_EVIDENCE_BUCKET');
  const secret = required('SUPPLIER_RELAY_ACTIONS_SECRET');
  const version = required('SUPPLIER_RELAY_ACTIONS_SECRET_VERSION');
  let audienceUrl: URL;
  try { audienceUrl = new URL(audience); } catch { throw new Error('RELAY_CONFIG_INVALID'); }
  if (project !== 'freepasserp5' || !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(audience)
    || env.FIREBASE_PROJECT_ID !== project || audienceUrl.username || audienceUrl.password
    || !/^[a-zA-Z0-9-]+@freepasserp5\.iam\.gserviceaccount\.com$/.test(schedulerEmail)
    || !/^projects\/freepasserp5\/locations\/[a-z0-9-]+\/jobs\/$/.test(jobPrefix)
    || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)
    || secret !== 'eancar-relay-github-token' || version !== '1')
    throw new Error('RELAY_CONFIG_INVALID');
  return Object.freeze({ project, audience, schedulerEmail, jobPrefix, bucket, secret, version });
}
export type RelayConfig = ReturnType<typeof relayConfig>;
type Pending = { key: string; outcome: RelayOutcome | 'RESERVED'; runId: string | null; reason?: string };
type Gate = { generation: string; value: Pending | null };
const keyPattern = /^[a-f0-9]{64}$/;
const runId = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ? String(value) : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;

/** GCS JSON transport reuses gcs-data-access-log's private bucket/create-only pattern.
 * Pending is a single CAS object, including an empty tombstone; no delete or lease expiry.
 * Factories perform no I/O. SDK retries are not used for mutation transports.
 */
export function createSupplierRelayPorts(config: RelayConfig, deps: {
  fetcher?: typeof fetch; accessToken?: () => Promise<string | null>;
  oidc?: Pick<OAuth2Client, 'verifyIdToken'>;
} = {}, entry: SupplierRelayEntry = SUPPLIER_DISPATCH): SupplierRelayPorts {
  if (!SUPPLIER_RELAY_ALLOWLIST.some(item => JSON.stringify(item) === JSON.stringify(entry)))
    throw new Error('RELAY_ENTRY_NOT_ALLOWLISTED');
  const fetcher = deps.fetcher ?? fetch;
  const oidc = deps.oidc ?? new OAuth2Client();
  const auth = new GoogleAuth({ projectId: config.project, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const googleToken = deps.accessToken ?? (() => auth.getAccessToken());
  const request = async (url: string, token: string, init: RequestInit = {}) => {
    if (!token || /\s/.test(token)) throw new Error('RELAY_AUTH_UNKNOWN');
    try { return await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } }); }
    catch { throw new Error('RELAY_TRANSPORT_UNKNOWN'); }
  };
  const gcs = async (url: string, init?: RequestInit) => request(url, (await googleToken()) ?? '', init);
  const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o/`;
  const name = (suffix: string) => `supplier-relay/v1/${suffix}.json`;
  const pendingName = `pending/${entry.writerGroup}`;
  const objectRead = async (suffix: string): Promise<{ generation: string; value: unknown } | null> => {
    const url = base + encodeURIComponent(name(suffix));
    const metadata = await gcs(url);
    if (metadata.status === 404) return null;
    if (!metadata.ok) throw new Error('RELAY_RECEIPT_UNKNOWN');
    const meta = await metadata.json() as { generation?: unknown };
    if (typeof meta.generation !== 'string' || !/^[1-9]\d*$/.test(meta.generation)) throw new Error('RELAY_RECEIPT_UNKNOWN');
    const media = await gcs(`${url}?alt=media&generation=${meta.generation}`);
    if (!media.ok) throw new Error('RELAY_RECEIPT_UNKNOWN');
    return { generation: meta.generation, value: await media.json() };
  };
  const write = async (suffix: string, value: unknown, generation = '0') => {
    const response = await gcs(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.bucket)}/o`
      + `?uploadType=media&name=${encodeURIComponent(name(suffix))}&ifGenerationMatch=${generation}`,
    { method: 'POST', body: JSON.stringify(value) });
    if (response.status === 412) return false;
    if (!response.ok) throw new Error('RELAY_RECEIPT_UNKNOWN');
    return true;
  };
  const assertKey = (key: string) => { if (!keyPattern.test(key)) throw new Error('RELAY_KEY_INVALID'); };
  const gate = async (): Promise<Gate> => {
    const data = await objectRead(pendingName);
    if (!data) return { generation: '0', value: null };
    const value = data.value as Pending | null;
    if (value !== null && (!value || !keyPattern.test(value.key)
      || !['RESERVED', 'ACCEPTED_PENDING', 'UNKNOWN', 'FAILED'].includes(value.outcome)
      || (value.outcome === 'ACCEPTED_PENDING' ? !runId(value.runId) : value.runId !== null && !runId(value.runId))))
      throw new Error('RELAY_PENDING_INVALID');
    return { generation: data.generation, value };
  };
  const immutable = async (suffix: string, value: unknown) => {
    if (await write(suffix, value)) return;
    const prior = await objectRead(suffix);
    if (!prior || JSON.stringify(prior.value) !== JSON.stringify(value)) throw new Error('RELAY_RECEIPT_CONFLICT');
  };
  const github = (path: string, token: string, init?: RequestInit) => request(
    `https://api.github.com/repos/${entry.repository}/actions/${path}`, token,
    { ...init, headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  const workflowPath = `.github/workflows/${entry.workflow}`;
  const ports: SupplierRelayPorts = {
    async verifyReadOnly() {
      const checks: Record<string, string> = { config: 'VERIFIED', secret: 'UNKNOWN', gcsRead: 'UNKNOWN', githubRuns: 'UNKNOWN' };
      try {
        const token = await ports.actionsToken(); checks.secret = 'VERIFIED';
        await gate(); checks.gcsRead = 'VERIFIED';
        checks.githubRuns = await ports.writerRuns(token);
      } catch { /* sanitized, read only */ }
      return { status: checks.secret === 'VERIFIED' && checks.gcsRead === 'VERIFIED'
        && checks.githubRuns !== 'UNKNOWN' ? 'VERIFIED' : 'UNKNOWN', checks };
    },
    async verifyScheduler(authorization) {
      try {
        const match = /^Bearer (\S+)$/.exec(authorization);
        if (!match) return false;
        const payload = (await oidc.verifyIdToken({ idToken: match[1]!, audience: config.audience })).getPayload();
        return !!payload && ['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)
          && payload.aud === config.audience && payload.email_verified === true && payload.email === config.schedulerEmail;
      } catch { return false; }
    },
    receipts: {
      async createOnly(receipt) { assertKey(receipt.key); return await write(`receipts/${receipt.key}`, receipt) ? 'CREATED' : 'EXISTS'; },
      async pending() { return (await gate()).value; },
      async acquirePending(key) {
        assertKey(key);
        try { const current = await gate();
          if (current.value) return 'BUSY';
          return await write(pendingName, { key, outcome: 'RESERVED', runId: null }, current.generation) ? 'ACQUIRED' : 'BUSY';
        } catch { return 'UNKNOWN'; }
      },
      async recordOutcome(key, outcome, id, reason) {
        assertKey(key);
        if (outcome === 'ACCEPTED_PENDING' ? !runId(id) : id !== null && !runId(id)) throw new Error('RELAY_OUTCOME_INVALID');
        await immutable(`outcomes/${key}`, { key, outcome, runId: id, ...(reason ? { reason } : {}) });
        // Per-tick status file, create-only (no overwrite/delete permission). The name sorts by
        // scheduleTime, so the latest status is the last object under status/<id>/.
        const receipt = (await objectRead(`receipts/${key}`))?.value as { scheduleTime?: string; jobName?: string } | undefined;
        if (!receipt?.scheduleTime || !Number.isFinite(Date.parse(receipt.scheduleTime))
          || receipt.jobName !== `${config.jobPrefix}supplier-relay-${entry.id}`) throw new Error('RELAY_RECEIPT_INVALID');
        const tick = new Date(receipt.scheduleTime).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        // An existing file for this key means this tick's status is already recorded; keep it.
        await write(`status/${entry.id}/${tick}-${key}`, { schema: 'supplier-relay-status/v1', id: entry.id,
          writerGroup: entry.writerGroup, key, jobName: receipt.jobName, scheduleTime: receipt.scheduleTime,
          observedAt: new Date().toISOString(), outcome, runId: id, reason: reason ?? null });
        if (outcome === 'SKIPPED_BUSY') return;
        const current = await gate();
        // A rejected later tick may report failure of a prior run; never mutate its owner.
        if (current.value?.key !== key) return;
        if (current.value.outcome !== 'RESERVED') throw new Error('RELAY_OWNER_CHANGED');
        if (!await write(pendingName, { key, outcome, runId: id, ...(reason ? { reason } : {}) }, current.generation)) throw new Error('RELAY_CAS_CONFLICT');
      },
      async completePending(key, id) {
        assertKey(key);
        const current = await gate();
        if (current.value?.key !== key || current.value.outcome !== 'ACCEPTED_PENDING' || current.value.runId !== id)
          throw new Error('RELAY_OWNER_CHANGED');
        await immutable(`completed/${key}`, { key, runId: id });
        if (!await write(pendingName, null, current.generation)) throw new Error('RELAY_CAS_CONFLICT');
      },
      async releaseWithoutDispatch(key) {
        assertKey(key);
        const current = await gate(), outcome = await objectRead(`outcomes/${key}`);
        const value = outcome?.value as { key?: string; outcome?: string; runId?: unknown } | undefined;
        if (current.value?.key !== key || current.value.outcome !== 'RESERVED'
          || value?.key !== key || value.outcome !== 'SKIPPED_BUSY' || value.runId !== null) throw new Error('RELAY_OWNER_CHANGED');
        if (!await write(pendingName, null, current.generation)) throw new Error('RELAY_CAS_CONFLICT');
      },
    },
    async actionsToken() {
      try {
        const response = await request(`https://secretmanager.googleapis.com/v1/projects/${config.project}/secrets/${config.secret}/versions/${config.version}:access`, (await googleToken()) ?? '');
        if (!response.ok) throw new Error();
        const body = await response.json() as { payload?: { data?: string } };
        const encoded = body.payload?.data;
        if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
        const token = Buffer.from(encoded, 'base64').toString('utf8');
        if (!token || /\s/.test(token) || !/^[\x21-\x7e]+$/.test(token)) throw new Error();
        return token;
      } catch { throw new Error('RELAY_ACTIONS_TOKEN_UNAVAILABLE'); }
    },
    async writerRuns(token, excludeRunId) {
      try {
        // A bounded complete response is required. Never infer IDLE from a truncated page.
        for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
          const response = await github(`workflows/${entry.workflow}/runs?status=${status}&per_page=100&page=1`, token);
          if (!response.ok || response.headers.get('link')?.includes('rel="next"')) return 'UNKNOWN';
          const body = await response.json() as { total_count?: number; workflow_runs?: Array<{ id?: unknown; status?: string; path?: string }> };
          if (!Number.isSafeInteger(body.total_count) || !Array.isArray(body.workflow_runs)
            || body.total_count !== body.workflow_runs.length || body.workflow_runs.length >= 100
            || body.workflow_runs.some(run => !runId(run.id) || run.path !== workflowPath || run.status !== status)) return 'UNKNOWN';
          if (body.workflow_runs.some(run => runId(run.id) !== excludeRunId)) return 'BUSY';
        }
        return 'IDLE';
      } catch { return 'UNKNOWN'; }
    },
    async runStatus(token, id) {
      try {
        if (!runId(id)) return 'UNKNOWN';
        const response = await github(`runs/${id}`, token);
        if (!response.ok) return 'UNKNOWN';
        const body = await response.json() as { id?: unknown; status?: string; path?: string; conclusion?: string };
        if (runId(body.id) !== id || body.path !== workflowPath) return 'UNKNOWN';
        if (body.status === 'completed') return body.conclusion === 'success' ? 'COMPLETED'
          : ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(body.conclusion ?? '') ? 'FAILED' : 'UNKNOWN';
        return ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(body.status ?? '') ? 'INCOMPLETE' : 'UNKNOWN';
      } catch { return 'UNKNOWN'; }
    },
    async dispatch(token, binding) {
      try {
        if (entry.hold || JSON.stringify(binding) !== JSON.stringify(entry)) return { status: 'UNKNOWN' };
        const response = await github(`workflows/${entry.workflow}/dispatches`, token, { method: 'POST',
          body: JSON.stringify({ ref: entry.ref, inputs: entry.inputs, return_run_details: true }) });
        if (!response.ok) return { status: 'UNKNOWN' };
        const body = await response.json() as { workflow_run_id?: unknown };
        const id = runId(body.workflow_run_id);
        return id ? { status: 'ACCEPTED', runId: id } : { status: 'UNKNOWN' };
      } catch { return { status: 'UNKNOWN' }; }
    },
  };
  return ports;
}
