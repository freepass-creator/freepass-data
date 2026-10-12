import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveTargetProject } from './firebase-target.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { CycleCommands, CycleProduct } from '../ports/source-cycle.js';
import type { SourceAmount, SourceProductRecord } from '../domain/source-engine.js';

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
function envelope(d: Doc): CycleProduct {
  const f = decodeFields(d.fields), uid = decodeURIComponent(d.name.split('/').at(-1)!);
  const record = (f.source_cycle_record ?? productRecord(uid, f, String(f.source_observed_at ?? d.updateTime))) as SourceProductRecord;
  if (record.uid !== uid || record.sourceId !== f.provider_company_code) throw new Error('CATALOG_IDENTITY_INVALID');
  if (f.source_cycle_record) {
    if (stableDigest(f.price ?? {}) !== f.source_cycle_price_digest || f.car_number !== record.plate)
      throw new Error('CATALOG_SOURCE_RECORD_DRIFT');
  }
  return { record, listable: f.listable === true,
    locked_by_contract: f.locked_by_contract === true || f.status === '계약중' || f.status_kind === '계약중',
    publication_withdrawal: (f.publication_withdrawal ?? null) as CycleProduct['publication_withdrawal'],
    publication_withdrawal_prior: (f.publication_withdrawal_prior ?? null) as CycleProduct['publication_withdrawal_prior'] };
}
export function nativeCycleFields(p: CycleProduct, original: Fields = {}): Fields {
  const r = p.record;
  const display = String(r.raw.sourceCycleDisplayStatus ?? ({ AVAILABLE: '출고가능', PREPARING: '상품화중', 게시: '출고가능' } as Record<string, string>)[r.status.raw] ?? r.status.raw);
  const price = !p.listable && original.price ? original.price :
    Object.fromEntries(r.terms.map(t => [String(t.months), { rent: t.monthlyRent.value, deposit: t.deposit.value, mileage: t.mileage }]));
  return { car_number: r.plate, provider_company_code: r.sourceId, car_name: r.vehicleText,
    ...(!Object.keys(original).length ? { maker: '', model: '', sub_model: '', trim_name: '', vehicle_review_required: true,
      원문: { 차명: r.vehicleText, source: r.raw } } : {}),
    price, source_cycle_price_digest: stableDigest(price),
    listable: p.listable, status: p.listable ? display : '출고불가', status_kind: p.listable ? '가용' : '불가',
    vehicle_status: p.listable ? display : '출고불가', source: original.source ?? r.raw.source ?? 'source-cycle',
    source_tab: r.raw.source_tab ?? null, source_row: r.raw.source_row ?? null,
    ...(r.raw.product_group ? { product_group: r.raw.product_group } : {}),
    source_observed_at: r.observedAt, source_cycle_record: r, source_cycle_raw: r.raw,
    publication_withdrawal: p.publication_withdrawal, publication_withdrawal_prior: p.publication_withdrawal_prior };
}
/** Firestore field paths with non-ASCII or special characters must be backtick-quoted. */
const fieldPath = (name: string): string => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '`' + name.replace(/`/g, '\`') + '`';
/** Legacy products compatibility command port required by SPEC3. No SDK app, deletes or blind retries. */
export function firestoreCycleCommands(options: { env?: NodeJS.ProcessEnv; directory: string; fetcher?: typeof fetch;
  token?: () => Promise<string>; observationSources?: string[] }) {
  const project = resolveTargetProject(options.env), base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  const fetcher = options.fetcher ?? fetch, cache = new Map<string, Doc>();
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
  const commands: CycleCommands = {
    async list(source) {
      for (const key of cache.keys()) if (key.startsWith(`${source}:`)) cache.delete(key);
      const products: CycleProduct[] = []; let page = ''; const pages = new Set<string>();
      do {
        const query = new URLSearchParams({ pageSize: '300' });
        if (page) query.set('pageToken', page);
        for (const field of ['provider_company_code', 'car_number', 'car_name', '원문', 'model', 'price', 'listable', 'status', 'status_kind',
          'source', 'source_tab', 'product_group', 'source_observed_at', 'source_cycle_record', 'source_cycle_price_digest', 'locked_by_contract',
          'publication_withdrawal', 'publication_withdrawal_prior']) query.append('mask.fieldPaths', fieldPath(field));
        const result = await request('/products?' + query);
        if (!result || (!Array.isArray(result.documents) && result.documents !== undefined)) throw new Error('CATALOG_INCOMPLETE');
        for (const d of (result.documents ?? []) as Doc[]) {
          const f = decodeFields(d.fields);
          if (f.provider_company_code !== source) continue;
          if (!d.updateTime) throw new Error('CATALOG_VERSION_REQUIRED');
          const p = envelope(d); products.push(p); cache.set(`${source}:${p.record.uid}`, d);
        }
        page = result.nextPageToken ?? '';
        if (page && pages.has(page)) throw new Error('CATALOG_PAGINATION_LOOP');
        pages.add(page);
      } while (page);
      return { products, complete: true };
    },
    async read(source, uid) {
      const d = await getDoc(uid);
      if (!d) return null;
      const p = envelope(d);
      if (p.record.sourceId !== source) throw new Error('UID_OTHER_SUPPLIER');
      cache.set(`${source}:${uid}`, d); return p;
    },
    async backup(key, before) {
      const cached = before ? cache.get(`${before.record.sourceId}:${before.record.uid}`) : null;
      const document = before ? await getDoc(before.record.uid) : null;
      if (before && (!document || !cached || cached.updateTime !== document.updateTime ||
        stableDigest(envelope(document)) !== stableDigest(before))) throw new Error('BACKUP_SNAPSHOT_MISSING');
      await immutable(path(key), { project, key, before, document: document ?? null });
    },
    async readBackup(key) {
      const b = await load(key);
      if (stableDigest(b.document ? envelope(b.document) : null) !== stableDigest(b.before)) throw new Error('BACKUP_MISMATCH');
      return b.before;
    },
    async compareAndApply(beforeDigest, after, key) {
      if (options.observationSources?.includes(after.record.sourceId)) throw new Error('OBSERVATION_ONLY');
      const b = await load(key), current = await getDoc(after.record.uid);
      if (stableDigest(b.before) !== beforeDigest || stableDigest(current) !== stableDigest(b.document) ||
        (current && envelope(current).locked_by_contract) || after.locked_by_contract) throw new Error('CAS_CONFLICT');
      if (current && envelope(current).record.sourceId !== after.record.sourceId) throw new Error('UID_OTHER_SUPPLIER');
      const fields = nativeCycleFields(after, current ? decodeFields(current.fields) : {});
      const query = new URLSearchParams(current ? { 'currentDocument.updateTime': current.updateTime } : { 'currentDocument.exists': 'false' });
      for (const field of Object.keys(fields)) query.append('updateMask.fieldPaths', fieldPath(field));
      const result = await request(docPath(after.record.uid) + '?' + query, 'PATCH', { fields: encodeFields(fields) });
      const reread = await getDoc(after.record.uid);
      if (!reread || reread.updateTime !== result.updateTime || Object.entries(fields).some(([k, v]) =>
        stableDigest(decodeFields(reread.fields)[k]) !== stableDigest(v))) throw new Error('READBACK_UNCERTAIN');
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
      if (!current || stableDigest(current) !== stableDigest(receipt.after) || envelope(current).locked_by_contract) throw new Error('CAS_CONFLICT');
      if (options.observationSources?.includes(envelope(current).record.sourceId)) throw new Error('OBSERVATION_ONLY');
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
