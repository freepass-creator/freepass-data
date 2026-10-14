import supplierSpec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveTargetProject } from './firebase-target.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { CycleCommands, CycleProduct, SupplierFields } from '../ports/source-cycle.js';
import { salePriceMap, compactRecord, type SourceAmount, type SourceProductRecord } from '../domain/source-engine.js';
import { resolveErp5InventoryStatus, PROVIDER_AVAILABLE_STATUS_LABELS } from '../domain/erp5-inventory-status.js';

type Fields = Record<string, unknown>;
type Doc = { name: string; updateTime: string; fields: Fields };
type Backup = { project: string; key: string; before: CycleProduct | null; document: Doc | null };
export const cycleAmount = (v: unknown): SourceAmount => v === 0 ? { state: 'ZERO', value: 0 } :
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? { state: 'KNOWN', value: v } : { state: 'UNKNOWN', value: null };
export function decodeValue(v: any): any {
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('integerValue' in v || 'doubleValue' in v) return Number(v.integerValue ?? v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  throw new Error('FIRESTORE_VALUE_UNSUPPORTED');
}
export const decodeFields = (fields: Fields): Fields => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]));
export function encodeValue(v: any): any {
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number' && Number.isFinite(v)) return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  throw new Error('FIRESTORE_VALUE_INVALID');
}
export const encodeFields = (fields: Fields): Fields => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encodeValue(v)]));
export async function gcloudUserToken(): Promise<string> {
  const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'powershell.exe' : 'gcloud',
    process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', '& gcloud.cmd auth print-access-token; exit $LASTEXITCODE']
      : ['auth', 'print-access-token'], { windowsHide: true, timeout: 30_000 });
  const token = stdout.trim();
  if (!token || /\s/.test(token)) throw new Error('GCLOUD_TOKEN_REQUIRED');
  return token;
}
/** 가격 맵 정규화: null·undefined·키 누락을 같게 보고(해당 키 제거) 키를 정렬한다. digest 계산·비교·되읽기 대조 공통 기준. */
export function normalizePrice(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePrice);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, 'en-US')).map(([k, v]) => [k, normalizePrice(v)]));
  }
  return value;
}
export const priceDigest = (price: unknown) => stableDigest(normalizePrice(price ?? {}));
const fieldDigest = (key: string, value: unknown) => key === 'price' ? priceDigest(value) : stableDigest(value);
export function productRecord(uid: string, f: Fields, observedAt: string): SourceProductRecord {
  return { sourceId: String(f.provider_company_code ?? ''), uid, plate: typeof f.car_number === 'string' ? f.car_number : null,
    vehicleText: String(f.car_name ?? (f.원문 as Fields | undefined)?.차명 ?? f.model ?? ''),
    status: { raw: String(f.status ?? ''), saleAvailable: f.listable === true && f.status !== '출고불가' && f.status !== '계약중' && f.status_kind !== '불가' },
    terms: Object.entries((f.price ?? {}) as Record<string, any>).filter(([months]) => /^\d+$/.test(months)).map(([months, p]) => ({ months: Number(months),
      monthlyRent: cycleAmount(p.rent), deposit: cycleAmount(p.deposit), mileage: typeof p.mileage === 'string' ? p.mileage : null, raw: p })),
    observedAt, raw: { source: f.source ?? null,
      ...(f.source_tab !== undefined ? { source_tab: f.source_tab } : {}),
      ...(f.product_group !== undefined ? { product_group: f.product_group } : {}) }, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] };
}
/** 저장 digest 와 현재 price 대조. 정규화(null=누락) 일치, 또는 다른 쓰기 주체가 표시용 mileage 만 지운 경우(저장 digest 는 기록의 terms 와 일치하고 현재 price 는 mileage 를 뺀 terms 와 같음)를 허용한다. rent·deposit 변경은 여전히 DRIFT. */
export function priceMatchesRecord(price: unknown, storedDigest: unknown, record: SourceProductRecord): boolean {
  if (priceDigest(price) === storedDigest || stableDigest(price ?? {}) === storedDigest) return true;
  const derived = salePriceMap(record.terms);
  if (stableDigest(derived) !== storedDigest && priceDigest(derived) !== storedDigest) return false;
  return priceDigest(price) === priceDigest(salePriceMap(record.terms, false));
}
function envelope(d: Doc, acceptDrift: ReadonlySet<string> = new Set(), drifted?: string[], heldDrift?: string[], writeMonthlyProductType = false): CycleProduct {
  const f = decodeFields(d.fields), uid = decodeURIComponent(d.name.split('/').at(-1)!);
  const record = (f.source_cycle_record ?? productRecord(uid, f, String(f.source_observed_at ?? d.updateTime))) as SourceProductRecord;
  if (record.uid !== uid || record.sourceId !== f.provider_company_code) throw new Error('CATALOG_IDENTITY_INVALID');
  if (f.source_cycle_record) {
    if (!priceMatchesRecord(f.price, f.source_cycle_price_digest, record) || f.car_number !== record.plate) {
      const plateSame = f.car_number === record.plate;
      if (acceptDrift.has(String(f.provider_company_code)) && plateSame) {
        // 승인된 외부 보정(예: 정책 보증금)을 코드별 명시 옵션으로만 받아들인다.
        const current = productRecord(uid, f, record.observedAt);
        record.terms = current.terms; drifted?.push(uid);
      } else if (heldDrift && plateSame) {
        // 가격만 다른 문서는 목록 조립 단계에서 전체를 막지 않고 UID 만 표시한다. 계획이 그 문서를 실제로 쓰게 될 때만 막는다.
        heldDrift.push(uid);
      } else throw new Error('CATALOG_SOURCE_RECORD_DRIFT');   // 번호판 불일치와 쓰기 단계(read·backup)는 항상 DRIFT
    }
  }
  // 판매 가격 칸에 소비처가 읽는 옵션 키(개월_연·월N km)가 빠진 노출 문서: 값은 같아도 한 번 다시 써서 키를 채운다(되풀이되지 않음).
  const expectedOptionKeys = Object.keys(salePriceMap(record.terms)).filter(k => k.includes('_'));
  const engineOwned = f.listable === true && f.source_cycle_record !== undefined;
  const rewriteReasons: NonNullable<CycleProduct['rewriteReasons']> = [];
  if (engineOwned && expectedOptionKeys.some(k => !(f.price && typeof f.price === 'object' && k in (f.price as Record<string, unknown>)))) rewriteReasons.push('PRICE_LAYOUT');
  // 저장된 status_kind 가 저장된 vehicle_status 의 계약 값과 다른 노출 문서(검토된 상태만): 쓰면 표시 상태·status_kind 가 함께 맞춰져 되풀이되지 않는다.
  const storedKind = resolveErp5InventoryStatus(f.vehicle_status);
  if (engineOwned && storedKind.known && f.status_kind !== storedKind.statusKind) rewriteReasons.push('STATUS_KIND');
  // 월렌트 모델 문서의 상품 구분(product_type «월렌트»): 중앙 어휘 확장이 합쳐진 뒤 SOURCE_CYCLE_WRITE_MONTHLY_PRODUCT_TYPE=1 일 때만 켠다.
  if (engineOwned && writeMonthlyProductType && f.product_group === 'MONTHLY_RENT' && f.product_type !== MONTHLY_PRODUCT_TYPE) rewriteReasons.push('PRODUCT_TYPE');
  return { record, ...(rewriteReasons.length ? { rewriteReasons } : {}),
    ...(typeof f.provider_name === 'string' && f.provider_name.trim() ? { supplierFields: {
    provider_name: f.provider_name, policy_code: typeof f.policy_code === 'string' ? f.policy_code : null } } : {}), listable: f.listable === true,
    locked_by_contract: f.locked_by_contract === true || f.status === '계약중' || f.status_kind === '계약중',
    publication_withdrawal: (f.publication_withdrawal ?? null) as CycleProduct['publication_withdrawal'],
    publication_withdrawal_prior: (f.publication_withdrawal_prior ?? null) as CycleProduct['publication_withdrawal_prior'] };
}
/** 표시 상태가 정하는 status_kind (ERP5 재고 계약표). 예전에는 노출이면 무조건 «가용» 이어서 계약중·상품화중 문서가 계약 검사의
 * status_kind 드리프트로 잡혔다(2026-10-13 발행 단계 33건). 검토되지 않은 상태는 «불가»(fail-closed, 독립 검토 2026-10-14): 가용으로 추정해 노출하지 않는다. */
