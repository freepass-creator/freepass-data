import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildProductRevision, productRevisionModeOf, PRODUCT_REVISIONS_COLLECTION,
  type ProductRevision, type ProductRevisionInput, type ProductRevisionMode,
} from '../domain/product-revision.js';

/**
 * 상품 변경 이력 기록기 — 모든 products writer 가 같은 함수(recordProductRevision)로 남긴다.
 * 저장소(sink) 셋: REST(엔진: gcloud 사용자 토큰) · Admin SDK(정정 도구) · 로컬 파일(shadow 대사용, 운영 DB 쓰기 0).
 * 지금은 off·shadow 만 연다: shadow 는 기존 상품 쓰기가 끝난 뒤 «비공식(official=false)» 리비전을 따로 남기고, 실패해도 상품 쓰기를 막지 않는다.
 */
export type ProductRevisionSinkResult = 'CREATED' | 'ALREADY_RECORDED';
export type ProductRevisionSink = { kind: 'rest' | 'admin' | 'local'; create(revision: ProductRevision): Promise<ProductRevisionSinkResult> };

const sameRecord = (existing: { inputDigest?: unknown } | null | undefined, revision: ProductRevision) => existing?.inputDigest === revision.inputDigest;

/** 엔진 REST 경로: product_revisions/{revId} 를 exists=false 조건으로 만든다. 이미 있으면 같은 입력일 때만 «이미 기록»(멱등), 다르면 충돌. */
export function restProductRevisionSink(port: {
  request: (path: string, method?: string, body?: unknown) => Promise<any>;
  encodeFields: (value: Record<string, unknown>) => unknown;
  decodeFields: (fields: unknown) => Record<string, unknown>;
}): ProductRevisionSink {
  return { kind: 'rest', async create(revision) {
    const path = `/${PRODUCT_REVISIONS_COLLECTION}/${encodeURIComponent(revision.revId)}`;
    try {
      await port.request(`${path}?currentDocument.exists=false`, 'PATCH', { fields: port.encodeFields(revision as unknown as Record<string, unknown>) });
      return 'CREATED';
    } catch (e) {
      if ((e as Error).message !== 'CAS_CONFLICT') throw e;
      const existing = await port.request(path);
      if (existing && sameRecord(port.decodeFields(existing.fields), revision)) return 'ALREADY_RECORDED';
      throw new Error('REVISION_CONFLICT');
    }
  } };
}

type AdminDocRef = { create(data: unknown): Promise<unknown>; get(): Promise<{ exists: boolean; data(): unknown }> };
/** 정정 도구 Admin SDK 경로: create(이미 있으면 ALREADY_EXISTS) 후 같은 입력인지 대조. */
export function adminProductRevisionSink(db: { collection(name: string): { doc(id: string): AdminDocRef } }): ProductRevisionSink {
  return { kind: 'admin', async create(revision) {
    const ref = db.collection(PRODUCT_REVISIONS_COLLECTION).doc(revision.revId);
    try { await ref.create(revision); return 'CREATED'; }
    catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code !== 6 && code !== 'already-exists' && code !== 'ALREADY_EXISTS') throw e;
      const snap = await ref.get();
      if (snap.exists && sameRecord(snap.data() as { inputDigest?: unknown }, revision)) return 'ALREADY_RECORDED';
      throw new Error('REVISION_CONFLICT');
    }
  } };
}

/** 로컬 파일 경로(shadow 대사): {dir}/{revId}.json 을 한 번만 만든다(wx). 운영 Firestore 에는 쓰지 않는다. */
export function localProductRevisionSink(directory: string): ProductRevisionSink {
  return { kind: 'local', async create(revision) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${revision.revId}.json`);
    try { await writeFile(file, JSON.stringify(revision), { flag: 'wx', mode: 0o600 }); return 'CREATED'; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (sameRecord(JSON.parse(await readFile(file, 'utf8')), revision)) return 'ALREADY_RECORDED';
      throw new Error('REVISION_CONFLICT');
    }
  } };
}

/** shadow 기록소 선택: PRODUCT_REVISIONS_SINK=local(기본)|firestore. 기본은 로컬 — shadow 를 켜도 운영 DB 쓰기가 생기지 않는다. */
export function productRevisionSinkOf(env: Record<string, string | undefined> | undefined, sinks: { local: () => ProductRevisionSink; firestore?: () => ProductRevisionSink }): ProductRevisionSink {
  const value = (env?.PRODUCT_REVISIONS_SINK ?? 'local').trim() || 'local';
  if (value === 'local') return sinks.local();
  if (value === 'firestore' && sinks.firestore) return sinks.firestore();
  throw new Error('PRODUCT_REVISIONS_SINK_INVALID');
}

export type ProductRevisionRecordResult =
  | { status: 'OFF' }
  | { status: ProductRevisionSinkResult; revId: string; sink: ProductRevisionSink['kind'] }
  | { status: 'SHADOW_FAILED'; error: string };

/**
 * 모든 writer 가 상품 쓰기(성공·되읽기 확인) 직후 부르는 공용 함수. off 면 아무것도 하지 않는다.
 * shadow 는 어떤 오류도 던지지 않는다(상품 쓰기 결과를 바꾸지 않는다) — 결과 상태로만 알린다.
 */
export async function recordProductRevision(mode: ProductRevisionMode, sink: (() => ProductRevisionSink) | ProductRevisionSink,
  input: (() => Omit<ProductRevisionInput, 'mode'>) | Omit<ProductRevisionInput, 'mode'>): Promise<ProductRevisionRecordResult> {
  // off 는 입력(작성자·호스트·전후 값)을 만들기도 전에 끝낸다 — 기본 경로에서 이력 코드가 어떤 예외도 낼 수 없게.
  if (mode === 'off') return { status: 'OFF' };
  try {
    const target = typeof sink === 'function' ? sink() : sink;
    const revision = buildProductRevision({ ...(typeof input === 'function' ? input() : input), mode });
    const status = await target.create(revision);
    return { status, revId: revision.revId, sink: target.kind };
  } catch (e) {
    return { status: 'SHADOW_FAILED', error: e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'REVISION_WRITE_FAILED' };
  }
}

export { productRevisionModeOf };
