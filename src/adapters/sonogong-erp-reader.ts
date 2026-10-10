import { createHash } from 'node:crypto';
import type { SonogongBucketObservation } from './supplier-source-capture.js';

/** One transport policy. No file cache, arbitrary host, or caller-supplied endpoint. */
export const SONOGONG_READER_POLICY = Object.freeze({
  origin: 'https://sokrc.com', concurrency: 1, minIntervalMs: 250,
  timeoutMs: 15_000, maxRetries: 3, backoffMs: 500,
  pageSize: 100, maxPages: 100, maxDetails: 1_000,
  freshnessSeconds: 3_600, tokenSkewMs: 60_000, maxTokenLifetimeMs: 8 * 3_600_000,
  pollIntervalMinutes: 15,
});
type Json = Record<string, unknown>;
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
type Code = 'SONOGONG_ACCOUNT_REQUIRED' | 'SONOGONG_AUTH_FAILED' | 'SONOGONG_HTTP_FAILED'
  | 'SONOGONG_RETRY_EXHAUSTED' | 'SONOGONG_TRANSPORT_FAILED' | 'SONOGONG_INVALID_RESPONSE'
  | 'SONOGONG_STALE' | 'SONOGONG_SOURCE_TIME_INVALID' | 'SONOGONG_LIMIT' | 'SONOGONG_INVALID_BUCKET';
export class SonogongReaderError extends Error {
  constructor(readonly code: Code) { super(code); this.name = 'SonogongReaderError'; }
}
function fail(code: Code): never { throw new SonogongReaderError(code); }

