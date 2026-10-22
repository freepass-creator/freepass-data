/** F05 공통시트 «차량번호» 칸 사진 폴더 링크 → 상품 photo_link (대표 2026-10-22 «f05에 사진이 잘 반영 안 된 것도 있어 erp에»).
 * 15분 수집이 값 읽기(values:batchGet)만 써서 칸 링크를 못 받았다 — 링크 읽기·폴더만 인정·덮지 않음·번호 불일치 거절을 시험한다. 값은 전부 합성. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFromBatchGet, sharedSheetTabs, sharedSheetPlateLinkRanges, SHEETS_PLATE_LINK_FIELDS, type SheetsPlateLinkGrid } from '../src/adapters/shared-sheet-capture.js';
import { sharedSheetChannels, sharedSheetHeaders, type SharedSheetCapture, type SheetCell } from '../src/adapters/shared-sheet-source.js';
import { f05NativeCapture } from '../src/adapters/source-cycle-native.js';
import { driveFolderIdOf, sheetPhotoLinksOf, photoLinkFillable, sheetPhotoLinkFields } from '../src/domain/sheet-photo-link.js';
import { comparableRecord, type SourceProductRecord } from '../src/domain/source-engine.js';
import { planSourceCycle, applySourceCycle, type CycleProduct } from '../src/application/source-cycle.js';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields } from '../src/infra/source-cycle-firestore.js';

const time = '2026-10-22T01:00:00.000Z', now = Date.parse('2026-10-22T01:05:00.000Z');
const ID_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1', ID_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';
const FOLDER_A = `https://drive.google.com/drive/folders/${ID_A}`, FOLDER_B = `https://drive.google.com/drive/folders/${ID_B}`;
const channel = sharedSheetChannels[0]!, SRC = channel.code;

describe('드라이브 폴더 링크만 인정', () => {
  it('accepts folder links (u/N, trailing slash, usp=sharing) and returns the folder id', () => {
    expect(driveFolderIdOf(FOLDER_A)).toBe(ID_A);
    expect(driveFolderIdOf(`https://drive.google.com/drive/u/0/folders/${ID_A}?usp=sharing`)).toBe(ID_A);
    expect(driveFolderIdOf(`https://drive.google.com/drive/folders/${ID_A}/`)).toBe(ID_A);
  });
  it.each([
    [`https://drive.google.com/file/d/${ID_A}/view`, 'file'],
    [`https://docs.google.com/spreadsheets/d/${ID_A}/edit`, 'doc'],
    [`https://drive.google.com/open?id=${ID_A}`, 'open?id (file or folder unknown)'],
    [`https://drive.google.com/drive/folders/${ID_A}?resourcekey=0-x`, 'resourcekey'],
    [`http://drive.google.com/drive/folders/${ID_A}`, 'http'],
    [`https://drive.google.com.evil.example/drive/folders/${ID_A}`, 'other host'],
    ['https://bit.ly/abc', 'short link'],
    ['https://drive.google.com/drive/folders/short', 'id too short'],
    ['', 'empty'],
  ])('rejects %s (%s)', link => expect(driveFolderIdOf(link)).toBeNull());
});

describe('차량번호 칸 링크 판정(폴더만·한 칸 한 링크·같은 폴더 다른 번호 거절)', () => {
  const plates: Record<string, string> = { 'T|2': '12가3456', 'T|3': '12가3457', 'T|4': '12가3458', 'T|5': '', 'T|6': '12가3459' };
  const plateAt = (tab: string, row: number) => plates[`${tab}|${row}`];
  it('keeps one canonical folder link per row and rejects the rest with counts only', () => {
    const { links, skipped } = sheetPhotoLinksOf([
      { tab: 'T', row: 2, links: [`https://drive.google.com/drive/u/1/folders/${ID_A}?usp=drive_link`] },
      { tab: 'T', row: 3, links: [`https://drive.google.com/file/d/${ID_B}/view`] },
      { tab: 'T', row: 4, links: [FOLDER_B, `https://drive.google.com/drive/folders/${'C'.repeat(33)}`] },
      { tab: 'T', row: 5, links: [FOLDER_B] },
    ], plateAt);
    expect([...links]).toEqual([['T|2', FOLDER_A]]);
    expect(skipped).toEqual({ NOT_FOLDER: 1, MULTIPLE_LINKS: 1, PLATE_MISSING: 1 });
  });
  it('the same folder linked on two different plates is rejected on both (copy-paste mistake)', () => {
    const { links, skipped } = sheetPhotoLinksOf([{ tab: 'T', row: 2, links: [FOLDER_A] }, { tab: 'T', row: 6, links: [FOLDER_A] }], plateAt);
    expect(links.size).toBe(0);
    expect(skipped).toEqual({ FOLDER_ON_MULTIPLE_PLATES: 2 });
  });
});

describe('15분 수집: 차량번호 칸 링크 읽기', () => {
  const SID = 'synthetic_spreadsheet_id_0001', ROWS = 1000;
  const meta = { spreadsheetId: SID, sheets: sharedSheetTabs().map(title => ({ properties: { title, gridProperties: { rowCount: ROWS } } })) };
  const row = (plate: string) => { const r = Array.from({ length: sharedSheetHeaders.length }, () => '' as unknown); r[0] = channel.companyName; r[4] = plate; return r; };
  const batch = { spreadsheetId: SID, valueRanges: sharedSheetTabs().map(t => ({ range: `'${t}'!A1:BV${ROWS}`,
    values: [[...sharedSheetHeaders], ...(t === channel.tab ? [row('12가3456'), row('12가3457')] : [])] })) };
  const grid = (cells: Array<Record<string, unknown>>): SheetsPlateLinkGrid => ({ spreadsheetId: SID, sheets: sharedSheetTabs().map(title => ({ properties: { title },
    data: [{ startColumn: 4, rowData: [{ values: [{ formattedValue: '차량번호' }] }, ...(title === channel.tab ? cells.map(c => ({ values: [c] })) : [])] }] })) });
  const capture = (links?: SheetsPlateLinkGrid, stats = { datesFromSerial: 0 }) => captureFromBatchGet(SID, batch, meta, time, batch, structuredClone(batch), stats, links);

  it('reads only the plate column with a minimal field mask', () => {
    expect(sharedSheetPlateLinkRanges()).toEqual(sharedSheetTabs().map(t => `'${t.replace(/'/g, "''")}'!E1:E`));
    expect(SHEETS_PLATE_LINK_FIELDS).toContain('rowData(values(formattedValue,hyperlink,');
    expect(SHEETS_PLATE_LINK_FIELDS).not.toMatch(/userEnteredValue|effectiveValue|note|dataValidation/);
  });
  it('a whole-cell hyperlink and a rich-text link on the plate text are both captured with their sheet row', () => {
    const c = capture(grid([{ formattedValue: '12가3456', hyperlink: FOLDER_A },
      { formattedValue: '12가3457', textFormatRuns: [{ startIndex: 0, format: { link: { uri: FOLDER_B } } }] }]));
    expect(c.plateLinks).toEqual([{ tab: channel.tab, row: 2, links: [FOLDER_A] }, { tab: channel.tab, row: 3, links: [FOLDER_B] }]);
  });
  it('a link whose cell text differs from the row plate (row moved between reads) is dropped', () => {
    const stats = { datesFromSerial: 0 } as Parameters<typeof capture>[1] & { plateLinksDropped?: number };
    const c = capture(grid([{ formattedValue: '99가9999', hyperlink: FOLDER_A }, { formattedValue: '12가3457', hyperlink: FOLDER_B }]), stats);
    expect(c.plateLinks).toEqual([{ tab: channel.tab, row: 3, links: [FOLDER_B] }]);
    expect(stats.plateLinksDropped).toBe(1);
  });
  it('without a link read (file input) or with a malformed grid the capture still succeeds, just without links', () => {
    expect(capture()).not.toHaveProperty('plateLinks');
    const stats = { datesFromSerial: 0 } as Parameters<typeof capture>[1] & { plateLinksUnavailable?: boolean };
    const bad = capture({ spreadsheetId: SID, sheets: sharedSheetTabs().map(title => ({ properties: { title }, data: [{ startColumn: 0, rowData: [] }] })) }, stats);
    expect(bad).not.toHaveProperty('plateLinks');
    expect(stats.plateLinksUnavailable).toBe(true);
    expect(capture({ spreadsheetId: 'other_spreadsheet_id_000001' })).not.toHaveProperty('plateLinks');
  });
});

describe('엔진 레코드: raw.sheet_photo_link', () => {
  function sheet(plates: string[], plateLinks: SharedSheetCapture['plateLinks']) {
    const headers = [...sharedSheetHeaders, 'UID'];
    const capture: SharedSheetCapture = { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-only', layoutVersion: '2026-10-04-no-account',
      readTime: time, revision: 'synthetic', ...(plateLinks ? { plateLinks } : {}), tabs: sharedSheetTabs().map(title => {
        const values = [headers, ...(title === channel.tab ? plates.map(plate => headers.map(h => ({ 회사명: channel.companyName,
          차량번호: plate, 차량상태: '출고가능', 상품구분: '중고렌트', '12개월': 500000, 단기보증: '무보증', 장기보증: '무보증',
          연주행: '20000km', '차명 원문': '합성' } as Record<string, SheetCell>)[h] ?? '')) : [])];
        return { title, readTime: time, complete: true, rowCount: values.length, values };
      }) };
    const visibility = { sheets: capture.tabs.map(t => ({ properties: { title: t.title, gridProperties: { rowCount: t.rowCount } },
      data: [{ startRow: 0, rowMetadata: t.values.map(() => ({})) }] })) };
    return f05NativeCapture(SRC, capture, visibility).rows.map(r => r.record);
  }
  it('a verified folder link on the plate cell reaches the record as the canonical folder link; other rows have none', () => {
    const records = sheet(['00가1001', '00가1002'], [{ tab: channel.tab, row: 2, links: [`${FOLDER_A}?usp=sharing`] }]);
    expect(records.find(r => r.uid === '00가1001')!.raw.sheet_photo_link).toBe(FOLDER_A);
    expect(records.find(r => r.uid === '00가1002')!.raw).not.toHaveProperty('sheet_photo_link');
  });
  it('a file link or a folder shared by two plates gives no link', () => {
    expect(sheet(['00가1001'], [{ tab: channel.tab, row: 2, links: [`https://drive.google.com/file/d/${ID_A}/view`] }])[0]!.raw).not.toHaveProperty('sheet_photo_link');
    const both = sheet(['00가1001', '00가1002'], [{ tab: channel.tab, row: 2, links: [FOLDER_A] }, { tab: channel.tab, row: 3, links: [FOLDER_A] }]);
    expect(both.every(r => !('sheet_photo_link' in r.raw))).toBe(true);
  });
  it('the link is not part of change detection (turning it on does not mass-UPDATE)', () => {
    const [withLink] = sheet(['00가1001'], [{ tab: channel.tab, row: 2, links: [FOLDER_A] }]);
    const [without] = sheet(['00가1001'], undefined);
    expect(comparableRecord(withLink!)).toEqual(comparableRecord(without!));
  });
});

describe('쓰기 규칙: 빈 photo_link 에만', () => {
  it('fills only a blank photo_link; a value, or a cache of another folder, is kept', () => {
    const raw = { sheet_photo_link: FOLDER_A };
    expect(sheetPhotoLinkFields(raw, {}, time)).toEqual({ photo_link: FOLDER_A, photo_link_source: { kind: 'SHARED_SHEET_PLATE_LINK', at: time } });
    expect(sheetPhotoLinkFields(raw, { photo_link: '  ' }, time)).toHaveProperty('photo_link', FOLDER_A);
    expect(sheetPhotoLinkFields(raw, { photo_link: FOLDER_B }, time)).toEqual({});
    expect(sheetPhotoLinkFields(raw, { photo_link: 'https://example.invalid/human' }, time)).toEqual({});
    expect(sheetPhotoLinkFields(raw, { photo_cache: { src: FOLDER_B, urls: ['https://drive.google.com/thumbnail?id=x'] } }, time)).toEqual({});
    expect(sheetPhotoLinkFields(raw, { photo_cache: { src: FOLDER_A, urls: ['https://drive.google.com/thumbnail?id=x'] } }, time)).toHaveProperty('photo_link', FOLDER_A);
    expect(sheetPhotoLinkFields(raw, { photo_cache: { urls: ['https://drive.google.com/thumbnail?id=x'] } }, time)).toEqual({});
    expect(sheetPhotoLinkFields({ sheet_photo_link: `https://drive.google.com/file/d/${ID_A}/view` }, {}, time)).toEqual({});
    expect(sheetPhotoLinkFields({}, {}, time)).toEqual({});
    expect(photoLinkFillable({ photo_cache: null })).toBe(true);
  });
});

describe('원천 엔진 쓰기(합성 Firestore)', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
  const rec = (plate: string, link?: string, rent = 500000): SourceProductRecord => ({ sourceId: SRC, uid: plate, plate, vehicleText: '합성 차명',
    status: { raw: '출고가능', saleAvailable: true }, observedAt: time, vehicleHold: [],
    raw: { source: 'shared-sheet', source_tab: channel.tab, source_row: 2, ...(link ? { sheet_photo_link: link } : {}) },
    terms: [{ months: 12, monthlyRent: { state: 'KNOWN', value: rent }, deposit: { state: 'ZERO', value: 0 }, mileage: '20000km', raw: {} }] });
  function fakeFirestore() {
    const docs = new Map<string, any>(); let version = 0, patches = 0;
    const doc = (uid: string, fields: any) => ({ name: `projects/synthetic-test/databases/(default)/documents/products/${uid}`, updateTime: `${time}:${++version}`, fields });
    const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)), uid = decodeURIComponent(url.pathname.split('/').at(-1)!);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (!init.method || init.method === 'GET') {
        let result: any = uid === 'products' ? { documents: [...docs.values()] } : docs.get(uid);
        if (!result) return new Response('{}', { status: 404 });
        result = structuredClone(result);
        const masked = url.searchParams.getAll('mask.fieldPaths').map(p => p.replace(/`/g, ''));
        if (uid === 'products' && masked.length) for (const d of result.documents) d.fields = Object.fromEntries(Object.entries(d.fields ?? {}).filter(([k]) => masked.includes(k)));
        return Response.json(result);
      }
      const current = docs.get(uid);
      if (url.searchParams.get('currentDocument.exists') === 'false' ? !!current : current?.updateTime !== url.searchParams.get('currentDocument.updateTime')) return new Response('{}', { status: 412 });
      patches++;
      const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
      const after = doc(uid, fields); docs.set(uid, after); return Response.json(after);
    }) as unknown as typeof fetch;
    return { docs, fetcher, patches: () => patches,
      patch: (uid: string, f: Record<string, unknown>) => { const d = docs.get(uid); docs.set(uid, doc(uid, { ...d.fields, ...encodeFields(f as never) })); } };
  }
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'f05-photo-link-')); dirs.push(dir);
    const fake = fakeFirestore();
    const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
      supplierDefaults: { [SRC]: { provider_name: '합성공급사', policy_code: null } } });
    const run = async (records: SourceProductRecord[]) => {
      const built = planSourceCycle({ sourceId: SRC, family: 'SHARED_SHEET', maxDowngradeRatio: 1 }, { records, observedAt: time, heldCount: 0, complete: true }, await commands.list(SRC), now);
      const applied = built.plan.entries.length ? await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now }) : null;
      return { kinds: built.plan.entries.map(e => e.kind), warnings: built.plan.warnings, applied };
    };
    const fields = (uid: string) => decodeFields(fake.docs.get(uid).fields);
    return { fake, run, fields };
  }

  it('a new car is enrolled with photo_link from the sheet link', async () => {
    const { run, fields } = await setup();
    const result = await run([rec('12가2001', FOLDER_A)]);
    expect(result.kinds).toEqual(['ENROLL']);
    expect(result.applied).toMatchObject({ status: 'APPLIED' });
    expect(fields('12가2001')).toMatchObject({ photo_link: FOLDER_A, photo_link_source: { kind: 'SHARED_SHEET_PLATE_LINK' } });
  });

  it('an existing exposed document without photo_link gets the link once (PHOTO_LINK), then stays unchanged', async () => {
    const { fake, run, fields } = await setup();
    await run([rec('12가2002')]);
    expect(fields('12가2002')).not.toHaveProperty('photo_link');
    expect((await run([rec('12가2002')])).kinds).toEqual([]);   // 시트에 링크가 없으면 다시 쓰지 않는다
    const before = fake.patches();
    const result = await run([rec('12가2002', FOLDER_A)]);
    expect(result.kinds).toEqual(['UPDATE']);
    expect(result.warnings).toContain('PHOTO_LINK_FILL:1');
    expect(result.applied).toMatchObject({ status: 'APPLIED' });
    expect(fake.patches()).toBe(before + 1);
    expect(fields('12가2002')).toMatchObject({ photo_link: FOLDER_A, price: { 12: { rent: 500000 } } });
    expect((await run([rec('12가2002', FOLDER_A)])).kinds).toEqual([]);
  });

  it('a photo_link that already has a value is never overwritten, even when the document is rewritten for a price change', async () => {
    const { fake, run, fields } = await setup();
    await run([rec('12가2003')]);
    fake.patch('12가2003', { photo_link: FOLDER_B });
    expect((await run([rec('12가2003', FOLDER_A)])).kinds).toEqual([]);
    expect((await run([rec('12가2003', FOLDER_A, 510000)])).kinds).toEqual(['UPDATE']);
    expect(fields('12가2003')).toMatchObject({ photo_link: FOLDER_B, price: { 12: { rent: 510000 } } });
    expect(fields('12가2003')).not.toHaveProperty('photo_link_source');
  });

  it('a document whose drive cache points to another folder is not given the sheet link', async () => {
    const { fake, run, fields } = await setup();
    await run([rec('12가2004')]);
    fake.patch('12가2004', { photo_cache: { src: FOLDER_B, urls: ['https://drive.google.com/thumbnail?id=synthetic&sz=w640'] } });
    expect((await run([rec('12가2004', FOLDER_A)])).kinds).toEqual([]);
    expect(fields('12가2004')).not.toHaveProperty('photo_link');
    // 캐시가 같은 폴더면 빈 photo_link 를 채운다(캐시·링크가 같은 차를 가리킨다).
    await run([rec('12가2005')]);
    fake.patch('12가2005', { photo_cache: { src: FOLDER_A, urls: ['https://drive.google.com/thumbnail?id=synthetic&sz=w640'] } });
    expect((await run([rec('12가2005', FOLDER_A)])).kinds).toEqual(['UPDATE']);
    expect(fields('12가2005')).toMatchObject({ photo_link: FOLDER_A, photo_cache: { src: FOLDER_A } });
    expect((await run([rec('12가2005', FOLDER_A)])).kinds).toEqual([]);
  });

  it('photo-only rewrites share the per-cycle rewrite cap (deferred, not lost)', () => {
    const stored = (i: number): CycleProduct => ({ record: { ...rec(`12가${3000 + i}`), raw: { source: 'shared-sheet', source_tab: channel.tab, source_row: 2 } },
      listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null, photoLinkFill: { cacheFolder: null } });
    const n = 101, products = Array.from({ length: n }, (_, i) => stored(i));
    const records = Array.from({ length: n }, (_, i) => rec(`12가${3000 + i}`, `https://drive.google.com/drive/folders/${String(i).padStart(3, '0')}${'F'.repeat(30)}`));
    const { plan } = planSourceCycle({ sourceId: SRC, family: 'SHARED_SHEET', maxDowngradeRatio: 1 }, { records, observedAt: time, heldCount: 0, complete: true },
      { products, complete: true }, now);
    expect(plan.entries).toHaveLength(100);
    expect(plan.warnings.some(w => w.startsWith('API_OPTIONS_DEFERRED:1:'))).toBe(true);
    expect(nativeCycleFields(plan.entries[0]!.after, { car_number: plan.entries[0]!.after.record.plate })).toHaveProperty('photo_link');
  });
});
