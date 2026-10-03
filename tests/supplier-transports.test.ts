import { describe, expect, it, vi } from 'vitest';
import type { OAuth2Client } from 'google-auth-library';
import { createIancarRelayPorts, relayConfig } from '../src/api/iancar-relay-transport.js';
import { IANCAR_DISPATCH } from '../src/api/iancar-scheduler-relay.js';
import { startIancarRelay } from '../src/jobs/serve-iancar-relay.js';
import { captureAica, aicaCaptureCommand } from '../src/jobs/collect-aica.js';
import { ironDetailReader, ironRobotsAllow } from '../src/infra/iron-detail-reader.js';
import { ironSourceAdapter } from '../src/adapters/supplier-source-capture.js';

const env = { FIREBASE_PROJECT_ID: 'freepasserp5', IANCAR_RELAY_AUDIENCE: 'https://relay.example.test',
  IANCAR_RELAY_SCHEDULER_EMAIL: 'scheduler@freepasserp5.iam.gserviceaccount.com',
  IANCAR_RELAY_JOB_NAME: 'projects/freepasserp5/locations/test/jobs/test',
  IANCAR_RELAY_PRIVATE_EVIDENCE_BUCKET: 'fixture-private', IANCAR_RELAY_ACTIONS_SECRET: 'fixture-actions',
  IANCAR_RELAY_ACTIONS_SECRET_VERSION: '1' };
const config = relayConfig(env), key = 'a'.repeat(64), other = 'b'.repeat(64);
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, ...(headers ? { headers } : {}) });
const workflowPath = `.github/workflows/${IANCAR_DISPATCH.workflow}`;
function ports(fetcher: typeof fetch) { return createIancarRelayPorts(config, { fetcher, accessToken: async () => 'fixture-google' }); }

function bucket() {
  let counter = 0;
  const objects = new Map<string, { generation: string; value: unknown }>();
  const writes: Array<{ name: string; generation: string; value: unknown }> = [];
  let failWrite = 0, failMedia = 0, failPending = false;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') {
      const name = url.searchParams.get('name')!, generation = url.searchParams.get('ifGenerationMatch')!;
      const value = JSON.parse(String(init.body));
      writes.push({ name, generation, value });
      if (failPending && name.endsWith('/pending.json')) { failPending = false; return json({}, 412); }
      if (failWrite) { const status = failWrite; failWrite = 0; return json({}, status); }
      if ((objects.get(name)?.generation ?? '0') !== generation) return json({}, 412);
      objects.set(name, { generation: String(++counter), value }); return json({});
    }
    const name = decodeURIComponent(url.pathname.split('/o/')[1]!);
    const object = objects.get(name);
    if (!object) return json({}, 404);
    if (url.searchParams.has('alt')) {
      if (failMedia) { const status = failMedia; failMedia = 0; return json({}, status); }
      if (url.searchParams.get('generation') !== object.generation) return json({}, 404);
      return json(object.value);
    }
    return json({ generation: object.generation });
  }) as unknown as ReturnType<typeof vi.fn<typeof fetch>>;
  return { p: ports(fetcher), objects, writes, fetcher,
    failPending: () => { failPending = true; },
    failWrite: (status: number) => { failWrite = status; }, failMedia: (status: number) => { failMedia = status; } };
}

describe('relay config and OIDC', () => {
  it('refuses missing/whitespace config before startup', async () => {
    for (const field of Object.keys(env)) {
      expect(() => relayConfig({ ...env, [field]: '' })).toThrow();
      expect(() => relayConfig({ ...env, [field]: ' ' })).toThrow();
    }
    await expect(startIancarRelay({})).rejects.toThrow();
    await expect(startIancarRelay({ ...env, PORT: '0' })).rejects.toThrow('RELAY_PORT_INVALID');
    expect(() => relayConfig({ ...env, IANCAR_RELAY_AUDIENCE: 'https://user@host' })).toThrow();
  });
  it('checks exact audience issuer verified email and fixed SA; exceptions fail closed', async () => {
    const good = { iss: 'https://accounts.google.com', aud: config.audience, email_verified: true, email: config.schedulerEmail };
    const verifyIdToken = vi.fn().mockResolvedValue({ getPayload: () => good });
    const p = createIancarRelayPorts(config, { oidc: { verifyIdToken } as unknown as Pick<OAuth2Client, 'verifyIdToken'> });
    expect(await p.verifyScheduler('Bearer fixture-id')).toBe(true);
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'fixture-id', audience: config.audience });
    for (const change of [{ iss: 'evil' }, { aud: 'wrong' }, { email_verified: false }, { email: 'other@test' }]) {
      verifyIdToken.mockResolvedValue({ getPayload: () => ({ ...good, ...change }) });
      expect(await p.verifyScheduler('Bearer fixture-id')).toBe(false);
    }
    verifyIdToken.mockRejectedValue(new Error('private raw error'));
    expect(await p.verifyScheduler('Bearer fixture-id')).toBe(false);
    expect(await p.verifyScheduler('')).toBe(false);
  });
});

