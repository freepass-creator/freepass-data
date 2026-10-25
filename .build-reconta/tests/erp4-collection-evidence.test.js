import { describe, expect, it } from 'vitest';
import { collectionSuccessAt, latestCollectionSuccess, ERP4_COLLECTION_STEP } from '../src/application/erp4-collection-evidence.js';
const step = (name, conclusion, completed_at) => ({ name, conclusion, completed_at });
const jobs = (...steps) => ({ jobs: [{ steps }] });
describe('ERP4 수집 단계 성공 시각 (발행 단계 실패와 무관하게 쓰기 끝남을 판정)', () => {
    it('uses the write step only when it succeeded; publication failure does not matter; skipped (IANCAR_ONLY) is ignored', () => {
        expect(collectionSuccessAt(jobs(step(ERP4_COLLECTION_STEP, 'success', '2026-10-13T19:14:40Z'), step('ERP5 발행 스냅샷 고정', 'failure', '2026-10-13T19:20:00Z'))))
            .toBe('2026-10-13T19:14:40.000Z');
        expect(collectionSuccessAt(jobs(step(ERP4_COLLECTION_STEP, 'failure', '2026-10-13T19:14:40Z')))).toBeNull();
        expect(collectionSuccessAt(jobs(step(ERP4_COLLECTION_STEP, 'skipped', null)))).toBeNull();
        expect(collectionSuccessAt({})).toBeNull();
    });
    it('walks completed runs newest first and returns the first success; incomplete runs and future times are ignored', async () => {
        const byRun = {
            3: jobs(step(ERP4_COLLECTION_STEP, 'skipped', null)),
            2: jobs(step(ERP4_COLLECTION_STEP, 'success', '2026-10-13T17:44:00Z')),
            1: jobs(step(ERP4_COLLECTION_STEP, 'success', '2026-10-13T14:35:00Z')),
        };
        const asked = [];
        const at = await latestCollectionSuccess({
            runs: async () => [{ id: 1, created_at: '2026-10-13T14:30:00Z', status: 'completed' }, { id: 4, created_at: '2026-10-13T19:00:00Z', status: 'in_progress' },
                { id: 3, created_at: '2026-10-13T18:30:00Z', status: 'completed' }, { id: 2, created_at: '2026-10-13T17:40:00Z', status: 'completed' }],
            jobs: async (id) => { asked.push(id); return byRun[id]; }, now: () => Date.parse('2026-10-13T20:00:00Z')
        });
        expect(at).toBe('2026-10-13T17:44:00.000Z');
        expect(asked).toEqual([3, 2]);
        expect(await latestCollectionSuccess({ runs: async () => [{ id: 9, created_at: '2026-10-13T19:00:00Z', status: 'completed' }],
            jobs: async () => jobs(step(ERP4_COLLECTION_STEP, 'success', '2026-10-14T05:00:00Z')), now: () => Date.parse('2026-10-13T20:00:00Z') })).toBeNull();
    });
});
