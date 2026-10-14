import { describe, expect, it, vi } from 'vitest';
import { sonogongApiWritePlugin } from '../src/runtime/source-cycle-runtime.js';
import { emptyCycleState, type CycleCommands, type CycleControl, type CycleProduct } from '../src/application/source-cycle.js';
import { runSourceCycle } from '../src/jobs/source-cycle.js';
import type { SonogongApiRead } from '../src/adapters/sonogong-api.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';

// Codex #666 ⑵: 읽는 동안 목록이 바뀌어 상세 번호가 다른 차는 «그 차만 보류»(IDENTITY_MISMATCH)한다. 읽기는 complete 이지만, 그 차의 레코드가 없으므로
// 같은 회차에 다른 차의 부재 하향을 만들면 안 된다 — 보류 사유가 값 계열(benign)이 아니라서 부재 하향이 건너뛰어짐을 끝까지(플러그인 → 회차 → 계획) 고정한다.
const time = '2026-10-14T06:00:00.000Z', now = Date.parse(time);
const rec = (plate: string): SourceProductRecord => ({ sourceId: 'RP012', uid: plate, plate, vehicleText: 'x', status: { raw: '출고가능', saleAvailable: true },
  observedAt: time, raw: { source: 'sonogong-partner-api' }, vehicleHold: [],
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'KNOWN', value: 1000000 }, mileage: null, raw: {} }] });
const product = (plate: string): CycleProduct => ({ record: rec(plate), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null });
const readOf = (records: SourceProductRecord[], over: Partial<SonogongApiRead> = {}): SonogongApiRead => ({ observedAt: time, complete: true, tabsRead: ['rent', 'sub', 'pick'],
  records, held: [], duplicatePlates: [], listed: records.length, detailsRead: records.length, notes: [], ...over });

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

describe('손오공: 차량 단위 보류는 같은 회차의 부재 하향을 만들지 않는다', () => {
  it('상세 번호 불일치로 보류된 차가 있으면 목록에 없는 다른 문서를 부재로 내리지 않는다(READ 는 complete)', async () => {
    const h = harness([product('12가1001'), product('12가1002'), product('12가1003')]);   // 1003 은 이번 읽기에 없음
    const plugin = sonogongApiWritePlugin(0.5, async () => readOf([rec('12가1001')], { held: [{ tab: 'sub', reason: 'IDENTITY_MISMATCH' }], notes: ['IDENTITY_MISMATCH_HELD:1'] }));
    const result = await runSourceCycle(plugin as never, h.commands, h.control, { now: () => now, autoApprove: true });
    expect(['APPLIED', 'DRY_RUN', 'UNCHANGED', 'NOOP', 'HOLD']).toContain(result.status);
    expect(h.writes.filter(uid => uid !== '12가1001')).toEqual([]);                       // 1002·1003 은 하향·변경 없음
    for (const uid of ['12가1002', '12가1003']) expect(h.data.get(uid)).toMatchObject({ listable: true, publication_withdrawal: null });
  });

  it('대조군: 보류가 없으면 같은 구성에서 부재 문서가 하향된다(위 시험이 우연히 통과하지 않음)', async () => {
    const h = harness([product('12가1001'), product('12가1002'), product('12가1003')]);
    const plugin = sonogongApiWritePlugin(0.9, async () => readOf([rec('12가1001'), rec('12가1002')]));
    await runSourceCycle(plugin as never, h.commands, h.control, { now: () => now, autoApprove: true });
    expect(h.data.get('12가1003')).toMatchObject({ listable: false, publication_withdrawal: { reason: 'SOURCE_ABSENT' } });
  });
});