describe('GCS immutable receipts and single-object CAS', () => {
  it('creates receipt only once; empty 404 permits exactly one concurrent admission', async () => {
    const b = bucket();
    const receipt = { key, jobName: config.jobName, scheduleTime: '2026-10-03T00:00:00Z' };
    expect(await b.p.receipts.createOnly(receipt)).toBe('CREATED');
    expect(await b.p.receipts.createOnly(receipt)).toBe('EXISTS');
    expect(await b.p.receipts.pending()).toBeNull();
    const results = await Promise.all([b.p.receipts.acquirePending(key), b.p.receipts.acquirePending(other)]);
    expect(results.sort()).toEqual(['ACQUIRED', 'BUSY']);
    expect(b.writes.every(w => w.generation === '0')).toBe(true);
  });
  it('records accepted outcome then completes exact owner/run with CAS tombstone', async () => {
    const b = bucket();
    await b.p.receipts.acquirePending(key);
    await b.p.receipts.recordOutcome(key, 'ACCEPTED_PENDING', '12');
    expect(await b.p.receipts.pending()).toEqual({ key, outcome: 'ACCEPTED_PENDING', runId: '12' });
    await expect(b.p.receipts.completePending(other, '12')).rejects.toThrow('OWNER_CHANGED');
    await expect(b.p.receipts.completePending(key, '13')).rejects.toThrow('OWNER_CHANGED');
    await b.p.receipts.completePending(key, '12');
    expect(await b.p.receipts.pending()).toBeNull();
    expect(await b.p.receipts.acquirePending(other)).toBe('ACQUIRED');
    expect(b.writes.filter(w => w.name.includes('/outcomes/') || w.name.includes('/completed/')).every(w => w.generation === '0')).toBe(true);
    expect(b.writes.filter(w => w.value === null).every(w => w.generation !== '0')).toBe(true);
  });
  it('never clears UNKNOWN and releases RESERVED only with durable no-dispatch evidence', async () => {
    const b = bucket();
    await b.p.receipts.acquirePending(key);
    await expect(b.p.receipts.releaseWithoutDispatch(key)).rejects.toThrow();
    await b.p.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
    await b.p.receipts.releaseWithoutDispatch(key);
    await b.p.receipts.acquirePending(other);
    await b.p.receipts.recordOutcome(other, 'UNKNOWN', null);
    await expect(b.p.receipts.releaseWithoutDispatch(other)).rejects.toThrow();
    expect(await b.p.receipts.acquirePending(key)).toBe('BUSY');
  });
  it('CAS conflict, pinned generation 404, storage errors and conflicting outcome fail closed', async () => {
    const b = bucket();
    b.failWrite(404); expect(await b.p.receipts.acquirePending(key)).toBe('UNKNOWN');
    b.failWrite(412); expect(await b.p.receipts.acquirePending(key)).toBe('BUSY');
    await b.p.receipts.acquirePending(key);
    b.failMedia(404); await expect(b.p.receipts.pending()).rejects.toThrow();
    await b.p.receipts.recordOutcome(key, 'SKIPPED_BUSY', null);
    await expect(b.p.receipts.recordOutcome(key, 'UNKNOWN', null)).rejects.toThrow('CONFLICT');
    b.failWrite(412); await expect(b.p.receipts.releaseWithoutDispatch(key)).rejects.toThrow('CAS_CONFLICT');
    expect((await b.p.receipts.pending())?.key).toBe(key);
  });
  it('outcome/complete CAS loss never releases the owner or overwrites immutable evidence', async () => {
    const b = bucket();
    await b.p.receipts.acquirePending(key);
    b.failPending();
    await expect(b.p.receipts.recordOutcome(key, 'ACCEPTED_PENDING', '12')).rejects.toThrow('CAS_CONFLICT');
    expect((await b.p.receipts.pending())?.outcome).toBe('RESERVED');
    expect(await b.p.receipts.acquirePending(other)).toBe('BUSY');
    // Same immutable outcome is idempotent; a different outcome is rejected.
    await b.p.receipts.recordOutcome(key, 'ACCEPTED_PENDING', '12');
    b.failPending();
    await expect(b.p.receipts.completePending(key, '12')).rejects.toThrow('CAS_CONFLICT');
    expect((await b.p.receipts.pending())?.outcome).toBe('ACCEPTED_PENDING');
    await b.p.receipts.completePending(key, '12');
    expect(await b.p.receipts.pending()).toBeNull();
  });
});

