import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { resolveTargetProject } from '../infra/firebase-target.js';
import { IANCAR_DISPATCH, type IancarRelayPorts, type RelayOutcome } from './iancar-scheduler-relay.js';

export function relayConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (key: string) => {
    const value = env[key];
    if (!value || /\s/.test(value)) throw new Error('RELAY_CONFIG_INVALID');
    return value;
  };
  const project = resolveTargetProject(env);
  const audience = required('IANCAR_RELAY_AUDIENCE');
  const schedulerEmail = required('IANCAR_RELAY_SCHEDULER_EMAIL');
  const jobName = required('IANCAR_RELAY_JOB_NAME');
  const bucket = required('IANCAR_RELAY_PRIVATE_EVIDENCE_BUCKET');
  const secret = required('IANCAR_RELAY_ACTIONS_SECRET');
  const version = required('IANCAR_RELAY_ACTIONS_SECRET_VERSION');
  let audienceUrl: URL;
  try { audienceUrl = new URL(audience); } catch { throw new Error('RELAY_CONFIG_INVALID'); }
  if (project !== 'freepasserp5' || !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(audience)
    || env.FIREBASE_PROJECT_ID !== project || audienceUrl.username || audienceUrl.password
    || !/^[a-zA-Z0-9-]+@freepasserp5\.iam\.gserviceaccount\.com$/.test(schedulerEmail)
    || !/^projects\/freepasserp5\/locations\/[a-z0-9-]+\/jobs\/[a-zA-Z0-9_-]+$/.test(jobName)
    || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)
    || !/^[a-zA-Z0-9_-]+$/.test(secret) || !/^(?:latest|[1-9]\d*)$/.test(version))
    throw new Error('RELAY_CONFIG_INVALID');
  return Object.freeze({ project, audience, schedulerEmail, jobName, bucket, secret, version });
}
export type RelayConfig = ReturnType<typeof relayConfig>;
type Pending = { key: string; outcome: RelayOutcome | 'RESERVED'; runId: string | null };
type Gate = { generation: string; value: Pending | null };
const keyPattern = /^[a-f0-9]{64}$/;
const runId = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ? String(value) : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;

/** GCS JSON transport reuses gcs-data-access-log's private bucket/create-only pattern.
 * Pending is a single CAS object, including an empty tombstone; no delete or lease expiry.
 * Factories perform no I/O. SDK retries are not used for mutation transports.
 */
