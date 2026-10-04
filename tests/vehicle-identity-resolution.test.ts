import { describe, expect, it } from 'vitest';
import { chooseVehicleIdentity, dataIdentityToF03, indexF03, type F03Row, type VehicleIdentity } from '../src/domain/vehicle-identity-resolution.js';
import { f03SnapshotFromBatchGet, dataIdentitiesFromErp5, buildVehicleIdentityInputs } from '../src/adapters/vehicle-identity-inputs.js';
import type { Erp5SourceCapture } from '../src/adapters/erp5-source-capture.js';

const row = (maker: string, model: string, subModel: string, trimName: string, start: string, end: string): F03Row =>
  ({ maker, model, subModel, trimName, start, end, subModelKey: `vms_${maker}_${model}_${subModel}` });
const f03 = indexF03({
  rows: [
    row('르노', '그랑 콜레오스', '기본형', '아이코닉', '2024-07', '현재'),
    row('르노', '그랑 콜레오스', '기본형', 'ECH 아이코닉', '2024-07', '현재'),
    row('기아', '니로', '디 올 뉴 니로', '프레스티지', '2022-01', '2026-03'),
    row('기아', '니로', '더 뉴 니로 SG2', '프레스티지', '2026-03', '현재'),
    row('KGM', '렉스턴', '올 뉴 렉스턴', '프레스티지', '2020-10', '2023-05'),
    row('KGM', '렉스턴', '렉스턴 스포츠', '프레스티지', '2018-01', '2021-04'),
    row('현대', '쏘나타', '쏘나타 DN8', '익스클루시브', '2019-03', '2023-04'),
    row('현대', '쏘나타', '쏘나타 디 엣지 DN8', '익스클루시브', '2023-04', '현재'),
    row('기아', 'K5', 'K5 DL3', '트렌디', '2019-12', '2023-10'),
    row('기아', 'K5', '더 뉴 K5 DL3', '트렌디', '2023-10', '현재'),
    row('제네시스', 'G90', 'G90 RS4', '기본형', '2021-12', '현재'),
    row('현대', '팰리세이드', '기본형', '익스클루시브', '2018-11', '2022-07'),
    row('현대', '팰리세이드', '더 뉴 팰리세이드', '익스클루시브', '2022-07', '현재'),
  ],
  aliases: [
    { kind: '제조사', oldName: '르노코리아(삼성)', model: '', displayName: '르노', key: '' },
    { kind: '제조사', oldName: 'KG모빌리티(쌍용)', model: '', displayName: 'KGM', key: '' },
    { kind: '세부모델', oldName: '렉스턴 스포츠 Q200', model: '렉스턴', displayName: '렉스턴 스포츠', key: '' },
  ],
});
const pick = (sheet: VehicleIdentity, data: VehicleIdentity | null, raw: string, firstRegistration: string, modelYear = '') =>
  chooseVehicleIdentity(f03, { sheet, data, raw, firstRegistration, modelYear });

