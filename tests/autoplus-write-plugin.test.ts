import { describe, expect, it } from 'vitest';
import { autoplusHomepageWritePlugin } from '../src/runtime/source-cycle-runtime.js';

const record = (plate: string) => ({ sourceId: 'RP023', uid: plate, plate, vehicleText: 'x', status: { raw: '게시', saleAvailable: true },
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'UNKNOWN', value: null }, mileage: '20000km/year', raw: {} }],
  observedAt: '2026-10-14T00:00:00.000Z', raw: { product_group: 'LONG_TERM' }, vehicleHold: [] });
const base = { observedAt: '2026-10-14T00:00:00.000Z', productCount: 2, failures: [], held: [], duplicatePlates: [], excluded: [] };

describe('오토플러스 홈피 쓰기 플러그인', () => {
  it('passes complete homepage records to the engine as sellable (게시 = 출고가능)', async () => {
    const plugin = autoplusHomepageWritePlugin(0.5, async () => ({ ...base, complete: true, records: [record('12가1001'), record('12가1002')] }) as never);
    const read = await plugin.read();
    expect(read.complete).toBe(true);
    expect(plugin.sourceId).toBe('RP023');
    expect(plugin.toRecords(read).records.map(r => r.status.saleAvailable)).toEqual([true, true]);
  });
  it('marks incomplete homepage reads incomplete so absence is never inferred', async () => {
    const plugin = autoplusHomepageWritePlugin(0.5, async () => ({ ...base, complete: false, failures: [{ productId: 'C1', code: 'X' }],
      records: [record('12가1001')] }) as never);
    expect((await plugin.read()).complete).toBe(false);
  });
});
