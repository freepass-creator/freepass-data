import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSonogongOptions, summarizeOptionProjections } from '../src/domain/sonogong-options.js';
import { runSonogongOptionsPlan } from '../src/jobs/plan-sonogong-options.js';

describe('손오공 옵션 투영', () => {
  it('선택옵션만 유상으로 나누고 금액은 양의 정수일 때만 KNOWN', () => {
    const p = projectSonogongOptions([
      { category: 'SAFETY', name: '  전방  충돌방지 ', amount: null },
      { category: '선택옵션', name: '파노라마 선루프', amount: 1_200_000 },
      { category: '선택옵션', name: '프리미엄 패키지', amount: null },
      { category: '선택옵션', name: '이상값', amount: 0 },
      { category: '선택옵션', name: '소수', amount: 10.5 },
    ]);
    expect(p.basic).toEqual([{ category: 'SAFETY', name: '전방 충돌방지' }]);
    expect(p.paid.map(o => [o.name, o.amount_state, o.amount_krw])).toEqual([
      ['파노라마 선루프', 'KNOWN', 1_200_000], ['프리미엄 패키지', 'UNKNOWN', null], ['이상값', 'UNKNOWN', null], ['소수', 'UNKNOWN', null],
    ]);
    expect(p.paid[3]!.amount_raw).toBe(10.5);
    expect(p.notes.paidAmountUnknown).toBe(3);
  });

  it('이름으로 유상을 추정하지 않는다 — 금액이 붙은 비선택옵션은 기본으로 두고 센다', () => {
    const p = projectSonogongOptions([{ category: 'EXTERIOR', name: '유상 휠(추가금)', amount: 500000 }]);
    expect(p.paid).toEqual([]);
    expect(p.basic).toEqual([{ category: 'EXTERIOR', name: '유상 휠(추가금)' }]);
    expect(p.notes.amountOnNonPaid).toBe(1);
  });

  it('빈 이름·중복·배열 아님을 안전하게 처리한다', () => {
    const p = projectSonogongOptions([{ category: 'SAFETY', name: ' ' }, { category: 'SAFETY', name: 'ＡＢＳ' }, { category: 'SAFETY', name: 'ABS' }, null, 3]);
    expect(p.basic).toEqual([{ category: 'SAFETY', name: 'ABS' }]);
    expect(p.notes).toMatchObject({ inputCount: 5, droppedEmptyName: 3, duplicates: 1 });
    expect(projectSonogongOptions(undefined).notes.inputCount).toBe(0);
  });

  it('알려진 무상 코드 밖의 구분은 무상으로 확정하지 않고 분포 키로도 원문을 내지 않는다', () => {
    const p = projectSonogongOptions([
      { category: 'SAFETY', name: 'A', amount: null },
      { category: '12가3456 옵션 900000원', name: 'B', amount: null },
      { category: '', name: 'C', amount: null },
    ]);
    expect(p.basic).toEqual([{ category: 'SAFETY', name: 'A' }]);
    expect(p.unclassified).toEqual([{ name: 'B' }, { name: 'C' }]);
    expect(p.notes.unknownCategory).toBe(2);
    const s = summarizeOptionProjections([p]);
    expect(s.byCategory).toEqual({ SAFETY: 1, UNKNOWN_CATEGORY: 2 });
    expect(s.unclassifiedTotal).toBe(2);
    expect(JSON.stringify(s)).not.toContain('12가3456');
  });

  it('집계는 값을 내지 않고 건수만 낸다', async () => {
    const entries = [
      { detail: { options: [{ category: 'SAFETY', name: 'A', amount: null }, { category: '선택옵션', name: 'B', amount: 900000 }] } },
      { raw: { detail: { options: [{ category: '선택옵션', name: 'C', amount: null }] } } },
      { options: [] },
      {},
    ];
    const s = summarizeOptionProjections(entries.map(e => projectSonogongOptions((e as { detail?: { options?: unknown }; options?: unknown }).detail?.options ?? (e as { options?: unknown }).options)));
    expect(s).toMatchObject({ documents: 4, documentsWithOptions: 1, basicTotal: 1, paidTotal: 1, paidKnown: 1, paidUnknown: 0, documentsWithKnownPaid: 1 });
    const dir = await mkdtemp(join(tmpdir(), 'opt-plan-'));
    const file = join(dir, 'records.json');
    await writeFile(file, JSON.stringify(entries));
    const out = await runSonogongOptionsPlan({ records: file });
    expect(out.writes).toBe(0);
    expect(out.summary).toMatchObject({ documents: 4, documentsWithOptions: 2, paidKnown: 1, paidUnknown: 1 });
    expect(JSON.stringify(out)).not.toContain('900000');
    await writeFile(file, '{}');
    await expect(runSonogongOptionsPlan({ records: file })).rejects.toThrow('OPTIONS_RECORDS_INVALID');
  });
});