export const MONTHLY_PRODUCT_TYPE = '월렌트';
export const statusKindOf = (display: string, listable: boolean) =>
  !listable ? '불가' : (() => { const r = resolveErp5InventoryStatus(display); return r.known ? r.statusKind : PROVIDER_AVAILABLE_STATUS_LABELS.has(display) ? '가용' : '불가'; })();
export function nativeCycleFields(p: CycleProduct, original: Fields = {}, opts: { writeMonthlyProductType?: boolean } = {}): Fields {
  const r = p.record;
  const rawDisplay = String(r.raw.sourceCycleDisplayStatus ?? ({ AVAILABLE: '출고가능', PREPARING: '상품화중', 게시: '출고가능' } as Record<string, string>)[r.status.raw] ?? r.status.raw);
  const display = ({ 배차문의: '출고협의', 수리중: '상품화중' } as Record<string, string>)[rawDisplay] ?? rawDisplay;
  // fail-closed(독립 검토 BLOCK): 검토된 어휘에 없는 상태는 «가용» 으로 추정해 노출하지 않는다. 플러그인이 먼저 보류하므로 여기 오는 일은 드물다.
  const listable = p.listable && (resolveErp5InventoryStatus(display).known || PROVIDER_AVAILABLE_STATUS_LABELS.has(display));
  const price = !p.listable && original.price ? original.price :
    salePriceMap(r.terms);
  return { car_number: r.plate, provider_company_code: r.sourceId, car_name: r.vehicleText,
    ...(!Object.keys(original).length ? { ...p.supplierFields, maker: '', model: '', sub_model: r.vehicleText, trim_name: '', vehicle_review_required: true, vehicle_title_source: 'RAW_VEHICLE_TEXT',
      원문: { 차명: r.vehicleText, source: r.raw } } : {}),
    price, source_cycle_price_digest: priceDigest(price),
    listable, status: listable ? display : '출고불가', status_kind: statusKindOf(display, listable),
    vehicle_status: listable ? display : '출고불가', source: original.source ?? r.raw.source ?? 'source-cycle',
    source_tab: r.raw.source_tab ?? null, source_row: r.raw.source_row ?? null,
    ...(r.raw.product_group ? { product_group: r.raw.product_group } : {}),
    ...(opts.writeMonthlyProductType === true && r.raw.product_group === 'MONTHLY_RENT' ? { product_type: MONTHLY_PRODUCT_TYPE } : {}),
    source_observed_at: r.observedAt, source_cycle_record: compactRecord(r),
    publication_withdrawal: p.publication_withdrawal, publication_withdrawal_prior: p.publication_withdrawal_prior };
}
/** ERP5 제목은 maker·(sub_model||model)·trim_name 만 읽는다(차량 정보 확인 필요 방지). 마스터로 특정되기 전 신규 편입은 maker·model 을 비워 두고 원문 차명을 sub_model 에 임시로 둔다(vehicle_review_required 가 true 인 동안만; 마스터 정리 때 덮어쓴다). */
export const rawTitleBackfillFields = (f: Fields): Fields | null =>
  f.vehicle_review_required === true && ['maker', 'model', 'sub_model', 'trim_name'].every(k => !String(f[k] ?? '').trim()) &&
  String((f.원문 as Fields | undefined)?.차명 ?? f.car_name ?? '').trim()
    ? { sub_model: String((f.원문 as Fields | undefined)?.차명 ?? f.car_name).trim(), vehicle_title_source: 'RAW_VEHICLE_TEXT' } : null;
