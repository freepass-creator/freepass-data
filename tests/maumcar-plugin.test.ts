import { describe, expect, it, vi } from 'vitest';
import { maumcarFilePlugin } from '../src/runtime/source-cycle-runtime.js';
import { convertMaumcarWorkbook } from '../src/adapters/maumcar-file.js';
import { emptyCycleState, type CycleCommands, type CycleControl, type CycleProduct } from '../src/application/source-cycle.js';
import { runSourceCycle } from '../src/jobs/source-cycle.js';
import type { XlsxSheet } from '../src/adapters/xlsx-reader.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';

// 마음카 파일 플러그인 → 회차 → 계획(쓰기 0 확인 포함): 파일에 없는 차는 하향하지 않고(공급사 확인 필요), 같은 파일을 다시 적용하면 쓰기가 없다.
const time = '2026-10-15T09:30:00.000Z', now = Date.parse(time);
const sheet: XlsxSheet = { name: 'Sheet1', rows: [
  ['NO', '차량명', '연료', '년식', '색상', '옵션', '현주행거리', '신차가격', '12개월', '24개월', '차량번호', '출고여부'],
  ['1', '그랜저 GN7 2.5', '가솔린', '2023', '블랙', '', '12000', '4000', '93/93', '90/90', '12가3456', '즉시'],
  ['2', '카니발', '디젤', '2023', '화이트', '', '', '', '100/80', '', '34나5678', '즉시'],
] };
const records = (observedAt = time) => convertMaumcarWorkbook([sheet], { observedAt, fileSha256: 'b'.repeat(64) }).records;
const stored = (r: SourceProductRecord): CycleProduct => ({ record: structuredClone(r), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null });
const old: SourceProductRecord = { ...records()[0]!, uid: '99허9999', plate: '99허9999', vehicleText: '파일에 없는 옛 차' };

function harness(initial: CycleProduct[]) {
  const data = new Map(initial.map(p => [p.record.uid, structuredClone(p)]));
  const writes: string[] = [];
  const backups = new Map<string, CycleProduct | null>();
  const commands = {
    async list() { return { complete: true, products: structuredClone([...data.values()]) }; },
    async read(_s: string, uid: string) { return structuredClone(data.get(uid) ?? null); },
    async backup(key: string, value: CycleProduct | null) { backups.set(key, structuredClone(value)); },
    async readBackup(key: string) { return structuredClone(backups.get(key)!); },
    async compareAndApply(_digest: string, after: CycleProduct) { writes.push(after.record.uid); data.set(after.record.uid, structuredClone(after)); },
  } as unknown as CycleCommands;
  let state = emptyCycleState();
  const control: CycleControl = {
    async acquire() { return async () => undefined; },
    async load() { return structuredClone(state); }, async save(_id, s) { state = structuredClone(s); },
    heartbeat: vi.fn(async () => {}), async alert() { /* no-op */ },
  };
  return { commands, control, writes, data };
}
const plugin = () => maumcarFilePlugin(0.9, async () => ({ conversion: convertMaumcarWorkbook([sheet], { observedAt: time, fileSha256: 'b'.repeat(64) }), observedAt: time }));

describe('마음카 파일 플러그인', () => {
  it('reads as RP034, passes converted records, adds the report-only notes and an absence-blocking hold', async () => {
    const p = plugin();
    const read = await p.read();
    expect(p.sourceId).toBe('RP034');
    expect(read.complete).toBe(true);
    const converted = p.toRecords(read);
    expect(converted.records.map(r => r.plate!.slice(-4)).sort()).toEqual(['3456', '5678']);
    // 파일은 전체 목록의 권위가 아니다: 부재 판정을 막는 보류(번호 불명 계열)가 항상 1건 있다
    expect(converted.held.map(h => h.reasons[0])).toContain('ABSENCE_NOT_AUTHORITATIVE:UPSTREAM_ROW_HOLD');
    expect((read.raw as { notes?: string[] }).notes).toEqual(expect.arrayContaining(['PRE_RELEASE_REPORT_ONLY:0']));
  });

  it('a duplicate plate makes the read incomplete (no apply)', async () => {
    const dup: XlsxSheet = { name: 'S', rows: [...sheet.rows, ['3', '카니발', '디젤', '2023', '', '', '', '', '100/80', '', '34나5678', '즉시']] };
    const p = maumcarFilePlugin(0.9, async () => ({ conversion: convertMaumcarWorkbook([dup], { observedAt: time, fileSha256: 'c'.repeat(64) }), observedAt: time }));
    const read = await p.read();
    expect(read.complete).toBe(false);
  });

  it('plans from the file, never downgrades vehicles missing from the file, and re-applying the same file writes nothing', async () => {
    const h = harness([stored(old)]);
    const first = await runSourceCycle(plugin() as never, h.commands, h.control, { now: () => now, autoApprove: true });
    expect(['APPLIED', 'UNCHANGED', 'DRY_RUN', 'NOOP']).toContain(first.status);
    expect(h.data.get('99허9999')).toMatchObject({ listable: true, publication_withdrawal: null });   // 파일에 없다고 내리지 않는다
    expect(h.writes.filter(uid => uid === '99허9999')).toEqual([]);
    const enrolled = [...h.data.keys()].filter(uid => uid !== '99허9999').sort();
    expect(enrolled).toEqual(['12가3456', '34나5678']);
    const writesAfterFirst = h.writes.length;
    await runSourceCycle(plugin() as never, h.commands, h.control, { now: () => now + 60_000, autoApprove: true });
    expect(h.writes.length).toBe(writesAfterFirst);   // 같은 파일 다시 적용 → 쓰기 없음
  });
});