export function createIancarRelayPorts(config: RelayConfig, deps: {
  fetcher?: typeof fetch; accessToken?: () => Promise<string | null>;
  oidc?: Pick<OAuth2Client, 'verifyIdToken'>;
} = {}): IancarRelayPorts {
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
  const name = (suffix: string) => `iancar-relay/v1/${suffix}.json`;
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
    const data = await objectRead('pending');
    if (!data) return { generation: '0', value: null };
    const value = data.value as Pending | null;
    if (value !== null && (!value || !keyPattern.test(value.key)
      || !['RESERVED', 'ACCEPTED_PENDING', 'UNKNOWN'].includes(value.outcome)
      || (value.outcome === 'ACCEPTED_PENDING' ? !runId(value.runId) : value.runId !== null)))
      throw new Error('RELAY_PENDING_INVALID');
    return { generation: data.generation, value };
  };
  const immutable = async (suffix: string, value: unknown) => {
    if (await write(suffix, value)) return;
    const prior = await objectRead(suffix);
    if (!prior || JSON.stringify(prior.value) !== JSON.stringify(value)) throw new Error('RELAY_RECEIPT_CONFLICT');
  };
  const github = (path: string, token: string, init?: RequestInit) => request(
    `https://api.github.com/repos/${IANCAR_DISPATCH.repository}/actions/${path}`, token,
    { ...init, headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  const workflowPath = `.github/workflows/${IANCAR_DISPATCH.workflow}`;
  return {
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
          return await write('pending', { key, outcome: 'RESERVED', runId: null }, current.generation) ? 'ACQUIRED' : 'BUSY';
        } catch { return 'UNKNOWN'; }
      },
      async recordOutcome(key, outcome, id) {
        assertKey(key);
        if (outcome === 'ACCEPTED_PENDING' ? !runId(id) : id !== null) throw new Error('RELAY_OUTCOME_INVALID');
        await immutable(`outcomes/${key}`, { key, outcome, runId: id });
        if (outcome === 'SKIPPED_BUSY') return;
        const current = await gate();
        if (current.value?.key !== key || current.value.outcome !== 'RESERVED') throw new Error('RELAY_OWNER_CHANGED');
        if (!await write('pending', { key, outcome, runId: id }, current.generation)) throw new Error('RELAY_CAS_CONFLICT');
      },
      async completePending(key, id) {
        assertKey(key);
        const current = await gate();
        if (current.value?.key !== key || current.value.outcome !== 'ACCEPTED_PENDING' || current.value.runId !== id)
          throw new Error('RELAY_OWNER_CHANGED');
        await immutable(`completed/${key}`, { key, runId: id });
        if (!await write('pending', null, current.generation)) throw new Error('RELAY_CAS_CONFLICT');
      },
      async releaseWithoutDispatch(key) {
        assertKey(key);
        const current = await gate(), outcome = await objectRead(`outcomes/${key}`);
        const value = outcome?.value as { key?: string; outcome?: string; runId?: unknown } | undefined;
        if (current.value?.key !== key || current.value.outcome !== 'RESERVED'
          || value?.key !== key || value.outcome !== 'SKIPPED_BUSY' || value.runId !== null) throw new Error('RELAY_OWNER_CHANGED');
        if (!await write('pending', null, current.generation)) throw new Error('RELAY_CAS_CONFLICT');
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
    async writerRuns(token) {
      try {
        // A bounded complete response is required. Never infer IDLE from a truncated page.
        for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
          const response = await github(`workflows/${IANCAR_DISPATCH.workflow}/runs?status=${status}&per_page=100&page=1`, token);
          if (!response.ok || response.headers.get('link')?.includes('rel="next"')) return 'UNKNOWN';
          const body = await response.json() as { total_count?: number; workflow_runs?: Array<{ id?: unknown; status?: string; path?: string }> };
          if (!Number.isSafeInteger(body.total_count) || !Array.isArray(body.workflow_runs)
            || body.total_count !== body.workflow_runs.length || body.workflow_runs.length >= 100
            || body.workflow_runs.some(run => !runId(run.id) || run.path !== workflowPath || run.status !== status)) return 'UNKNOWN';
          if (body.workflow_runs.length) return 'BUSY';
        }
        return 'IDLE';
      } catch { return 'UNKNOWN'; }
    },
    async runStatus(token, id) {
      try {
        if (!runId(id)) return 'UNKNOWN';
        const response = await github(`runs/${id}`, token);
        if (!response.ok) return 'UNKNOWN';
        const body = await response.json() as { id?: unknown; status?: string; path?: string };
        if (runId(body.id) !== id || body.path !== workflowPath) return 'UNKNOWN';
        if (body.status === 'completed') return 'COMPLETED';
        return ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(body.status ?? '') ? 'INCOMPLETE' : 'UNKNOWN';
      } catch { return 'UNKNOWN'; }
    },
    async dispatch(token, binding) {
      try {
        if (JSON.stringify(binding) !== JSON.stringify(IANCAR_DISPATCH)) return { status: 'UNKNOWN' };
        const response = await github(`workflows/${IANCAR_DISPATCH.workflow}/dispatches`, token, { method: 'POST',
          body: JSON.stringify({ ref: IANCAR_DISPATCH.ref, inputs: IANCAR_DISPATCH.inputs, return_run_details: true }) });
        if (!response.ok) return { status: 'UNKNOWN' };
        const body = await response.json() as { workflow_run_id?: unknown };
        const id = runId(body.workflow_run_id);
        return id ? { status: 'ACCEPTED', runId: id } : { status: 'UNKNOWN' };
      } catch { return { status: 'UNKNOWN' }; }
    },
  };
}
