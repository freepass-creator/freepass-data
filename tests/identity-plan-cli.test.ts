import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIdentitySnapshot, runIdentityPlanCli } from '../src/jobs/build-identity-promotion-plan.js';

const snapshot = {
  label: 'synthetic',
  products: [{ id: 'p1', plate4: '2282', maker: '현대', model: '아이오닉5', sub_model: '아이오닉5', trim_name: '', rawName: '아이오닉5 프레스티지', year: '2022', listable: false }],
  masters: [{ id: 'm1', maker: '현대', model: '아이오닉 5', model_aliases: ['아이오닉5'], sub_model: '아이오닉 5 NE', sub_model_aliases: ['아이오닉5'],
    yearFrom: null, yearTo: null, trims: [{ name: '프레스티지', aliases: [] }] }],
};

describe('정체성 승격 계획서 CLI', () => {
  it('reads a snapshot file and writes the plan and held report (no network, no writes beyond the output files)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idplan-'));
    try {
      await writeFile(join(dir, 'in.json'), JSON.stringify(snapshot));
      const result = await runIdentityPlanCli({ input: join(dir, 'in.json'), out: join(dir, 'plan.json'), held: join(dir, 'held.json') });
      expect(result.stats).toMatchObject({ products: 1, identityRepairs: 1, trimRepairs: 1, held: 0 });
      const plan = JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8'));
      expect(plan.productIdentityRepairs[0].to).toEqual({ maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE' });
      expect(plan.productTrimRepairs).toBeUndefined();
      const trimPlan = JSON.parse(await readFile(join(dir, 'plan.trim.json'), 'utf8'));   // 정체성 적용 뒤에 쓰는 두 번째 계획
      expect(trimPlan.productTrimRepairs[0]).toMatchObject({ id: 'p1', to: '프레스티지' });
      expect(JSON.parse(await readFile(join(dir, 'held.json'), 'utf8')).held).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects malformed input and unmasked plate numbers instead of building a partial plan', () => {
    expect(() => parseIdentitySnapshot({})).toThrow('IDENTITY_SNAPSHOT_INVALID');
    expect(() => parseIdentitySnapshot({ products: [{ id: '' }], masters: [] })).toThrow('IDENTITY_PRODUCT_INVALID');
    expect(() => parseIdentitySnapshot({ products: [{ id: 'x', plate4: '12가3456' }], masters: [] })).toThrow('IDENTITY_PRODUCT_PLATE_NOT_MASKED');
    expect(() => parseIdentitySnapshot({ products: [], masters: [{ id: 'm', sub_model: '' }] })).toThrow('IDENTITY_MASTER_INVALID');
    expect(() => parseIdentitySnapshot({ products: [], masters: [{ id: 'm', sub_model: 'x', trims: [{ name: 't', aliases: [1] }] }] })).toThrow('IDENTITY_MASTER_TRIM_INVALID');
  });

  it('requires both --input and --out', async () => {
    await expect(runIdentityPlanCli({})).rejects.toThrow('IDENTITY_PLAN_ARGS_REQUIRED');
  });
});
