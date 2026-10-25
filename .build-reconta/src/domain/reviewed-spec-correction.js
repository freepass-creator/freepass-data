import { sharedSheetFactNumber, sharedSheetFactYear, sharedSheetFactRegistration } from './shared-sheet-fact-parsing.js';
import { stableDigest } from '../shared/stable-digest.js';
import { SPEC_FORMAT_RULES } from './source-spec-validation.js';
import { canonicalFuel } from './fuel-alias.js';
import { specValueBlank, refillableSpecValues } from './spec-refill.js';
const object = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
/** Reviewed archive bindings are explicit operational input, never inferred from a vehicle name. Default off. */
export function reviewedSpecApprovals(input) {
    if (!input)
        return new Map();
    const rows = JSON.parse(input);
    if (!Array.isArray(rows) || rows.length > 100)
        throw new Error('REVIEWED_SPEC_APPROVAL_INVALID');
    const out = new Map();
    for (const row of rows) {
        const r = object(row);
        if (typeof r.uid !== 'string' || !/^\d{2,3}[가-힣]\d{4}$/.test(r.uid) || typeof r.sourceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.sourceId) ||
            typeof r.correctionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(r.correctionDigest) || out.has(r.uid) || !Array.isArray(r.fields) || !r.fields.length || r.fields.length > 4 || new Set(r.fields).size !== r.fields.length || r.fields.some(k => !['year', 'first_registration_date', 'fuel_type', 'engine_cc'].includes(String(k))))
            throw new Error('REVIEWED_SPEC_APPROVAL_INVALID');
        out.set(r.uid, r);
    }
    return out;
}
/** Consume only an exact reviewed correction that is still retained verbatim in its existing history. */
export function reviewedSpecOf(uid, f, approval) {
    if (!approval || approval.uid !== uid || approval.sourceId !== f.provider_company_code || f.car_number !== uid)
        return;
    const correction = object(f.원문_정정), history = f.원문_정정_이력;
    if (stableDigest(correction) !== approval.correctionDigest || correction.출처 !== '지지오토 사양조회' ||
        typeof correction.key !== 'string' || !correction.key || typeof correction.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(correction.sourceDigest) ||
        typeof correction.조회일 !== 'string' || !Number.isFinite(Date.parse(correction.조회일)) ||
        !Array.isArray(history) || !history.some(v => stableDigest(v) === approval.correctionDigest))
        return;
    const values = {};
    for (const [field, source] of [['year', '연식'], ['first_registration_date', '최초등록'], ['fuel_type', '연료'], ['engine_cc', '배기량']]) {
        if (!approval.fields.includes(field) || !specValueBlank(f[field]) || typeof correction[source] !== 'string')
            continue;
        const raw = String(correction[source]).trim(), value = field === 'fuel_type' ? canonicalFuel(raw, correction.차명) : raw;
        if (value && SPEC_FORMAT_RULES[field]?.(value))
            values[field] = value;
    }
    if (['전기', '수소'].includes(String(f.fuel_type || values.fuel_type || '')))
        delete values.engine_cc;
    return Object.keys(values).length ? { correctionDigest: approval.correctionDigest, values } : undefined;
}
/** Compare independent facts against the original current RAW cells, before spec/master gates can omit them. */
export function plannedReviewedSpec(value, sourceRaw, vehicleText) {
    if (!value)
        return;
    const raw = object(sourceRaw), values = { ...value.values };
    if (raw.source !== 'shared-sheet' || !Array.isArray(raw.headers) || !Array.isArray(raw.cells))
        return;
    const headers = raw.headers, cells = raw.cells;
    const labels = { year: '연식', first_registration_date: '최초등록일', fuel_type: '연료', engine_cc: '배기량' };
    let sourceFuel = null;
    for (const [field, label] of Object.entries(labels)) {
        const indexes = headers.flatMap((h, i) => h === label ? [i] : []);
        if (indexes.length !== 1) {
            delete values[field];
            continue;
        }
        const cell = cells[indexes[0]], text = String(cell ?? '').trim();
        const parsed = field === 'year' ? sharedSheetFactYear(text)
            : field === 'first_registration_date' ? sharedSheetFactRegistration(text, cell)
                : field === 'fuel_type' ? canonicalFuel(text) : sharedSheetFactNumber(text, 'cc');
        if (field === 'fuel_type')
            sourceFuel = typeof parsed === 'string' ? parsed : null;
        if (parsed === null || !values[field])
            continue;
        const known = String(parsed);
        if (!SPEC_FORMAT_RULES[field]?.(known))
            continue;
        // Month-only archived registration and an exact day in that month do not contradict one another.
        const same = field === 'first_registration_date'
            ? known === values[field] || (known.length === 7 || values[field].length === 7) && known.slice(0, 7) === values[field].slice(0, 7)
            : known === values[field];
        if (!same)
            delete values[field];
    }
    if (sourceFuel === '전기' || sourceFuel === '수소')
        delete values.engine_cc;
    const eligible = Object.fromEntries(Object.entries(refillableSpecValues(values, Object.keys(values), vehicleText)).filter((entry) => typeof entry[1] === 'string'));
    return Object.keys(eligible).length ? { correctionDigest: value.correctionDigest, values: eligible } : undefined;
}
