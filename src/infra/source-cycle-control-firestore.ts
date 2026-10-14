/**
 * 원천 엔진 회차 제어를 Firestore 에 둔다(온라인 실행기용 — Actions 러너는 휘발이라 파일 잠금·상태가 회차마다 사라진다).
 * fileCycleControl 과 같은 CycleControl 계약. SOURCE_CYCLE_CONTROL=firestore 일 때만 쓰인다(기본은 파일, B3Q 동작 불변).
 *
 * - 쓰기 소유권(Codex P1-①): 원천별 «지금 상품을 쓰는 실행기»(B3Q | ACTIONS)를 문서 하나로 둔다. 없으면 B3Q(현행).
 *   소유권은 넘김 도구(jobs/source-cycle-handover)만 바꾼다 — 이전 실행 완료·상태 이관을 확인한 뒤 updateTime 조건부로.
 *   두 실행기 모두 상품 쓰기 직전마다 소유권을 다시 읽어 «내 것»이 아니면 쓰지 않는다(beforeWrite).
 * - 잠금: 원천별 임대 문서. 없으면 «없을 때만 생성», 풀림(RELEASED)이면 updateTime 조건부 갱신. 만료 잠금 인수는
 *   SOURCE_CYCLE_TAKEOVER=1 을 명시한 실행기만(Codex P1-②, 기본 꺼짐) — 인수해도 아래 fencing 이 옛 실행기의 쓰기를 막는다.
 * - fencing: 잠금마다 증가하는 세대(generation)와 토큰. 상품 쓰기 직전마다 잠금 문서를 다시 읽어 내 토큰·세대·임대 유효가 아니면
 *   LEASE_LOST 로 멈춘다(빼앗긴 옛 실행기가 계속 쓰는 것을 막는다).
 * - 해제: 내 토큰일 때만 RELEASED 표식(삭제하지 않는다). 상태 = 원천별 문서(검증), 알림 = 새 문서 추가.
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
export type CycleWriter = 'B3Q' | 'ACTIONS';
export const CYCLE_WRITERS: readonly CycleWriter[] = ['B3Q', 'ACTIONS'];
/** 소유권 문서가 없을 때의 소유자 = 현행(B3Q 작업 스케줄러). */
export const DEFAULT_CYCLE_WRITER: CycleWriter = 'B3Q';

type Doc = { name: string; updateTime: string; fields: Record<string, unknown> };
export type ControlDocKind = 'lock' | 'state' | 'owner';
export type ControlStoreOptions = { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; token?: () => Promise<string> };

