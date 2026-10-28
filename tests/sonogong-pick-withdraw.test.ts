import { describe, expect, it, vi } from 'vitest';
import { planSourceCycle, applySourceCycle, emptyCycleState, type CycleCommands, type CycleControl } from '../src/application/source-cycle.js';
import { sourceCyclePlugin, type CycleCapture } from '../src/adapters/source-cycle-plugins.js';
import { runUnattendedSourceCycle } from '../src/jobs/source-cycle.js';
import { SONOGONG_WITHDRAWN_PRODUCT_TYPES } from '../src/adapters/sonogong-api.js';
import { stableDigest } from '../src/shared/stable-digest.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';

// 대표 2026-10-28 «픽업구독 일단 다 내려» → 같은 날 «ㅇㅇ 손오공 구독은 연동하고 나머지는 다 내리고»: 저장 기록 raw.product_type «픽업구독»·«중고렌트» 노출 문서는 결정 하향(DECISION_WITHDRAWN).
const OBSERVED = '2026-10-28T06:00:00.000Z';
const now = Date.parse('2026-10-28T06:05:00.000Z');
const rec = (plate: string, productType: string, status = '출고가능'): SourceProductRecord => ({ sourceId: 'RP012', uid: plate, plate, vehicleText: 'x',
  status: { raw: status, saleAvailable: true }, observedAt: OBSERVED, vehicleHold: [],
  raw: { source: 'sonogong-partner-api', tab: productType === '중고렌트' ? 'rent' : productType === '오공구독' ? 'sub' : 'pick', product_type: productType },
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'KNOWN', value: 1500000 }, mileage: null, raw: {} }] });
const doc = (plate: string, productType: string, over: Partial<CycleProduct> = {}): CycleProduct => ({
  record: { ...rec(plate, productType), observedAt: '2026-10-28T00:00:00.000Z' },
  listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null, ...over });
const cfg = { sourceId: 'RP012', family: 'OTHER' as const, maxDowngradeRatio: 0.2, downgradeFloor: 3, absenceReason: 'NOT_IN_API',
  decisionWithdrawnProductTypes: SONOGONG_WITHDRAWN_PRODUCT_TYPES };
const evidence = (records: SourceProductRecord[], complete = true, observedAt = OBSERVED) => ({ records, complete, observedAt, heldCount: 0 });
const picks = Array.from({ length: 30 }, (_, i) => doc(`12가${1000 + i}`, '픽업구독'));
const subs = [doc('34나2000', '오공구독'), doc('34나2001', '오공구독')];
const rents = [doc('56다3000', '중고렌트')];
const downs = (entries: Array<{ kind: string; after: CycleProduct }>, reason: string) =>
  entries.filter(e => e.kind === 'DOWNGRADE' && e.after.publication_withdrawal?.reason === reason);

