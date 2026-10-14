/**
 * 원천 엔진 회차 제어를 Firestore 에 둔다(온라인 실행기용 — Actions 러너는 휘발이라 파일 잠금·상태가 회차마다 사라진다).
 * fileCycleControl 과 같은 CycleControl 계약. SOURCE_CYCLE_CONTROL=firestore 일 때만 쓰인다(기본은 파일, B3Q 동작 불변).
 *
 * - 잠금: 문서 하나(임대). 없으면 «없을 때만 생성», 있으면 풀림(RELEASED) 또는 임대 만료일 때만 updateTime 조건부 갱신으로 가져온다.
 *   두 실행기가 동시에 가져가려 하면 한쪽만 성공(409/412)하고 다른 쪽은 회차를 건너뛴다(null). 만료 인계는 takeOverExpired 일 때만.
 * - 해제: 내 토큰일 때만 updateTime 조건부로 RELEASED 표식(삭제하지 않는다).
 * - 상태: 원천별 문서 하나(JSON 문자열 + 검증). 알림: 새 문서 추가(덮어쓰지 않음).
 * 컬렉션 이름은 firestore-layout(FIRESTORE_COLLECTIONS.sourceCycle.control)에서만 온다. 토큰·원문은 남기지 않는다.
 */
import { randomUUID } from 'node:crypto';
import { assertCycleState, emptyCycleState, type CycleControl, type CycleState } from '../ports/source-cycle.js';
import { stableDigest } from '../shared/stable-digest.js';
import { resolveTargetProject } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { decodeFields, encodeFields, gcloudUserToken } from './source-cycle-firestore.js';

/** 전체 회차(약 27분)보다 넉넉히. 만료 전에는 누구도 가져가지 않는다. */
export const CYCLE_LEASE_MS = 60 * 60_000;

type Doc = { name: string; updateTime: string; fields: Record<string, unknown> };

export function firestoreCycleControl(options: {
  env?: NodeJS.ProcessEnv; heartbeat: CycleControl['heartbeat']; takeOverExpired?: boolean;
  fetcher?: typeof fetch; token?: () => Promise<string>; now?: () => number; leaseMs?: number; owner?: string;
}): CycleControl {
  const project = resolveTargetProject(options.env);
  const collection = FIRESTORE_COLLECTIONS.sourceCycle.control;
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${collection}`;
  const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now, lease = options.leaseMs ?? CYCLE_LEASE_MS;
  const owner = (options.owner ?? process.env.GITHUB_RUN_ID ?? 'local').slice(0, 64);
  const id = (kind: 'lock' | 'state', source: string) => `${kind}__${stableDigest(source).slice(0, 40)}`;
  type Result = { status: number; body: any };
  const call = async (path: string, method: string, body?: unknown): Promise<Result> => {
    const response = await fetcher(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${await (options.token ?? gcloudUserToken)()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const fail = (r: Result): never => { throw new Error(`CYCLE_CONTROL_FIRESTORE_${r.status}`); };
  const get = async (docId: string): Promise<Doc | null> => {
    const r = await call(`/${docId}`, 'GET');
    if (r.status === 404) return null;
    return r.status === 200 ? r.body as Doc : fail(r);
  };
  /** 없을 때만 생성. 이미 있으면 false. */
  const create = async (docId: string, fields: Record<string, unknown>) => {
    const r = await call(`?documentId=${encodeURIComponent(docId)}`, 'POST', { fields: encodeFields(fields) });
    if (r.status === 409) return false;
    return r.status === 200 ? true : fail(r);
  };
  /** 읽은 그 버전일 때만 덮어쓴다. 그 사이 바뀌었으면 false. */
  const replaceIf = async (doc: Doc, fields: Record<string, unknown>) => {
    const r = await call(`/${doc.name.split('/').pop()}?currentDocument.updateTime=${encodeURIComponent(doc.updateTime)}`, 'PATCH',
      { fields: encodeFields(fields) });
    if (r.status === 409 || r.status === 412 || r.status === 400 && /precondition/i.test(JSON.stringify(r.body))) return false;
    return r.status === 200 ? true : fail(r);
  };
  const alert = async (source: string, reason: string) => {
    const at = new Date(now()).toISOString();
    await create(`alert__${at.replace(/[^0-9]/g, '')}__${randomUUID()}`, { kind: 'ALERT', source, reason: reason.slice(0, 200), at });
  };
  return {
    async acquire(source) {
      const docId = id('lock', source), token = randomUUID(), at = now();
      const held = { kind: 'LOCK', source, status: 'HELD', token, owner, acquiredAt: new Date(at).toISOString(), expiresAt: new Date(at + lease).toISOString() };
      const current = await get(docId);
      let got: boolean;
      if (!current) got = await create(docId, held);
      else {
        const f = decodeFields(current.fields as never) as Record<string, unknown>;
        const expired = Date.parse(String(f.expiresAt ?? '')) <= at;
        if (f.status === 'RELEASED') got = await replaceIf(current, held);
        else if (expired && options.takeOverExpired) {
          await alert(source, `LEASE_TAKEN_OVER:${String(f.owner ?? 'unknown').slice(0, 64)}`);
          got = await replaceIf(current, held);
        } else {
          if (expired) await alert(source, 'DEAD_LOCK_HELD');
          return null;
        }
      }
      if (!got) return null;
      return async () => {
        const doc = await get(docId);
        const f = doc ? decodeFields(doc.fields as never) as Record<string, unknown> : null;
        if (!doc || f?.token !== token) throw new Error('CYCLE_LOCK_OWNER_CHANGED');
        if (!(await replaceIf(doc, { ...f, status: 'RELEASED', releasedAt: new Date(now()).toISOString() }))) throw new Error('CYCLE_LOCK_OWNER_CHANGED');
      };
    },
    async load(source) {
      const doc = await get(id('state', source));
      if (!doc) return emptyCycleState();
      const f = decodeFields(doc.fields as never) as Record<string, unknown>;
      if (typeof f.state !== 'string') throw new Error('CYCLE_STATE_INVALID');
      return assertCycleState(JSON.parse(f.state) as CycleState);
    },
    async save(source, state) {
      assertCycleState(state);
      const r = await call(`/${id('state', source)}`, 'PATCH', { fields: encodeFields({ kind: 'STATE', source, state: JSON.stringify(state),
        savedAt: new Date(now()).toISOString() }) });
      if (r.status !== 200) fail(r);
    },
    heartbeat: options.heartbeat,
    alert,
  };
}