/** A reader instance is one capture. Credentials are acquired only at login. */
export function createSonogongErpReader(input: {
  accountJson: string | (() => string | Promise<string>);
  fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
}) {
  const policy = SONOGONG_READER_POLICY;
  const send = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let token: { value: string; expiresAt: number } | undefined;
  let loginFlight: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;
  let detailCount = 0;

  // Serialize all HTTP calls (including login/retries), with a start-time interval.
  async function request(path: string, init: RequestInit): Promise<{ body: Json; status: number; sourceTime: number }> {
    const job = queue.then(async () => {
      for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
        await sleep(Math.max(0, policy.minIntervalMs - (now() - lastStart)));
        lastStart = now();
        let response: Response;
        let body: unknown;
        try {
          response = await send(new URL('/api' + path, policy.origin), {
            ...init, redirect: 'error', signal: AbortSignal.timeout(policy.timeoutMs),
          });
          if (response.status === 429 || response.status >= 500) {
            await response.body?.cancel();
            if (attempt === policy.maxRetries) fail('SONOGONG_RETRY_EXHAUSTED');
            await sleep(policy.backoffMs * 2 ** attempt);
            continue;
          }
          if (response.status !== 200) {
            await response.body?.cancel();
            return { body: {}, status: response.status, sourceTime: lastStart };
          }
          body = await response.json();
        } catch (error) {
          if (error instanceof SonogongReaderError) throw error;
          // Never retain cause, URL, response body, or a transport error message.
          fail('SONOGONG_TRANSPORT_FAILED');
        }
        if (!object(body) || body.success === false) fail('SONOGONG_INVALID_RESPONSE');
        let sourceTime = lastStart;
        if (path !== '/auth/login') {
          const data = object(body.data) ? body.data : {};
          const attrs = object(data.attrs) ? data.attrs : {};
          if ([body, data, attrs].some(v => v.stale === true)) fail('SONOGONG_STALE');
          const dates: unknown[] = [body.syncedAt, data.syncedAt, attrs.syncedAt, response.headers.get('date')];
          for (const date of dates.filter(v => v !== undefined && v !== null)) {
            const time = typeof date === 'string' ? Date.parse(date) : NaN;
            if (!Number.isFinite(time) || time > now() + policy.tokenSkewMs) fail('SONOGONG_SOURCE_TIME_INVALID');
            sourceTime = Math.min(sourceTime, time);
          }
          const age = response.headers.get('age');
          if (age !== null) {
            if (!/^\d+$/.test(age)) fail('SONOGONG_SOURCE_TIME_INVALID');
            sourceTime = Math.min(sourceTime, lastStart - Number(age) * 1000);
          }
          if (now() - sourceTime > policy.freshnessSeconds * 1000) fail('SONOGONG_STALE');
        }
        return { body, status: response.status, sourceTime };
      }
      return fail('SONOGONG_RETRY_EXHAUSTED');
    });
    queue = job.catch(() => undefined);
    return job;
  }

  async function login() {
    if (loginFlight) return loginFlight;
    loginFlight = (async () => {
      let account: unknown;
      try { account = JSON.parse(typeof input.accountJson === 'function' ? await input.accountJson() : input.accountJson); }
      catch { fail('SONOGONG_ACCOUNT_REQUIRED'); }
      if (!object(account) || typeof account.id !== 'string' || !account.id.trim()
        || typeof account.password !== 'string' || !account.password) fail('SONOGONG_ACCOUNT_REQUIRED');
      const result = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: account.id, password: account.password }) });
      if (result.status !== 200 || !object(result.body.data)
        || typeof result.body.data.accessToken !== 'string') fail('SONOGONG_AUTH_FAILED');
      const value = result.body.data.accessToken;
      let expiry: unknown;
      try { expiry = JSON.parse(Buffer.from(value.split('.')[1] ?? '', 'base64url').toString('utf8')).exp; }
      catch { fail('SONOGONG_AUTH_FAILED'); }
      if (typeof expiry !== 'number' || !Number.isFinite(expiry)
        || expiry * 1000 <= now() + policy.tokenSkewMs) fail('SONOGONG_AUTH_FAILED');
      token = { value, expiresAt: Math.min(expiry * 1000, now() + policy.maxTokenLifetimeMs) };
    })();
    try { await loginFlight; } finally { loginFlight = undefined; }
  }
  async function get(path: string) {
    if (!token || token.expiresAt <= now() + policy.tokenSkewMs) await login();
    const usedToken = token!;
    let result = await request(path, { headers: { Authorization: `Bearer ${usedToken.value}` } });
    if (result.status === 401) {
      if (token === usedToken) { token = undefined; await login(); }
      else if (!token) await login();
      result = await request(path, { headers: { Authorization: `Bearer ${token!.value}` } });
    }
    if (result.status === 401 || result.status === 403) fail('SONOGONG_AUTH_FAILED');
    if (result.status !== 200) fail('SONOGONG_HTTP_FAILED');
    return result;
  }

  async function readBucket(bucket: SonogongBucketObservation['bucket']): Promise<SonogongBucketObservation> {
    if (!['LOW_SONOKONG_DAILY', 'LOW_SONOKONG', 'LOW_TCAR'].includes(bucket)) fail('SONOGONG_INVALID_BUCKET');
    const lists: Json[] = [], pages: Json[] = [];
    const ids = new Set<string>();
    let total: number | undefined;
    let observed = now();
    for (let page = 1; page <= policy.maxPages; page++) {
      const query = new URLSearchParams({ carSource: bucket, page: String(page), pageSize: String(policy.pageSize) });
      const result = await get('/product/homepage/list?' + query);
      observed = Math.min(observed, result.sourceTime);
      const data = result.body.data;
      if (!object(data) || !Array.isArray(data.data) || !object(data.attrs)
        || !Number.isSafeInteger(data.attrs.totalCount) || (data.attrs.totalCount as number) < 0
        || (data.attrs.currentPage !== undefined && data.attrs.currentPage !== page)) fail('SONOGONG_INVALID_RESPONSE');
      const count = data.attrs.totalCount as number;
      if (total !== undefined && total !== count) fail('SONOGONG_INVALID_RESPONSE');
      total = count;
      if (total + detailCount > policy.maxDetails) fail('SONOGONG_LIMIT');
      pages.push(result.body);
      for (const row of data.data) {
        if (!object(row) || !['string', 'number'].includes(typeof row.id) || !String(row.id).trim()
          || ids.has(String(row.id))) fail('SONOGONG_INVALID_RESPONSE');
        ids.add(String(row.id)); lists.push(row);
      }
      if (lists.length > total) fail('SONOGONG_INVALID_RESPONSE');
      if (lists.length === total) break;
      if (!data.data.length) fail('SONOGONG_INVALID_RESPONSE');
      if (page === policy.maxPages) fail('SONOGONG_LIMIT');
    }
    const records: SonogongBucketObservation['records'] = [];
    let complete = true;
    for (const list of lists) {
      if (++detailCount > policy.maxDetails) fail('SONOGONG_LIMIT');
      try {
        const result = await get('/product/homepage/view/' + encodeURIComponent(String(list.id)));
        observed = Math.min(observed, result.sourceTime);
        if (!object(result.body.data)) fail('SONOGONG_INVALID_RESPONSE');
        const detail = result.body.data;
        // estimates are embedded in view; never guess a separate estimates endpoint.
        const estimatesComplete = Array.isArray(detail.estimates) && detail.estimates.length > 0 && detail.estimates.every(object);
        complete &&= estimatesComplete;
        records.push({ list, detail, detailResponse: result.body });
      } catch (error) {
        if (!(error instanceof SonogongReaderError)
          || !['SONOGONG_HTTP_FAILED', 'SONOGONG_INVALID_RESPONSE', 'SONOGONG_TRANSPORT_FAILED'].includes(error.code)) throw error;
        complete = false;
        records.push({ list, detail: null });
      }
    }
    if (now() - observed > policy.freshnessSeconds * 1000) fail('SONOGONG_STALE');
    return { bucket, observedAt: new Date(observed).toISOString(), declaredTotal: total ?? null, complete,
      revision: createHash('sha256').update(JSON.stringify({ pages, records })).digest('hex'), records,
      listResponses: pages };
  }
  return { readBucket };
}
