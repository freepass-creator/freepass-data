import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMasterAdditionCandidates, candidatesToCsv, decomposeSonogongName, maskSensitive } from '../src/application/master-addition-candidates.js';
import { runMasterCandidatesCli } from '../src/jobs/build-master-addition-candidates.js';
import type { IdentityMaster } from '../src/application/identity-promotion-plan.js';

// 합성 값만. 손오공 원문 형식 «제조사_모델(코드)_연료 배기량 …».
const master: IdentityMaster = { id: 'M1', maker: '현대', model: '그랜저', sub_model: '그랜저 GN7', model_aliases: [], sub_model_aliases: [],
  yearFrom: 2022, yearTo: null, trims: [{ name: '프리미엄', aliases: [] }, { name: '캘리그래피', aliases: [] }] };
const product = (id: string, rawName: string, extra: Record<string, unknown> = {}) => ({ id, plate4: id.slice(-4), maker: '', model: '', sub_model: rawName,
  trim_name: '', rawName, year: '2023', listable: true, supplier: 'RP012', engineTemp: true, ...extra });

describe('손오공 원문 분해(결정적, 추정 없음)', () => {
  it('제조사_모델(코드)_파워트레인 을 나누고, 형식이 아니면 null', () => {
    expect(decomposeSonogongName('제네시스_G80 (RG3)_가솔린 2.5 터보 AWD')).toEqual({ maker: '제네시스', model: 'G80', code: 'RG3', powertrain: '가솔린 2.5 터보 AWD' });
    expect(decomposeSonogongName('현대_아반떼_가솔린 1.6')).toEqual({ maker: '현대', model: '아반떼', code: '', powertrain: '가솔린 1.6' });
    expect(decomposeSonogongName('그냥 문장')).toBeNull();
    expect(decomposeSonogongName('현대_아반떼')).toBeNull();
  });
});

describe('마스터 추가 후보 표(읽기 전용)', () => {
  const products = [
    product('12가1001', '제네시스_G80 (RG3)_가솔린 2.5 터보 AWD'), product('12가1002', '제네시스_G80 (RG3)_가솔린 2.5 터보 AWD', { year: '2022' }),
    product('12가1003', '기아_모하비 (HM)_디젤 3.0'),
  ];
  it('NO_MASTER_MATCH 를 원문 차명 단위로 묶고 제안은 미확정 문구, 끝4만 출력', () => {
    const r = buildMasterAdditionCandidates(products, [master]);
    const g80 = r.rows.find(x => x.rawName.includes('G80'))!;
    expect(g80).toMatchObject({ supplier: 'RP012', reason: 'NO_MASTER_MATCH', count: 2, yearRange: '2022-2023' });
    expect(g80.decomposed).toMatchObject({ maker: '제네시스', model: 'G80', code: 'RG3' });
    expect(g80.plate4Samples).toEqual(['1001', '1002']);
    expect(g80.proposal).toContain('미확정');
    expect(g80.proposal).not.toContain('G80 RG3 FL');   // 이름을 지어내지 않는다
    expect(r.heldTotal).toBeGreaterThanOrEqual(3);
    expect(r.rows.map(x => x.count)).toEqual([...r.rows.map(x => x.count)].sort((a, b) => b - a));
  });

  it('CSV 는 승인 칸이 비어 있고 쉼표·따옴표를 안전하게 감싼다', () => {
    const csv = candidatesToCsv(buildMasterAdditionCandidates(products, [master]).rows);
    const [header, first] = csv.split('\r\n');
    expect(header!.endsWith('승인(예/아니오)')).toBe(true);
    expect(first!.endsWith(',')).toBe(true);
    expect(csv).not.toMatch(/\d{2,3}[가-힣]\d{4}/);   // 전체 번호 없음
  });

  it('수식 주입 방어: = + - @ 로 시작하는 원문은 앞에 작은따옴표', () => {
    const csv = candidatesToCsv(buildMasterAdditionCandidates([product('12가2001', '=HYPERLINK("x")'), product('12가2002', '+1+1'), product('12가2003', '@SUM(A1)'),
      product('12가2004', '-2+3')], [master]).rows);
    for (const cell of ["'=HYPERLINK", "'+1+1", "'@SUM", "'-2+3"]) expect(csv).toContain(cell);
    expect(csv).not.toMatch(/(^|,)"?[=+@]/m);
  });

  it('원문에 섞인 전체 차량번호·전화번호·긴 숫자열은 마스킹한다(끝 4자리만 남음)', () => {
    const r = buildMasterAdditionCandidates([product('12가3001', '현대_그랜저_12가3456 연락 010-1234-5678 번호 12345678901')], [master]);
    const text = JSON.stringify(r.rows) + candidatesToCsv(r.rows);
    expect(text).not.toMatch(/\d{2,3}[가-힣]\s?\d{4}/);
    expect(text).not.toContain('010-1234-5678');
    expect(text).not.toContain('12345678901');
    expect(text).toContain('****3456');
    expect(maskSensitive('서울 34나5678')).toBe('서울 ****5678');
  });

  it('허용 목록 밖 사유도 합계에서 빠지지 않는다: heldTotal = 표 사유 합 + 제외 사유 합', () => {
    const many = [product('12가4001', '제네시스_G80 (RG3)_가솔린'), product('12가4002', '그랜저 GN7'), product('12가4003', '현대_그랜저 GN7 프리미엄', { sub_model: '그랜저 GN7', maker: '현대', model: '그랜저' })];
    const r = buildMasterAdditionCandidates(many, [master]);
    const listed = Object.values(r.reasonCounts).reduce((a, b) => a + b, 0), excluded = Object.values(r.excludedReasons).reduce((a, b) => a + b, 0);
    expect(listed + excluded).toBe(r.heldTotal);
  });

  it('CLI: 쓰기는 지정한 CSV·요약만, 요약은 공급사·사유별 대수', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cand-'));
    const input = join(dir, 'snap.json'), csv = join(dir, 'out.csv'), summary = join(dir, 'sum.json');
    await writeFile(input, JSON.stringify({ products, masters: [master] }));
    const s = await runMasterCandidatesCli({ input, csv, summary });
    expect(s).toMatchObject({ status: 'MASTER_ADDITION_CANDIDATES', writes: 0 });
    expect(s.bySupplier.RP012!.NO_MASTER_MATCH).toBe(3);
    expect((await readFile(csv, 'utf8')).charCodeAt(0)).toBe(0xFEFF);
    await expect(runMasterCandidatesCli({ input, csv: undefined })).rejects.toThrow('MASTER_CANDIDATES_ARGS_REQUIRED');
  });
});