describe('Data-first vehicle identity (Data → F03 → no contradiction with the source text)', () => {
  it('maps Data names through F03 aliases and the 기본형 rule', () => {
    expect(dataIdentityToF03(f03, ['르노코리아', '그랑 콜레오스', '그랑 콜레오스', '아이코닉'])).toEqual(['르노', '그랑 콜레오스', '기본형', '아이코닉']);
    expect(dataIdentityToF03(f03, ['KG모빌리티', '렉스턴', '렉스턴 스포츠 Q200', '프레스티지'])).toEqual(['KGM', '렉스턴', '렉스턴 스포츠', '프레스티지']);
    expect(dataIdentityToF03(f03, ['기아', 'A6', 'A6 C9', '45 TFSI'])).toBeNull();
  });
  it('adopts Data when it agrees with the source text, including filling a blank sheet trim', () => {
    const c = pick(['제네시스', 'G90', 'G90 RS4', ''], ['제네시스', 'G90', 'G90 RS4', '기본형'], 'G90 RS4 런칭 SEDAN 3.5T 2WD', '22-10-07');
    expect(c).toMatchObject({ pick: 'DATA', identity: ['제네시스', 'G90', 'G90 RS4', '기본형'] });
    const p = pick(['현대', '팰리세이드', '기본형', '익스클루시브'], ['현대', '팰리세이드', '더 뉴 팰리세이드', '익스클루시브'], '팰리세이드 LX2 디젤 2.2 4WD 익스클루시브', '2023-05');
    expect(p.pick).toBe('DATA');
  });
  it('keeps the sheet when Data drops the hybrid marker the source text has', () => {
    const c = pick(['르노', '그랑 콜레오스', '기본형', 'ECH 아이코닉'], ['르노코리아', '그랑 콜레오스', '그랑 콜레오스', '아이코닉'],
      '그랑 콜레오스 하이브리드 1.5 2WD E-TECH 아이코닉', '26.08.04');
    expect(c).toMatchObject({ pick: 'SHEET', notes: expect.arrayContaining(['HYBRID_MISSING']) });
  });
  it('keeps the sheet when Data is outside the production period or uses words absent from the source', () => {
    expect(pick(['기아', '니로', '디 올 뉴 니로', '프레스티지'], ['기아', '니로', '더 뉴 니로 SG2', '프레스티지'],
      '디 올 뉴 니로 SG2 하이브리드 1.6 프레스티지', '25.12.29').pick).toBe('SHEET');
    expect(pick(['KGM', '렉스턴', '올 뉴 렉스턴', '프레스티지'], ['KG모빌리티', '렉스턴', '렉스턴 스포츠 Q200', '프레스티지'],
      '렉스턴 2.2 4WD 프레스티지', '20.11.25')).toMatchObject({ pick: 'SHEET', notes: expect.arrayContaining(['TOKEN_NOT_IN_SOURCE:스포츠']) });
    expect(pick(['현대', '쏘나타', '쏘나타 디 엣지 DN8', '익스클루시브'], ['현대', '쏘나타', '쏘나타 DN8', '익스클루시브'],
      '디 엣지 쏘나타DN8 The Edge 자가용 가솔린 2.0 CVVL 익스클루시브', '23-06')).toMatchObject({ pick: 'SHEET', notes: ['SHEET_MATCHES_SOURCE_BETTER'] });
  });
  it('holds when the source text and the production period disagree, or when neither side is an F03 row', () => {
    expect(pick(['기아', 'K5', 'K5 DL3', '트렌디'], ['기아', 'K5', '더 뉴 K5 DL3', '트렌디'], '더 뉴 K5 DL3 LPG 2.0 트렌디', '23.05.31'))
      .toMatchObject({ pick: 'HOLD', notes: expect.arrayContaining(['PERIOD', 'SOURCE_VS_PERIOD_CONFLICT']) });
    expect(pick(['기아', 'A6', '', ''], ['기아', 'A6', 'A6 C9', '45 TFSI'], 'A6 C9 가솔린 2.0', '26-09').pick).toBe('HOLD');
    expect(pick(['현대', '쏘나타', '쏘나타 디 엣지 DN8', '익스클루시브'], null, '쏘나타 디 엣지', '24-01')).toMatchObject({ pick: 'SHEET', notes: ['DATA_ABSENT'] });
  });
});

describe('vehicle identity inputs', () => {
  it('reads F03 (merged rows excluded) and ERP5 products by plate, dropping plates with conflicting Data', () => {
    const head = ['원산지', '제조사', '모델', '세부모델', '세부트림', '생산시작', '생산종료', '클로드 지식검토', '클로드 엔카대조',
      '', '', '', '', '', '', '모델행키', '세부모델행키', '세부트림행키', '원자ID'];
    const snapshot = f03SnapshotFromBatchGet({ valueRanges: [
      { values: [head, ['국산', '현대', '쏘나타', '쏘나타 DN8', '스마트', '2019-03', '2023-04', '', '', '', '', '', '', '', '', 'vmm', 'vms_1'],
        ['국산', '현대', '쏘나타', '쏘나타 DN8', '스마트 초이스', '2019-03', '2023-04', '', '통합→스마트']] },
      { values: [['구분', '옛 이름(원본·이전 표기)', '모델', 'F03 표시명', 'F03 세부모델행키'], ['제조사', '토요타', '', '도요타', '']] }] });
    expect(snapshot.rows.map(r => r.trimName)).toEqual(['스마트']);
    expect(snapshot.aliases).toHaveLength(1);
    const doc = (plate: string, sub: string) => ({ name: `x/${plate}`, createTime: 'a', updateTime: 'b', fields: {
      car_number: { stringValue: plate }, maker: { stringValue: '현대' }, model: { stringValue: '쏘나타' },
      sub_model: { stringValue: sub }, trim_name: { stringValue: '스마트' } } });
    const capture = { readTime: '2026-10-04T00:00:00.000Z', collections: { products: { count: 4, documents: [
      doc('TEST-FAKE-1', '쏘나타 DN8'), doc('TEST-FAKE-2', '쏘나타 DN8'), doc('TEST-FAKE-2', '쏘나타 디 엣지 DN8'), doc('신차', '쏘나타 DN8')] } } } as unknown as Erp5SourceCapture;
    expect(dataIdentitiesFromErp5(capture)).toEqual([{ plate: 'TEST-FAKE-1', identity: ['현대', '쏘나타', '쏘나타 DN8', '스마트'] }]);
    const inputs = buildVehicleIdentityInputs(snapshot, '2026-10-04T00:00:00.000Z', capture);
    expect(inputs).toMatchObject({ schema: 'vehicle-identity-inputs/v1', dataReadTime: '2026-10-04T00:00:00.000Z' });
  });
});

