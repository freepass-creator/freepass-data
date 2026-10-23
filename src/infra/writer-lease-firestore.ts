import { decodeFields, encodeFields, gcloudUserToken } from './source-cycle-firestore.js';
import { resolveTargetProject } from './firebase-target.js';
import { assertLane, decideCheck, decideClaim, decideTransfer, LEASE_COLLECTION, parseLease, type Lease } from '../domain/writer-lease.js';

/** 임대 문서 저장소(REST, 사용자 토큰). 문서 하나 = 레인 하나. 쓰기는 문서 updateTime(또는 «없음») 조건부 — 동시 인수·갱신 충돌은 CAS_CONFLICT 로 끝난다. */
export function writerLeaseStore(options: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; token?: () => Promise<string> } = {}) {
  const env = options.env ?? process.env, fetcher = options.fetcher ?? fetch, token = options.token ?? gcloudUserToken;
  const project = resolveTargetProject(env);
  if (env.NODE_ENV === 'production' && project !== 'freepasserp5') throw new Error('WRITER_LEASE_WRONG_PROJECT');
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${LEASE_COLLECTION}`;
  // 시간 기준은 이 PC 시계가 아니라 Firestore 서버 응답의 Date 헤더(시계 오차로 조기 인수·고착이 생기지 않게). 헤더가 없거나 이상하면 쓰지 않는다(닫힘).
  let serverNowMs: number | null = null;
  const call = async (path: string, method: string, body?: unknown) => {
    const response = await fetcher(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const serverDate = Date.parse(response.headers.get('date') ?? '');
    if (Number.isFinite(serverDate)) serverNowMs = serverDate;
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(response.status === 409 || response.status === 412 ? 'WRITER_LEASE_CAS_CONFLICT' : 'WRITER_LEASE_REQUEST_FAILED');
    return response.json() as Promise<any>;
  };
  const read = async (lane: string): Promise<{ lease: Lease | null; updateTime: string | null }> => {
    const doc = await call('/' + assertLane(lane), 'GET');
    if (!doc) return { lease: null, updateTime: null };
    const lease = parseLease(decodeFields(doc.fields ?? {}));
    if (!lease || lease.lane !== lane) throw new Error('WRITER_LEASE_DOCUMENT_CORRUPT');   // 손상은 «없음»으로 보지 않는다(닫힘)
    return { lease, updateTime: doc.updateTime as string };
  };
  const write = async (next: Lease, updateTime: string | null) => {
    const query = new URLSearchParams(updateTime ? { 'currentDocument.updateTime': updateTime } : { 'currentDocument.exists': 'false' });
    await call('/' + assertLane(next.lane) + '?' + query.toString(), 'PATCH', { fields: encodeFields({ ...next }) });
    const back = await read(next.lane);                                                       // 되읽기
    if (!back.lease || back.lease.holder !== next.holder || back.lease.epoch !== next.epoch || back.lease.expiresAt !== next.expiresAt) throw new Error('WRITER_LEASE_READBACK_FAILED');
    return back.lease;
  };
  const now = (given?: number) => { if (given !== undefined) return given; if (serverNowMs === null) throw new Error('WRITER_LEASE_SERVER_TIME_MISSING'); return serverNowMs; };
  return {
    read,
    /** 회차 시작 확인(+필요하면 갱신). held=true 일 때만 쓰기를 해도 된다. */
    async check(lane: string, me: string, givenNowMs?: number) {
      const { lease, updateTime } = await read(lane);
      const decision = decideCheck(lease, me, now(givenNowMs));
      if (decision.status === 'HELD') return { held: true, status: decision.status, holder: me, epoch: decision.lease.epoch, expiresAt: decision.lease.expiresAt };
      if (decision.status === 'HELD_RENEW') {
        const next = await write(decision.next, updateTime);
        return { held: true, status: decision.status, holder: me, epoch: next.epoch, expiresAt: next.expiresAt };
      }
      if (decision.status === 'NOT_HELD') return { held: false, status: decision.status, holder: decision.holder, expired: decision.expired };
      return { held: false, status: decision.status };
    },
    async claim(lane: string, me: string, ttlMin: number, note?: string, givenNowMs?: number) {
      const { lease, updateTime } = await read(lane);
      const decision = decideClaim(lease, lane, me, ttlMin, now(givenNowMs), note);
      if (decision.status === 'REFUSED') return { done: false, status: decision.status, holder: decision.holder };
      const next = await write(decision.next, updateTime);
      return { done: true, status: decision.status, holder: next.holder, epoch: next.epoch, expiresAt: next.expiresAt };
    },
    async transfer(lane: string, from: string, to: string, expectedEpoch: number, ttlMin: number, note?: string, givenNowMs?: number) {
      const { lease, updateTime } = await read(lane);
      const decision = decideTransfer(lease, from, to, expectedEpoch, ttlMin, now(givenNowMs), note);
      if (decision.status === 'REFUSED') return { done: false, status: decision.status, reason: decision.reason, ...(decision.holder ? { holder: decision.holder } : {}) };
      const next = await write(decision.next, updateTime);
      return { done: true, status: decision.status, holder: next.holder, epoch: next.epoch, expiresAt: next.expiresAt, previousHolder: next.previousHolder };
    },
  };
}