/** Firestore field paths with non-ASCII or special characters must be backtick-quoted. */
const fieldPath = (name: string): string => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '`' + name.replace(/`/g, '\`') + '`';
/** Legacy products compatibility command port required by SPEC3. No SDK app, deletes or blind retries. */
export function firestoreCycleCommands(options: { env?: NodeJS.ProcessEnv; directory: string; fetcher?: typeof fetch;
  token?: () => Promise<string>; observationSources?: string[]; acceptDrift?: string[]; supplierDefaults?: Record<string, SupplierFields>; writeMonthlyProductType?: boolean }) {
  const project = resolveTargetProject(options.env), base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  const fetcher = options.fetcher ?? fetch, cache = new Map<string, Doc>(), accept = new Set(options.acceptDrift ?? []);
  const monthly = options.writeMonthlyProductType === true;
  const docPath = (uid: string) => {
    if (!uid || uid.includes('/') || uid === '.' || uid === '..') throw new Error('UID_INVALID');
    return `/products/${encodeURIComponent(uid)}`;
  };
  const request = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
    const response = await fetcher(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${await (options.token ?? gcloudUserToken)()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(response.status === 409 || response.status === 412 ? 'CAS_CONFLICT' : 'FIRESTORE_REQUEST_FAILED');
    return response.json();
  };
  const getDoc = async (uid: string): Promise<Doc | null> => request(docPath(uid));
  const path = (key: string) => join(options.directory, `${stableDigest(key)}.backup.json`);
  const load = async (key: string): Promise<Backup> => {
    const b = JSON.parse(await readFile(path(key), 'utf8')) as Backup;
    if (b.key !== key || b.project !== project) throw new Error('BACKUP_TARGET_MISMATCH');
    return b;
  };
  const immutable = async (file: string, value: unknown) => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    try { await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' ||
      stableDigest(JSON.parse(await readFile(file, 'utf8'))) !== stableDigest(value)) throw new Error('BACKUP_IMMUTABLE'); }
  };
  const supplierFields = (source: string): SupplierFields | null => {
    const fields = [...cache.values()].map(d => decodeFields(d.fields)).filter(f => f.provider_company_code === source);
    const mode = (key: string): string | null => {
      const counts = new Map<string, number>();
      for (const f of fields) if (typeof f[key] === 'string' && (f[key] as string).trim()) {
        const value = (f[key] as string).trim(); counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      // Ties are deterministic and independent of Firestore page/order.
      return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ?? null;
    };
    const configured = options.supplierDefaults?.[source];
    const name = mode('provider_name') ?? configured?.provider_name ??
      supplierSpec.supplierChannels.sharedInputSheet.find(s => s.code === source)?.companyName ??
      supplierSpec.supplierChannels.notInSharedSheet.find(s => s.code === source)?.name;
    return name?.trim() ? { provider_name: name, policy_code: mode('policy_code') ?? configured?.policy_code ?? null } : null;
  };
  const commands: CycleCommands = {
    async list(source) {
      for (const key of cache.keys()) if (key.startsWith(`${source}:`)) cache.delete(key);
      const products: CycleProduct[] = [], drifted: string[] = [], heldDrift: string[] = []; let page = ''; const pages = new Set<string>();
      do {
        const query = new URLSearchParams({ pageSize: '300' });
        if (page) query.set('pageToken', page);
        for (const field of ['provider_company_code', 'provider_name', 'policy_code', 'car_number', 'car_name', '원문', 'model', 'price', 'listable', 'status', 'status_kind',
          'source', 'source_tab', 'product_group', 'source_observed_at', 'source_cycle_record', 'source_cycle_price_digest', 'locked_by_contract',
          'publication_withdrawal', 'publication_withdrawal_prior', 'vehicle_status', 'product_type']) query.append('mask.fieldPaths', fieldPath(field));
        const result = await request('/products?' + query);
        if (!result || (!Array.isArray(result.documents) && result.documents !== undefined)) throw new Error('CATALOG_INCOMPLETE');
        for (const d of (result.documents ?? []) as Doc[]) {
          const f = decodeFields(d.fields);
          if (f.provider_company_code !== source) continue;
          if (!d.updateTime) throw new Error('CATALOG_VERSION_REQUIRED');
          const p = envelope(d, accept, drifted, heldDrift, monthly); products.push(p); cache.set(`${source}:${p.record.uid}`, d);
        }
        page = result.nextPageToken ?? '';
        if (page && pages.has(page)) throw new Error('CATALOG_PAGINATION_LOOP');
        pages.add(page);
      } while (page);
      return { products, complete: true, enrollmentSupplier: supplierFields(source), ...(drifted.length ? { acceptedDrift: drifted.sort() } : {}),
        ...(heldDrift.length ? { driftHeld: heldDrift.sort() } : {}) };
    },
    async read(source, uid) {
      const d = await getDoc(uid);
      if (!d) return null;
      const p = envelope(d, accept, undefined, undefined, monthly);
      if (p.record.sourceId !== source) throw new Error('UID_OTHER_SUPPLIER');
      cache.set(`${source}:${uid}`, d); return p;
    },
    async backup(key, before) {
      const cached = before ? cache.get(`${before.record.sourceId}:${before.record.uid}`) : null;
      const document = before ? await getDoc(before.record.uid) : null;
      if (before && (!document || !cached || cached.updateTime !== document.updateTime ||
        stableDigest(envelope(document, accept, undefined, undefined, monthly)) !== stableDigest(before))) throw new Error('BACKUP_SNAPSHOT_MISSING');
      await immutable(path(key), { project, key, before, document: document ?? null });
    },
    async readBackup(key) {
      const b = await load(key);
      if (stableDigest(b.document ? envelope(b.document, accept, undefined, undefined, monthly) : null) !== stableDigest(b.before)) throw new Error('BACKUP_MISMATCH');
      return b.before;
    },
    async precheck(afters) {
      // Firestore 문서 한도 1MiB. 쓰기 뒤 문서 크기 = 기존 문서에서 덮일 필드를 뺀 나머지 + 새 필드. 900,000B 를 넘는 쓰기가 하나라도 있으면
      // 어떤 백업·쓰기도 시작하기 전에 계획 전체를 막는다(일부만 적용되고 멈추는 상태 방지).
      const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
      for (const after of afters) {
        const current = await getDoc(after.record.uid);   // 목록은 필드 마스크라 전체 문서가 아니다 — 크기는 전체 문서로 잰다
        const incoming = encodeFields(nativeCycleFields(after, current ? decodeFields(current.fields) : {}, { writeMonthlyProductType: monthly }));
        const kept = Object.entries(current?.fields ?? {}).filter(([k]) => !(k in incoming));
        if (size(Object.fromEntries(kept)) + size(incoming) > 900_000) throw new Error('DOC_TOO_LARGE');
      }
    },
    async compareAndApply(beforeDigest, after, key) {
      if (options.observationSources?.includes(after.record.sourceId)) throw new Error('OBSERVATION_ONLY');
      const b = await load(key), current = await getDoc(after.record.uid);
      if (stableDigest(b.before) !== beforeDigest || stableDigest(current) !== stableDigest(b.document) ||
        (current && envelope(current, accept, undefined, undefined, monthly).locked_by_contract) || after.locked_by_contract) throw new Error('CAS_CONFLICT');
      if (current && envelope(current, accept, undefined, undefined, monthly).record.sourceId !== after.record.sourceId) throw new Error('UID_OTHER_SUPPLIER');
      if (!current && (!after.supplierFields?.provider_name.trim() ||
        stableDigest(after.supplierFields) !== stableDigest(supplierFields(after.record.sourceId))))
        throw new Error('SUPPLIER_NAME_REQUIRED');
      const fields = nativeCycleFields(after, current ? decodeFields(current.fields) : {}, { writeMonthlyProductType: monthly });
      const query = new URLSearchParams(current ? { 'currentDocument.updateTime': current.updateTime } : { 'currentDocument.exists': 'false' });
      for (const field of Object.keys(fields)) query.append('updateMask.fieldPaths', fieldPath(field));
      const result = await request(docPath(after.record.uid) + '?' + query, 'PATCH', { fields: encodeFields(fields) });
      const reread = await getDoc(after.record.uid);
      if (!reread || reread.updateTime !== result.updateTime || Object.entries(fields).some(([k, v]) =>
        fieldDigest(k, decodeFields(reread.fields)[k]) !== fieldDigest(k, v))) throw new Error('READBACK_UNCERTAIN');
      await immutable(join(options.directory, `${stableDigest(key)}.receipt.json`), { project, key, after: reread });
    },
  };
  return { ...commands,
    async documents(source: string) { await commands.list(source); return [...cache.values()].filter(d => decodeFields(d.fields).provider_company_code === source); },
    async rollback(key: string, approval: string) {
      const b = await load(key), receipt = JSON.parse(await readFile(join(options.directory, `${stableDigest(key)}.receipt.json`), 'utf8'));
      if (receipt.project !== project || receipt.key !== key || approval !== stableDigest({ backup: b, receipt })) throw new Error('ROLLBACK_APPROVAL_REQUIRED');
      const uid = decodeURIComponent(receipt.after.name.split('/').at(-1));
      const current = await getDoc(uid);
      if (!current || stableDigest(current) !== stableDigest(receipt.after) || envelope(current, accept, undefined, undefined, monthly).locked_by_contract) throw new Error('CAS_CONFLICT');
      if (options.observationSources?.includes(envelope(current, accept, undefined, undefined, monthly).record.sourceId)) throw new Error('OBSERVATION_ONLY');
      // Newly enrolled documents are withdrawn, never deleted.
      const fields = b.document?.fields ?? { ...current.fields, ...encodeFields({ listable: false, status: '출고불가', status_kind: '불가',
        vehicle_status: '출고불가', publication_withdrawal: { reason: 'ROLLBACK_ENROLL', deleteAuthorized: false } }) };
      await immutable(join(options.directory, `${stableDigest(key)}.rollback-before.json`), current);
      const result = await request(docPath(uid) + '?currentDocument.updateTime=' + encodeURIComponent(current.updateTime), 'PATCH', { fields });
      const reread = await getDoc(uid);
      if (!reread || result.updateTime !== reread.updateTime || stableDigest(reread.fields) !== stableDigest(fields)) throw new Error('ROLLBACK_READBACK_UNCERTAIN');
      return { status: 'ROLLED_BACK' };
    },
    async rollbackDigest(key: string) { const backup = await load(key);
      const receipt = JSON.parse(await readFile(join(options.directory, `${stableDigest(key)}.receipt.json`), 'utf8'));
      return stableDigest({ backup, receipt }); },
  };
}
