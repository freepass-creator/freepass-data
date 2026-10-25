import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMakerRenamePlans, MAKER_PLAN_CHUNK } from '../src/application/maker-rename-plan.js';
import { runMakerRenamePlanCli } from '../src/jobs/build-maker-rename-plan.js';
import { validateVehicleNameRepairPlan } from '../src/infra/vehicle-name-reference-repair-firestore.js';
const rename = { 르노코리아: '르노', KG모빌리티: 'KGM' };
const base = () => ({
    rename,
    masters: [
        { id: 'm1', maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL', title: '르노코리아 아르카나 LJL' },
        { id: 'm2', maker: 'KG모빌리티', model: '토레스', sub_model: '더 뉴 토레스 J116' },
        { id: 'm3', maker: '현대', model: '그랜저', sub_model: '그랜저 GN7' },
    ],
    trims: [
        { id: 't1', maker: '르노코리아', master_id: 'm1' }, { id: 't2', maker: '르노코리아', master_id: 'm1' },
        { id: 't3', maker: 'KG모빌리티', master_id: 'm2' }, { id: 't4', maker: '현대', master_id: 'm3' },
    ],
    products: [
        { id: 'p1', maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL' },
        { id: 'p2', maker: 'KG모빌리티', model: '토레스', sub_model: '더 뉴 토레스 J116' },
        { id: 'p3', maker: '르노코리아', model: '모르는차', sub_model: '모르는 세부모델' },
        { id: 'p4', maker: '현대', model: '그랜저', sub_model: '그랜저 GN7' },
    ],
});
describe('제조사명 정정 계획 생성(읽기 전용)', () => {
    it('마스터·행·표시명을 한 계획에 통째로, 상품은 마스터 정체성에 정확히 하나로 맞을 때만 별도 계획에', () => {
        const r = buildMakerRenamePlans(base());
        expect(r.masterPlans).toHaveLength(1);
        const plan = r.masterPlans[0];
        expect(plan.masterMakerRepairs).toEqual([{ id: 'm1', from: '르노코리아', to: '르노' }, { id: 'm2', from: 'KG모빌리티', to: 'KGM' }]);
        expect(plan.trimMakerRepairs).toHaveLength(3);
        expect(plan.masterTitleRepairs).toEqual([{ id: 'm1', from: '르노코리아 아르카나 LJL', to: '르노 아르카나 LJL' }]);
        expect(r.productPlans).toHaveLength(1);
        expect(r.productPlans[0].productMakerRepairs).toEqual([{ id: 'p1', from: '르노코리아', to: '르노' }, { id: 'p2', from: 'KG모빌리티', to: 'KGM' }]);
        expect(r.summary).toMatchObject({ masters: 2, trims: 3, titles: 1, products: 2, skipped: { PRODUCT_NO_ACTIVE_MASTER: 1 } });
        // 정정기 검증기를 그대로 통과(대상 수·정규화·중복 검사).
        for (const p of [...r.masterPlans, ...r.productPlans])
            expect(() => validateVehicleNameRepairPlan(p)).not.toThrow();
    });
    it('행 제조사가 마스터와 다르면 그 마스터는 건드리지 않고, 그 마스터의 상품도 담지 않는다', () => {
        const input = base();
        input.trims[1] = { id: 't2', maker: '르노', master_id: 'm1' }; // 이미 새 표기가 섞임
        const r = buildMakerRenamePlans(input);
        expect(r.masterPlans[0].masterMakerRepairs.map(x => x.id)).toEqual(['m2']);
        expect(r.summary.skipped).toMatchObject({ TRIM_ROW_MAKER_DIFFERS: 1, PRODUCT_NO_ACTIVE_MASTER: 2 });
        expect(r.productPlans[0].productMakerRepairs.map(x => x.id)).toEqual(['p2']);
    });
    it('비표준 표시명 마스터는 건너뛰고(그 마스터·상품 제외), 빈 표시명은 표시명 정정 없이 진행', () => {
        const input = base();
        input.masters[0] = { ...input.masters[0], title: '르노 아르카나(구형 표기)' };
        const r = buildMakerRenamePlans(input);
        expect(r.masterPlans[0].masterMakerRepairs.map(x => x.id)).toEqual(['m2']);
        expect(r.summary.skipped.TITLE_NOT_STANDARD).toBe(1);
        expect(r.masterPlans[0].masterTitleRepairs).toBeUndefined();
    });
    it('이미 새 표기와 같은 마스터가 있으면(값 하나) 상품은 모호로 건너뛴다', () => {
        const input = base();
        input.masters.push({ id: 'm9', maker: '르노', model: '아르카나', sub_model: '아르카나 LJL' });
        const r = buildMakerRenamePlans(input);
        expect(r.summary.skipped.PRODUCT_IDENTITY_AMBIGUOUS).toBe(1);
    });
    it('큰 목록은 마스터 단위로 쪼개고 각 계획은 상한 이하, 퇴역 마스터는 건너뜀', () => {
        const masters = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, maker: '르노코리아', model: `모델${i}`, sub_model: `모델${i} A1` }));
        const trims = masters.flatMap(m => [{ id: `${m.id}-a`, maker: '르노코리아', master_id: m.id }, { id: `${m.id}-b`, maker: '르노코리아', master_id: m.id }]);
        masters.push({ id: 'old', maker: '르노코리아', model: '옛', sub_model: '옛 X', retired: true });
        const r = buildMakerRenamePlans({ rename, masters, trims, products: [] });
        expect(r.masterPlans.length).toBeGreaterThan(1);
        expect(r.summary.planSizes.every(n => n <= MAKER_PLAN_CHUNK)).toBe(true);
        expect(r.summary.masters).toBe(120);
        expect(r.summary.skipped.RETIRED_MASTER).toBe(1);
    });
    it('매핑이 연쇄이거나 무변화이면 거부', () => {
        expect(() => buildMakerRenamePlans({ ...base(), rename: { A: 'B', B: 'C' } })).toThrow('MAKER_RENAME_CHAIN');
        expect(() => buildMakerRenamePlans({ ...base(), rename: { A: 'A' } })).toThrow('MAKER_RENAME_MAPPING_INVALID');
    });
    it('CLI: 계획서 파일만 쓰고 요약을 낸다', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'maker-'));
        const input = join(dir, 'snap.json'), outDir = join(dir, 'plans');
        await writeFile(input, JSON.stringify(base()));
        const s = await runMakerRenamePlanCli({ input, outDir });
        expect(s).toMatchObject({ status: 'MAKER_RENAME_PLAN', writes: 0, masters: 2, products: 2 });
        expect(s.files).toEqual(['maker-rename-masters-1.json', 'maker-rename-products-1.json']);
        expect(JSON.parse(await readFile(join(outDir, s.files[0]), 'utf8')).masterMakerRepairs).toHaveLength(2);
        await expect(runMakerRenamePlanCli({ input })).rejects.toThrow('MAKER_PLAN_ARGS_REQUIRED');
    });
});