describe('shared-sheet plan with identity inputs', () => {
  it('fills from Data through F03, records the source, and the reviewed plan replays the same decision', async () => {
    const { planSharedSheetCanonical } = await import('../src/jobs/ingest-shared-sheet-canonical.js');
    const { MemoryDataStore } = await import('../src/infra/memory-store.js');
    const { sharedSheetChannels, sharedSheetHeaders } = await import('../src/adapters/shared-sheet-source.js');
    const { stableDigest } = await import('../src/shared/stable-digest.js');
    const t = '2026-10-04T00:00:00.000Z';
    const data: Record<string, string | number> = { 회사명: '웰릭스', 차량번호: 'TEST-FAKE-001', 차량상태: '출고가능', 상품구분: '중고렌트',
      제조사: '시험제조사', 모델: '시험모델', 세부모델: '시험세부모델', 세부트림: '', 연식: '26MY', 최초등록일: '26.04',
      연료: 'HEV', 주행거리: '1,234km', 배기량: '1,234cc', 인승: '5', 구동방식: 'AWD', '차명 원문': '시험모델 시험세부모델 시험트림',
      단기보증: 101, 장기보증: 202, '1개월': 303, '12개월': 404 };
    const channel = sharedSheetChannels.find(x => x.companyName === '웰릭스')!;
    const capture = { schema: 'shared-sheet-capture/v1' as const, spreadsheetId: 'synthetic-sheet', layoutVersion: '2026-10-04-no-account',
      readTime: t, revision: 'r1', tabs: [...new Set(sharedSheetChannels.map(x => x.tab))].map(title => {
        const values = [[...sharedSheetHeaders], ...(title === channel.tab ? [sharedSheetHeaders.map(h => data[h] ?? '')] : [])];
        return { title, readTime: t, complete: true as const, rowCount: values.length, values };
      }) };
    const f03 = { rows: [row('시험제조사', '시험모델', '시험세부모델', '시험트림', '2025-01', '현재')], aliases: [] };
    const identity = ['시험제조사', '시험모델', '시험세부모델', '시험트림'] as const;
    const inputs = { schema: 'vehicle-identity-inputs/v1' as const, f03, f03ReadAt: t, f03Digest: stableDigest(f03),
      data: [{ plate: 'TEST-FAKE-001', identity }], dataReadTime: t, dataDigest: stableDigest([{ plate: 'TEST-FAKE-001', identity }]) };
    const store = new MemoryDataStore();
    const without = await planSharedSheetCanonical(store, capture, 'synthetic-target');
    expect(without.plan.entries[0]!.reasons).toContain('VEHICLE_IDENTITY_INCOMPLETE');
    const withData = await planSharedSheetCanonical(store, capture, 'synthetic-target', inputs);
    expect(withData.plan.entries[0]!.reasons).not.toContain('VEHICLE_IDENTITY_INCOMPLETE');
    expect(withData.plan.identityInputs?.dataDigest).toBe(inputs.dataDigest);
    const again = await planSharedSheetCanonical(store, capture, 'synthetic-target', withData.plan.identityInputs);
    expect(stableDigest(again.plan.entries)).toBe(stableDigest(withData.plan.entries));
  });
});