/** 같은 컬렉션의 문서 입출력(삭제 없음). */
export function controlStore(options: ControlStoreOptions) {
  const project = resolveTargetProject(options.env);
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${FIRESTORE_COLLECTIONS.sourceCycle.control}`;
  const fetcher = options.fetcher ?? fetch;
  const call = async (path: string, method: string, body?: unknown) => {
    const response = await fetcher(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${await (options.token ?? gcloudUserToken)()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const fail = (r: { status: number }): never => { throw new Error(`CYCLE_CONTROL_FIRESTORE_${r.status}`); };
  const store = {
    id: (kind: ControlDocKind, source: string) => `${kind}__${stableDigest(source).slice(0, 40)}`,
    fields: (doc: Doc) => decodeFields(doc.fields as never) as Record<string, unknown>,
    async get(docId: string): Promise<Doc | null> {
      const r = await call(`/${docId}`, 'GET');
      if (r.status === 404) return null;
      return r.status === 200 ? r.body as Doc : fail(r);
    },
    /** 없을 때만 생성. 이미 있으면 false. */
    async create(docId: string, fields: Record<string, unknown>) {
      const r = await call(`?documentId=${encodeURIComponent(docId)}`, 'POST', { fields: encodeFields(fields) });
      if (r.status === 409) return false;
      return r.status === 200 ? true : fail(r);
    },
    /** 읽은 그 버전일 때만 덮어쓴다. 그 사이 바뀌었으면 false. */
    async replaceIf(doc: Doc, fields: Record<string, unknown>) {
      const r = await call(`/${doc.name.split('/').pop()}?currentDocument.updateTime=${encodeURIComponent(doc.updateTime)}`, 'PATCH',
        { fields: encodeFields(fields) });
      if (r.status === 409 || r.status === 412 || r.status === 400 && /precondition/i.test(JSON.stringify(r.body))) return false;
      return r.status === 200 ? true : fail(r);
    },
    async put(docId: string, fields: Record<string, unknown>) {
      const r = await call(`/${docId}`, 'PATCH', { fields: encodeFields(fields) });
      if (r.status !== 200) fail(r);
    },
  };
  return store;
}
export type ControlStore = ReturnType<typeof controlStore>;

/** 원천의 현재 쓰기 소유자(문서 없으면 B3Q). 모르는 값은 «아무도 아님»으로 보아 둘 다 쓰지 못하게 한다. */
export async function readCycleWriter(store: ControlStore, source: string): Promise<{ writer: CycleWriter | 'UNKNOWN'; doc: Doc | null }> {
  const doc = await store.get(store.id('owner', source));
  if (!doc) return { writer: DEFAULT_CYCLE_WRITER, doc };
  const writer = store.fields(doc).writer;
  return { writer: CYCLE_WRITERS.includes(writer as CycleWriter) ? writer as CycleWriter : 'UNKNOWN', doc };
}

/** 소유권 넘김(넘김 도구만 부른다): 읽은 버전일 때만 바꾼다. */
export async function setCycleWriter(store: ControlStore, source: string, from: { doc: Doc | null }, to: CycleWriter, evidence: Record<string, unknown>) {
  const fields = { kind: 'OWNER', source, writer: to, changedAt: new Date().toISOString(), ...evidence };
  return from.doc ? store.replaceIf(from.doc, fields) : store.create(store.id('owner', source), fields);
}

/** 상품 쓰기 직전 확인: 이 실행기가 원천의 소유자가 아니면 쓰지 않는다(B3Q·Actions 공용). */
export function writerGuard(store: ControlStore, me: CycleWriter) {
  return async (source: string) => {
    const { writer } = await readCycleWriter(store, source);
    if (writer !== me) throw new Error('WRITER_NOT_OWNER');
  };
}

export function firestoreCycleControl(options: ControlStoreOptions & {
  heartbeat: CycleControl['heartbeat']; takeOverExpired?: boolean; writer?: CycleWriter;
  now?: () => number; leaseMs?: number; owner?: string;
}): CycleControl & { fence(source: string): Promise<void> } {
  const store = controlStore(options);
  const now = options.now ?? Date.now, lease = options.leaseMs ?? CYCLE_LEASE_MS, me = options.writer ?? 'ACTIONS';
  const runner = (options.owner ?? process.env.GITHUB_RUN_ID ?? 'local').slice(0, 64);
  const held = new Map<string, { token: string; generation: number }>();
  const alert = async (source: string, reason: string) => {
    const at = new Date(now()).toISOString();
    await store.create(`alert__${at.replace(/[^0-9]/g, '')}__${randomUUID()}`, { kind: 'ALERT', source, reason: reason.slice(0, 200), at });
  };
  const lockFields = (source: string, token: string, generation: number, at: number) => ({ kind: 'LOCK', source, status: 'HELD', token, generation,
    owner: runner, writer: me, acquiredAt: new Date(at).toISOString(), expiresAt: new Date(at + lease).toISOString() });
  return {
    async acquire(source) {
      // 소유권이 이 실행기가 아니면 회차를 돌리지 않는다(중복 회차 생략과 같은 취급, 실패로 세지 않음).
      if ((await readCycleWriter(store, source)).writer !== me) { await alert(source, 'WRITER_NOT_OWNER'); return null; }
      const docId = store.id('lock', source), token = randomUUID(), at = now();
      const current = await store.get(docId);
      let generation = 1, got: boolean;
      if (!current) got = await store.create(docId, lockFields(source, token, generation, at));
      else {
        const f = store.fields(current);
        generation = (Number.isSafeInteger(f.generation) ? f.generation as number : 0) + 1;
        const expired = Date.parse(String(f.expiresAt ?? '')) <= at;
        if (f.status === 'RELEASED') got = await store.replaceIf(current, lockFields(source, token, generation, at));
        else if (expired && options.takeOverExpired === true) {
          await alert(source, `LEASE_TAKEN_OVER:${String(f.owner ?? 'unknown').slice(0, 64)}`);
          got = await store.replaceIf(current, lockFields(source, token, generation, at));
        } else {
          if (expired) await alert(source, 'DEAD_LOCK_HELD');
          return null;
        }
      }
      if (!got) return null;
      held.set(source, { token, generation });
      return async () => {
        held.delete(source);
        const doc = await store.get(docId);
        const f = doc ? store.fields(doc) : null;
        if (!doc || f?.token !== token) throw new Error('CYCLE_LOCK_OWNER_CHANGED');
        if (!(await store.replaceIf(doc, { ...f, status: 'RELEASED', releasedAt: new Date(now()).toISOString() }))) throw new Error('CYCLE_LOCK_OWNER_CHANGED');
      };
    },
    /** fencing: 상품 쓰기 직전마다 부른다. 내가 잡은 잠금(토큰·세대)이 아직 유효하고 소유권이 내 것일 때만 통과. */
    async fence(source) {
      const mine = held.get(source);
      if (!mine) throw new Error('LEASE_LOST');
      const doc = await store.get(store.id('lock', source));
      const f = doc ? store.fields(doc) : null;
      if (!f || f.status !== 'HELD' || f.token !== mine.token || f.generation !== mine.generation ||
          !(Date.parse(String(f.expiresAt ?? '')) > now())) throw new Error('LEASE_LOST');
      if ((await readCycleWriter(store, source)).writer !== me) throw new Error('WRITER_NOT_OWNER');
    },
    async load(source) {
      const doc = await store.get(store.id('state', source));
      if (!doc) return emptyCycleState();
      const f = store.fields(doc);
      if (typeof f.state !== 'string') throw new Error('CYCLE_STATE_INVALID');
      return assertCycleState(JSON.parse(f.state) as CycleState);
    },
    async save(source, state) {
      assertCycleState(state);
      await store.put(store.id('state', source), { kind: 'STATE', source, state: JSON.stringify(state), savedAt: new Date(now()).toISOString() });
    },
    heartbeat: options.heartbeat,
    alert,
  };
}