describe('손오공 중고렌트·픽업구독 결정 하향(대표 2026-10-28)', () => {
  it('완전 읽기: 노출 픽업구독·중고렌트 문서를 전부 DECISION_WITHDRAWN 으로 내린다 — 비율 가드·이월 없음, 하드 삭제 없음, 부재 하향(NOT_IN_API)과 겹치지 않음', () => {
    const plan = planSourceCycle(cfg, evidence([rec('34나2000', '오공구독'), rec('34나2001', '오공구독')]),
      { products: [...picks, ...subs, ...rents], complete: true }, now).plan;
    expect(plan.blockers).toEqual([]);
    const withdrawn = downs(plan.entries, 'DECISION_WITHDRAWN');
    expect(withdrawn).toHaveLength(31);                                                        // 노출 33 중 31 = 94% (비율 20% 가드였다면 막힘)
    expect(withdrawn.map(e => e.after.record.raw.product_type).filter(t => t === '중고렌트')).toHaveLength(1);
    expect(withdrawn.every(e => e.after.listable === false && e.after.publication_withdrawal?.deleteAuthorized === false)).toBe(true);
    expect(downs(plan.entries, 'NOT_IN_API')).toHaveLength(0);
    expect(plan.entries).toHaveLength(31);                                                      // 문서당 항목 하나(중복 하향 없음)
    expect(plan.warnings).toContain('DECISION_WITHDRAWN_TYPE:31');
    expect(plan.warnings.some(w => w.startsWith('DOWNGRADE_DEFERRED'))).toBe(false);
    expect(plan.config.decisionWithdrawnProductTypes).toEqual(['중고렌트', '픽업구독']);         // 적용 재계획(replay)이 같은 결과
  });

  it('불완전 읽기(API_SHRUNK 등): 결정 하향만 계획하고 막힘을 푼다 — 원천 값으로 쓰는 편입·갱신·부재 하향은 하나도 넣지 않는다', () => {
    const partial = [rec('34나2000', '오공구독', '계약중'), rec('78라4000', '오공구독')];       // 기존 문서 갱신 1 + 새 차 1 → 둘 다 빠져야 한다
    const plan = planSourceCycle(cfg, evidence(partial, false), { products: [...picks, ...subs, ...rents], complete: true }, now).plan;
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toContain('DECISION_ONLY:SOURCE_INCOMPLETE');
    expect(plan.entries).toHaveLength(31);
    expect(plan.entries.every(e => e.kind === 'DOWNGRADE' && e.after.publication_withdrawal?.reason === 'DECISION_WITHDRAWN')).toBe(true);
  });

  it('불완전 읽기인데 내릴 중고렌트·픽업구독이 없으면 지금처럼 SOURCE_INCOMPLETE 로 멈춘다', () => {
    const plan = planSourceCycle(cfg, evidence([rec('34나2000', '오공구독')], false), { products: subs, complete: true }, now).plan;
    expect(plan.blockers).toEqual(['SOURCE_INCOMPLETE']);
  });

  it('다른 막힘(카탈로그 불완전·낡은 읽기)이 함께 있으면 결정 하향도 하지 않는다', () => {
    const catalog = planSourceCycle(cfg, evidence([], false), { products: picks, complete: false }, now).plan;
    expect(catalog.blockers).toEqual(expect.arrayContaining(['CATALOG_INCOMPLETE', 'SOURCE_INCOMPLETE']));
    const stale = planSourceCycle(cfg, evidence([], false, '2026-10-27T00:00:00.000Z'), { products: picks, complete: true }, now).plan;
    expect(stale.blockers).toEqual(expect.arrayContaining(['SOURCE_STALE']));
    expect(stale.entries.filter(e => e.after.publication_withdrawal?.reason === 'DECISION_WITHDRAWN')).toHaveLength(0);
  });

  it('계약 잠금 픽업구독은 기존 규칙대로 보호(건수만 경고), 엔진이 쓴 «계약중» 표시(잠금 아님)는 내린다', () => {
    const locked = doc('12가9000', '픽업구독', { locked_by_contract: true });
    const shown = doc('12가9001', '픽업구독', { record: { ...rec('12가9001', '픽업구독', '계약중'), observedAt: '2026-10-28T00:00:00.000Z' } });
    const plan = planSourceCycle(cfg, evidence([], false), { products: [locked, shown], complete: true }, now).plan;
    expect(plan.entries.map(e => e.after.record.uid)).toEqual(['12가9001']);
    expect(plan.warnings).toContain('DECISION_WITHDRAWN_KEPT_LOCKED:1');
  });

  it('픽업구독 원천 행은 편입·재노출하지 않고, 이미 내린 문서는 다시 계획하지 않는다(멱등)', () => {
    const withdrawn = doc('12가1000', '픽업구독', { listable: false,
      publication_withdrawal: { reason: 'DECISION_WITHDRAWN', source: 'RP012', observedAt: OBSERVED, deleteAuthorized: false } });
    const plan = planSourceCycle(cfg, evidence([rec('12가1000', '픽업구독'), rec('12가5555', '픽업구독'), rec('34나2000', '오공구독')]),
      { products: [withdrawn, subs[0]!], complete: true }, now).plan;
    expect(plan.entries).toEqual([]);
    expect(plan.warnings).toContain('DECISION_TYPE_SOURCE_SKIPPED:2');
  });

  it('픽업구독이던 차가 이번 원천에 오공구독으로 나오면 결정 하향하지 않고 보통 경로가 갱신한다', () => {
    const plan = planSourceCycle(cfg, evidence([rec('12가1000', '오공구독'), rec('56다3000', '오공구독'), ...subs.map(s => s.record)]),
      { products: [picks[0]!, ...subs, ...rents], complete: true }, now).plan;
    // 중고렌트로 노출돼 있던 차가 구독 탭에도 있으면(예전엔 rent 우선 채택) 이제 오공구독으로 갱신되고 내려가지 않는다
    expect(plan.entries.find(e => e.after.record.uid === '56다3000')).toMatchObject({ kind: 'UPDATE', after: { listable: true, record: { raw: { product_type: '오공구독' } } } });
    const entry = plan.entries.find(e => e.after.record.uid === '12가1000')!;
    expect(entry.kind).toBe('UPDATE');
    expect(entry.after.listable).toBe(true);
    expect(entry.after.record.raw.product_type).toBe('오공구독');
    expect(downs(plan.entries, 'DECISION_WITHDRAWN')).toHaveLength(0);
  });

  it('비율 가드 기준에서 결정 구분을 뺀다: 남은 오공구독 2건 중 1건 부재는 픽업구독·중고렌트 31건이 있어도 가드에 걸린다', () => {
    const { downgradeFloor: _f, ...ratioOnly } = cfg;                                         // 절대 하한 없이 비율만(옛 합산 비율)
    const plan = planSourceCycle(ratioOnly, evidence([rec('34나2000', '오공구독')]), { products: [...picks, ...subs, ...rents], complete: true }, now).plan;
    expect(plan.blockers).toContain('DOWNGRADE_RATIO_EXCEEDED');                               // 1/2 > 0.2 (기준이 33 이었다면 1/33 으로 통과)
  });

  it('Codex P1: 픽업 264 + 비픽업 9, 완전 읽기에 신규 8대만 있으면 비픽업 부재 하향은 비픽업 기준 허용분(3)까지만', () => {
    const many = Array.from({ length: 264 }, (_, i) => doc(`12가${2000 + i}`, '픽업구독'));
    const nine = Array.from({ length: 9 }, (_, i) => doc(`34나${3000 + i}`, '오공구독'));
    const fresh = Array.from({ length: 8 }, (_, i) => rec(`56다${4000 + i}`, '오공구독'));
    const plan = planSourceCycle(cfg, evidence(fresh), { products: [...many, ...nine], complete: true }, now).plan;
    expect(downs(plan.entries, 'DECISION_WITHDRAWN')).toHaveLength(264);
    expect(downs(plan.entries, 'NOT_IN_API')).toHaveLength(3);                                  // max(floor 3, floor(9×0.2)=1)
    expect(plan.warnings).toContain('DOWNGRADE_DEFERRED:6');
  });

  it('Codex P2: 구분이 없거나 검증에 실패한 행은 픽업구독 문서를 결정 하향에서 빼 주지 않는다', () => {
    const noType = { ...rec('12가1000', '오공구독'), raw: { source: 'sonogong-partner-api', tab: 'sub' } };
    const badObs = { ...rec('12가1001', '오공구독'), observedAt: 'not-a-time' };
    const plan = planSourceCycle(cfg, evidence([noType, badObs], false), { products: [picks[0]!, picks[1]!], complete: true }, now).plan;
    expect(downs(plan.entries, 'DECISION_WITHDRAWN').map(e => e.after.record.uid).sort()).toEqual(['12가1000', '12가1001']);
  });

  it('Codex P2: 불완전 읽기 + 규격 드리프트가 함께면 결정 하향 예외를 쓰지 않는다', () => {
    const broken = Array.from({ length: 6 }, (_, i) => ({ ...rec(`78라${5000 + i}`, '중고렌트'), raw: { source: 'sonogong-partner-api', tab: 'rent', product_type: '중고렌트', spec: { year: 'abcd' } } }));
    const plan = planSourceCycle({ ...cfg, specValidation: true }, evidence(broken, false), { products: picks, complete: true }, now).plan;
    expect(plan.warnings).toContain('SPEC_VIOLATION:year:6');
    expect(plan.blockers).toEqual(expect.arrayContaining(['SOURCE_INCOMPLETE', 'SPEC_FORMAT_DRIFT']));
    expect(plan.warnings).not.toContain('DECISION_ONLY:SOURCE_INCOMPLETE');
    expect(plan.entries.length).toBeGreaterThan(0);                                            // 계획은 보이지만 막힘 때문에 적용되지 않는다
  });

  it('결정 구분이 없는 원천(설정 없음)은 지금과 같다', () => {
    const { decisionWithdrawnProductTypes: _off, ...plain } = cfg;
    const plan = planSourceCycle(plain, evidence([], false), { products: picks, complete: true }, now).plan;
    expect(plan.blockers).toEqual(['SOURCE_INCOMPLETE']);
    expect(plan.config).not.toHaveProperty('decisionWithdrawnProductTypes');
  });
});