describe('fixed GitHub REST ports', () => {
  it('queries all incomplete states and rejects truncated/malformed/error responses', async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => json({ total_count: 0, workflow_runs: [] }));
    expect(await ports(f).writerRuns('fixture-pat')).toBe('IDLE'); expect(f).toHaveBeenCalledTimes(5);
    for (const response of [json({}, 404), json({ total_count: 1, workflow_runs: [] }),
      json({ total_count: 0, workflow_runs: [] }, 200, { link: '<next>; rel="next"' }), json({})]) {
      f.mockResolvedValue(response); expect(await ports(f).writerRuns('fixture-pat')).toBe('UNKNOWN');
    }
    f.mockResolvedValue(json({ total_count: 1, workflow_runs: [{ id: 12, status: 'queued', path: workflowPath }] }));
    expect(await ports(f).writerRuns('fixture-pat')).toBe('BUSY');
  });
  it('requires exact correlated run and workflow; 404 and unknown status remain UNKNOWN', async () => {
    const f = vi.fn<typeof fetch>();
    for (const [response, expected] of [[json({}, 404), 'UNKNOWN'],
      [json({ id: 13, path: workflowPath, status: 'completed' }), 'UNKNOWN'],
      [json({ id: 12, path: 'other', status: 'completed' }), 'UNKNOWN'],
      [json({ id: 12, path: workflowPath, status: 'new_status' }), 'UNKNOWN'],
      [json({ id: 12, path: workflowPath, status: 'completed' }), 'COMPLETED'],
      [json({ id: 12, path: workflowPath, status: 'waiting' }), 'INCOMPLETE']] as const) {
      f.mockResolvedValue(response); expect(await ports(f).runStatus('fixture-pat', '12')).toBe(expected);
    }
  });
  it('requests run details once; missing run ID, HTTP failure and response loss are UNKNOWN without retry', async () => {
    const f = vi.fn<typeof fetch>();
    for (const response of [new Response(null, { status: 204 }), json({}), json({}, 500)]) {
      f.mockClear().mockResolvedValue(response);
      expect(await ports(f).dispatch('fixture-pat', IANCAR_DISPATCH)).toEqual({ status: 'UNKNOWN' });
      expect(f).toHaveBeenCalledTimes(1);
    }
    f.mockClear().mockResolvedValue(json({ workflow_run_id: 12 }));
    expect(await ports(f).dispatch('fixture-pat', IANCAR_DISPATCH)).toEqual({ status: 'ACCEPTED', runId: '12' });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain(`${IANCAR_DISPATCH.repository}/actions/workflows/${IANCAR_DISPATCH.workflow}/dispatches`);
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main', inputs: IANCAR_DISPATCH.inputs, return_run_details: true });
    f.mockClear().mockRejectedValue(new Error('fixture-pat raw response'));
    expect(await ports(f).dispatch('fixture-pat', IANCAR_DISPATCH)).toEqual({ status: 'UNKNOWN' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('reads one configured secret in memory; rejects whitespace and never logs token/raw errors', async () => {
    const log = vi.spyOn(console, 'log'), error = vi.spyOn(console, 'error');
    try {
      const f = vi.fn<typeof fetch>().mockResolvedValue(json({ payload: { data: Buffer.from('fixture-pat').toString('base64') } }));
      expect(await ports(f).actionsToken()).toBe('fixture-pat');
      expect(String(f.mock.calls[0]![0])).toContain('/secrets/fixture-actions/versions/1:access');
      for (const value of ['', ' ', 'fixture-pat\n']) {
        f.mockResolvedValue(json({ payload: { data: Buffer.from(value).toString('base64') } }));
        await expect(ports(f).actionsToken()).rejects.toThrow('RELAY_ACTIONS_TOKEN_UNAVAILABLE');
      }
      f.mockRejectedValue(new Error('fixture-pat PRIVATE RESPONSE'));
      await expect(ports(f).actionsToken()).rejects.toThrow(/^RELAY_ACTIONS_TOKEN_UNAVAILABLE$/);
      expect(await ports(f).writerRuns('fixture-pat')).toBe('UNKNOWN');
      expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});

describe('Aica capture command', () => {
  const binding = { sheetId: 'fixture-sheet', tabId: 1, range: 'Cars!A1:B10', plateColumn: 0 };
  const now = '2026-10-03T00:00:00.000Z';
  const grid = { ...binding, revision: 'fixture', observedAt: now, complete: true, expectedRows: 1,
    firstDataRow: 1, headers: [{ formattedValue: 'plate' }], rows: [[{ formattedValue: 'fixture-private-plate' }]] };
  it('prints only counts/digest/issues and defaults to no ingestion', async () => {
    const ingest = vi.fn(), readGrid = vi.fn().mockResolvedValue(grid);
    const report = await captureAica({ bindings: [binding], expectedFreshnessSeconds: 60, applyRaw: false, approved: false },
      { readGrid, ingestRawBatch: ingest, now: () => now });
    expect(Object.keys(report).sort()).toEqual(['counts', 'digest', 'issues']);
    expect(JSON.stringify(report)).not.toContain('fixture-private-plate'); expect(ingest).not.toHaveBeenCalled();
  });
  it('requires both approval and apply plus complete evidence; approved partial remains HOLD', async () => {
    const ingest = vi.fn(), readGrid = vi.fn().mockResolvedValue(grid);
    const input = { bindings: [binding], expectedFreshnessSeconds: 60, applyRaw: true, approved: false };
    await expect(captureAica(input, { readGrid, ingestRawBatch: ingest })).rejects.toThrow('APPROVAL');
    expect(readGrid).not.toHaveBeenCalled();
    await captureAica({ ...input, approved: true }, { readGrid, ingestRawBatch: ingest, now: () => now });
    expect(ingest).toHaveBeenCalledTimes(1);
    readGrid.mockResolvedValue({ ...grid, complete: false });
    await expect(captureAica({ ...input, approved: true }, { readGrid, ingestRawBatch: ingest, now: () => now })).rejects.toThrow('SOURCE_HOLD');
    expect(ingest).toHaveBeenCalledTimes(1);
    await expect(aicaCaptureCommand(['--unexpected'], {})).rejects.toThrow('OPTIONS');
    await expect(aicaCaptureCommand([], {})).rejects.toThrow('BINDINGS');
  });
});

describe('Iron opt-in read-only fetcher', () => {
  const target = (id: string) => ({ id, plate: `fixture-${id}`, url: `https://ironrentcar.com/vehicles/${id}` });
  it('makes zero calls without approval; robots failure refuses details', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json({}, 404));
    await expect(ironDetailReader({ env: {}, fetcher: f })(target('1'))).rejects.toThrow('APPROVAL_HOLD');
    expect(f).not.toHaveBeenCalled();
    await expect(ironDetailReader({ env: { IRON_FETCH_APPROVED: 'true' }, fetcher: f })(target('1'))).rejects.toThrow('ROBOTS_HOLD');
    expect(f).toHaveBeenCalledTimes(1); expect(String(f.mock.calls[0]![0])).toMatch(/robots.txt$/);
    expect(ironRobotsAllow('User-agent: *\nDisallow: /')).toBe(false);
    expect(ironRobotsAllow('<html>error</html>')).toBe(false);
    expect(ironRobotsAllow('User-agent: *\nDisallow:\nUser-agent: FreePassData\nDisallow: /')).toBe(false);
  });
  it('shares one robots read, bounds concurrency at two and never retries a vehicle', async () => {
    let active = 0, maximum = 0;
    const f = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(new Headers(init?.headers).get('user-agent')).toBe('FreePassData-ApprovedCapture/1.0');
      expect(init?.redirect).toBe('error');
      if (String(url).endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow:');
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return new Response('<html>fixture</html>', { headers: { 'content-type': 'text/html' } });
    });
    const reader = ironDetailReader({ env: { IRON_FETCH_APPROVED: 'true' }, fetcher: f });
    await Promise.all(['1', '2', '3', '4'].map(id => reader(target(id))));
    expect(maximum).toBe(2); expect(f).toHaveBeenCalledTimes(5);
    await expect(reader(target('1'))).rejects.toThrow('ALREADY_ATTEMPTED'); expect(f).toHaveBeenCalledTimes(5);
  });
  it('composes with existing SourceIntakeBatch adapter and preserves partial coverage', async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/robots.txt')
      ? new Response('User-agent: *\nDisallow:') : new Response('<html>fixture</html>', { headers: { 'content-type': 'text/html' } }));
    const batch = await ironSourceAdapter({ sourceId: 'supplier:RP006:fixture', targets: [target('1')], expectedFreshnessSeconds: 60,
      fetchDetail: ironDetailReader({ env: { IRON_FETCH_APPROVED: 'true' }, fetcher: f }) }).read();
    expect(batch.coverage.mode).toBe('PARTIAL'); expect(batch.records).toHaveLength(1);
  });
  it('does not retry HTTP failure or fetch a redirected/non-allowlisted target', async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/robots.txt')
      ? new Response('User-agent: *\nDisallow:') : json({}, 503));
    const reader = ironDetailReader({ env: { IRON_FETCH_APPROVED: 'true' }, fetcher: f });
    await expect(reader({ ...target('1'), url: 'https://other.test/vehicles/1' })).rejects.toThrow('TARGET_HOLD');
    expect(f).not.toHaveBeenCalled();
    await expect(reader(target('1'))).rejects.toThrow('DETAIL_READ_HOLD');
    await expect(reader(target('1'))).rejects.toThrow('ALREADY_ATTEMPTED');
    expect(f).toHaveBeenCalledTimes(2);
  });
});
