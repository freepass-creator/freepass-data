import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewedSpecApprovals, reviewedSpecOf, plannedReviewedSpec } from '../src/domain/reviewed-spec-correction.js';
import { stableDigest } from '../src/shared/stable-digest.js';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';
const uid = '12가1001', source = 'RP018', time = '2026-10-19T10:00:00.000Z';
const correction = { 차명: '합성 가솔린', 연식: '2025', 최초등록: '2024-12', 연료: '가솔린', 배기량: '2497', 출처: '지지오토 사양조회', 조회일: '2026-10-18T02:10:40', key: 'archive-key', sourceDigest: 'a'.repeat(64), 기록시각: time };
const approval = { uid, sourceId: source, correctionDigest: stableDigest(correction), fields: ['year', 'first_registration_date', 'fuel_type', 'engine_cc'] };
const fields = () => ({ car_number: uid, provider_company_code: source, 원문_정정: structuredClone(correction), 원문_정정_이력: [structuredClone(correction)] });
const record = () => ({ sourceId: source, uid, plate: uid, vehicleText: '합성 가솔린', status: { raw: '출고가능', saleAvailable: true }, observedAt: time, vehicleHold: [], raw: { source: 'shared-sheet', headers: ['연식', '최초등록일', '연료', '배기량'], cells: ['', '', '', ''] }, terms: [{ months: 24, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'UNKNOWN', value: null }, mileage: null, raw: {} }] });
it('requires exact reviewed UID/supplier/digest/history and explicit physical field scope', () => {
    expect(reviewedSpecApprovals(undefined).size).toBe(0);
    expect(reviewedSpecApprovals(JSON.stringify([approval])).get(uid)).toEqual(approval);
    expect(() => reviewedSpecApprovals(JSON.stringify([{ ...approval, fields: ['maker'] }]))).toThrow();
    for (const f of [{ ...fields(), car_number: '12가1002' }, { ...fields(), provider_company_code: 'RP013' }, { ...fields(), 원문_정정_이력: [] }, { ...fields(), 원문_정정: { ...correction, 연식: '2026' } }])
        expect(reviewedSpecOf(uid, f, approval)).toBeUndefined();
    expect(reviewedSpecOf(uid, fields(), undefined)).toBeUndefined();
    expect(reviewedSpecOf(uid, fields(), { ...approval, fields: ['year'] })?.values).toEqual({ year: '2025' });
});
it('preserves existing values and rejects conflicting source year without inferring model year from registration', () => {
    const f = { ...fields(), year: '2026', fuel_type: '디젤', engine_cc: '1998' };
    expect(reviewedSpecOf(uid, f, approval)?.values).toEqual({ first_registration_date: '2024-12' });
    const selected = reviewedSpecOf(uid, fields(), approval);
    expect(plannedReviewedSpec(selected, { source: 'shared-sheet', headers: ['연식', '최초등록일', '연료', '배기량'], cells: ['2024', '', '', ''] })?.values.year).toBeUndefined();
    const absent = { ...correction, 연식: null }, a = { ...approval, correctionDigest: stableDigest(absent) };
    expect(reviewedSpecOf(uid, { ...fields(), 원문_정정: absent, 원문_정정_이력: [absent] }, a)?.values.year).toBeUndefined();
});
const dirs = [];
afterEach(async () => { for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true }); });
async function setup(override = {}, enabled = true) {
    const dir = await mkdtemp(join(tmpdir(), 'reviewed-spec-'));
    dirs.push(dir);
    let version = 1;
    const path = `projects/synthetic-test/databases/(default)/documents/products/${uid}`;
    const initial = { ...nativeCycleFields({ record: record(), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null }), ...fields(), provider_name: '합성', 원문: { 차명: '원본 보존' }, maker: '기존 제조사', model: '기존 모델', sub_model: '기존 세부모델', trim_name: '기존 트림', vehicle_spec_source_checked: true, vehicle_int_color_source_checked: true, ...override };
    let stored = { name: path, updateTime: String(version), fields: encodeFields(initial) };
    const fetcher = (async (input, init = {}) => {
        const url = new URL(String(input));
        if (!init.method || init.method === 'GET') {
            if (url.pathname.endsWith('/products')) {
                const masks = url.searchParams.getAll('mask.fieldPaths').map(k => k.replaceAll('`', ''));
                return Response.json({ documents: [{ ...stored, fields: Object.fromEntries(Object.entries(stored.fields).filter(([k]) => masks.includes(k))) }] });
            }
            return Response.json(stored);
        }
        if (url.searchParams.get('currentDocument.updateTime') !== stored.updateTime)
            return new Response('{}', { status: 412 });
        stored = { ...stored, updateTime: String(++version), fields: { ...stored.fields, ...JSON.parse(String(init.body)).fields } };
        return Response.json(stored);
    });
    const commands = firestoreCycleCommands({ env: { FIREBASE_PROJECT_ID: 'synthetic-test', ...(enabled ? { SOURCE_CYCLE_REVIEWED_SPEC_CORRECTIONS: JSON.stringify([approval]) } : {}) }, directory: dir, fetcher, token: async () => 'fixture' });
    const plan = () => commands.list(source).then(snapshot => planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records: [record()], complete: true, heldCount: 0, observedAt: time }, snapshot, Date.parse(time)));
    return { commands, plan, initial, current: () => decodeFields(stored.fields), mutate: () => { stored = { ...stored, updateTime: String(++version), fields: encodeFields({ ...decodeFields(stored.fields), 원문_정정: { ...correction, 연식: '2026' } }) }; } };
}
it('uses the existing masked read, plan, backup, CAS and readback; fills once and preserves all other fields', async () => {
    const s = await setup(), built = await s.plan();
    expect(built.plan.entries).toHaveLength(1);
    expect(built.plan.entries[0]?.after.fillSourceIdentity).toBe(true);
    const applied = await applySourceCycle(s.commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now: Date.parse(time) });
    expect(applied).toMatchObject({ status: 'APPLIED', verified: 1 });
    expect(s.current()).toMatchObject({ year: '2025', fuel_type: '가솔린', engine_cc: '2497', first_registration_date: '2024-12', 원문_정정: correction, 원문_정정_이력: [correction], price: s.initial.price });
    for (const [key, value] of Object.entries(s.initial))
        expect(s.current()[key]).toEqual(value);
    expect((await s.plan()).plan.entries).toHaveLength(0);
});
it('default-off, contract lock and withdrawal cannot select a correction write', async () => {
    for (const [over, on] of [[{}, false], [{ locked_by_contract: 'LEDGER' }, true], [{ publication_withdrawal: { reason: 'MANUAL' } }, true]]) {
        const s = await setup(over, on);
        const b = await s.plan();
        expect(b.plan.entries.filter(x => x.after.reviewedSpec)).toHaveLength(0);
    }
});
it('a correction changed after planning cannot be applied using the old digest', async () => {
    const s = await setup(), built = await s.plan();
    s.mutate();
    await expect(applySourceCycle(s.commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now: Date.parse(time) })).rejects.toThrow('CYCLE_REPLAN_REQUIRED');
    expect(s.current().year).toBeUndefined();
});
it('checks original RAW conflicts even when the master-gated spec map is missing', () => {
    const selected = reviewedSpecOf(uid, fields(), approval);
    const raw = (cells) => ({ source: 'shared-sheet', headers: ['연식', '최초등록일', '연료', '배기량'], cells });
    expect(plannedReviewedSpec(selected, raw(['2024', '', '', '']))?.values.year).toBeUndefined();
    expect(plannedReviewedSpec({ ...selected, values: { ...selected.values, fuel_type: '디젤' } }, raw(['', '', '가솔린', '']))?.values.fuel_type).toBeUndefined();
    expect(plannedReviewedSpec({ ...selected, values: { ...selected.values, engine_cc: '1999' } }, raw(['', '', '', '3000']))?.values.engine_cc).toBeUndefined();
    expect(plannedReviewedSpec(selected, raw(['2025', 'https://drive.google.com/folder', '휘발유', '2,497cc']))?.values).toEqual(selected.values);
    expect(plannedReviewedSpec(selected, { ...raw(['', '', '', '']), headers: ['연식', '최초등록일', '연료', '연식'] })?.values.year).toBeUndefined();
    expect(plannedReviewedSpec(selected, { source: 'shared-sheet', spec: { year: '2025' } })).toBeUndefined();
});