describe('무인 회차: 읽기가 불완전해도 중고렌트·픽업구독 하향은 적용된다', () => {
  function memory(initial: CycleProduct[]) {
    const data = new Map(initial.map(p => [p.record.uid, structuredClone(p)]));
    const backups = new Map<string, CycleProduct | null>();
    const commands: CycleCommands = {
      async list() { return { complete: true, products: structuredClone([...data.values()]) }; },
      async read(_s, uid) { return structuredClone(data.get(uid) ?? null); },
      async backup(key, value) { backups.set(key, structuredClone(value)); },
      async readBackup(key) { return structuredClone(backups.get(key) ?? null); },
      async compareAndApply(digest, after) {
        if (stableDigest(data.get(after.record.uid) ?? null) !== digest) throw Error('CAS_CONFLICT');
        data.set(after.record.uid, structuredClone(after));
      },
    };
    return { commands, data };
  }
  function control() {
    let state = emptyCycleState();
    const alerts: string[] = [];
    const ctrl: CycleControl = { async acquire() { return async () => {}; }, async load() { return structuredClone(state); },
      async save(_id, s) { state = structuredClone(s); }, heartbeat: vi.fn(async () => {}), async alert(_id, r) { alerts.push(r); } };
    return { ctrl, alerts, state: () => state };
  }
  const shrunk: CycleCapture = { observedAt: OBSERVED, complete: false, completedScopes: [], visibilityComplete: true, heldCount: 0,
    incompleteReason: 'API_SHRUNK', rows: [{ scope: 'api', record: rec('34나2000', '오공구독') }] };
  const apiPlugin = () => {
    const p = sourceCyclePlugin({ sourceId: 'RP012', kind: 'SONOGONG', scopes: ['api'], maxDowngradeRatio: 0.2 }, async () => structuredClone(shrunk), () => OBSERVED);
    p.absenceReason = 'NOT_IN_API'; p.downgradeFloor = 3; p.decisionWithdrawnProductTypes = SONOGONG_WITHDRAWN_PRODUCT_TYPES;
    return p;
  };

  it('픽업구독 30건·중고렌트 1건만 쓰고(되읽기 검증), 오공구독 문서는 그대로, 회차는 불완전 읽기로 실패를 센다', async () => {
    const m = memory([...picks, ...subs, ...rents]), c = control();
    const result = await runUnattendedSourceCycle(apiPlugin(), m.commands, c.ctrl, { now: () => now });
    expect(result.stage).toBe('APPLY');
    expect(result.writes).toBe(31);
    expect(result.verified).toBe(31);
    expect(result.status).toBe('HOLD');                                                        // SOURCE_INCOMPLETE: 원천 회복 전까지 실패로 남는다
    expect(c.state().error).toBe('SOURCE_INCOMPLETE');
    const after = [...m.data.values()];
    expect(after.filter(p => ['픽업구독', '중고렌트'].includes(String(p.record.raw.product_type)) && p.listable)).toHaveLength(0);
    expect(after.filter(p => p.publication_withdrawal?.reason === 'DECISION_WITHDRAWN')).toHaveLength(31);
    for (const s of subs) expect(m.data.get(s.record.uid)).toEqual(s);                         // 원천 값으로 쓰는 항목 없음
    expect(m.data.size).toBe(33);                                                              // 삭제 없음
    // 다음 회차: 더 내릴 것이 없어 지금처럼 SOURCE_INCOMPLETE 로 멈추고 쓰기 0
    const again = await runUnattendedSourceCycle(apiPlugin(), m.commands, c.ctrl, { now: () => now });
    expect(again.writes).toBe(0);
  });

  it('승인 계획 재적용(apply)도 같은 계획을 다시 만든다(재계획 불일치 없음)', async () => {
    const m = memory([...picks.slice(0, 3), ...subs, ...rents]);
    const built = planSourceCycle(cfg, evidence([rec('34나2000', '오공구독')], false), await m.commands.list('RP012'), now);
    const applied = await applySourceCycle(m.commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now });
    expect(applied).toMatchObject({ status: 'APPLIED', writes: 4, verified: 4 });
  });
});
