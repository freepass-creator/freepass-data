import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { plateIdentityKey, isAssignedPlate } from '../domain/vehicle-plate.js';
import { stableDigest } from '../shared/stable-digest.js';
/** Supplements match one row by «공급사 코드 + 차량번호» — the same identity as the row itself, never the plate alone. */
function supplementByPlate(items, unique, fail) {
    const out = new Map();
    if (items === undefined)
        return out;
    if (!Array.isArray(items))
        fail();
    for (const item of items) {
        if (!item || typeof item !== 'object' || !isAssignedPlate(item.plate) || typeof item.supplierCode !== 'string' || !item.supplierCode)
            fail();
        const key = `${item.supplierCode}|${plateIdentityKey(item.plate)}`;
        if (unique && out.has(key))
            fail();
        (out.get(key) ?? out.set(key, []).get(key)).push(structuredClone(item));
    }
    return out;
}
export const SHARED_SHEET_SPEC_DIGEST = stableDigest(spec);
/** Executable online capture is bound to the approved current source, not an old fallback. */
export function assertCurrentSharedSheetSource(id) {
    const binding = spec.supplierManagement.sourceBinding;
    if (!id || binding.legacyInputEnabled !== false || binding.fallbackAllowed !== false || binding.summaryIsSource !== false ||
        !/^[a-f0-9]{64}$/.test(binding.spreadsheetIdSha256) ||
        createHash('sha256').update(id).digest('hex') !== binding.spreadsheetIdSha256 ||
        `shared-sheet:${stableDigest(id).slice(0, 24)}` !== binding.sourceId)
        throw new Error('SHARED_SHEET_SOURCE_BINDING_MISMATCH');
}
export const sharedSheetHeaders = spec.inputHeaders;
/** Registration is retained even when an input tab is absent. Absence is never a sold-out signal. */
export const sharedSheetRegisteredChannels = spec.supplierChannels.sharedInputSheet;
const registeredTabs = [...new Set(sharedSheetRegisteredChannels.map(x => x.tab))].sort();
const configuredTabs = [...spec.changeControl.activeSupplierTabs, ...spec.changeControl.absentRegisteredTabs].sort();
if (stableDigest(registeredTabs) !== stableDigest(configuredTabs))
    throw new Error('SHARED_SHEET_SCOPE_CONTRACT_INVALID');
export const sharedSheetChannels = sharedSheetRegisteredChannels.filter(channel => spec.changeControl.activeSupplierTabs.includes(channel.tab));
/** A populated exclusive supplier tab has one registered owner even if its company cell is blank.
 * Shared tabs still require the registered company/alias; an unknown nonblank name is never replaced. */
export function sharedSheetChannelOf(tab, company) {
    const name = String(company ?? '').trim();
    const registered = sharedSheetChannels.filter(c => c.tab === tab);
    return registered.find(c => c.companyName === name || (c.aliases ?? []).includes(name))
        ?? (!name && registered.length === 1 && sharedSheetRegisteredChannels.filter(c => c.tab === tab).length === 1 ? registered[0] : undefined);
}
export const sharedSheetUnavailableChannels = sharedSheetRegisteredChannels.filter(channel => !spec.changeControl.activeSupplierTabs.includes(channel.tab));
const timestamp = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(v) && Number.isFinite(Date.parse(v));
export function sharedSheetCaptureDigest(capture) {
    const { digest: _, ...body } = capture;
    return stableDigest(body);
}
/** Local JSON only: no Sheet API, inferred company, prices or hidden-tab fallback. */
export function buildSharedSheetBatch(input) {
    const c = input;
    const fail = () => { throw new Error('INVALID_SHARED_SHEET_CAPTURE'); };
    if (!c || c.schema !== 'shared-sheet-capture/v1' || typeof c.spreadsheetId !== 'string' || !c.spreadsheetId.trim() ||
        c.layoutVersion !== spec.layoutVersion || !timestamp(c.readTime) || !Array.isArray(c.tabs) ||
        (!c.revision && !c.digest) || (c.revision !== undefined && (typeof c.revision !== 'string' || !c.revision.trim())))
        fail();
    const digest = sharedSheetCaptureDigest(c);
    if (c.digest !== undefined && c.digest !== digest)
        fail();
    const titles = [...new Set(sharedSheetChannels.map(x => x.tab))];
    if (c.tabs.length !== titles.length || new Set(c.tabs.map(t => t.title)).size !== titles.length)
        fail();
    const sourceId = `shared-sheet:${stableDigest(c.spreadsheetId).slice(0, 24)}`;
    const rows = [];
    for (const tab of c.tabs) {
        if (!titles.includes(tab.title) || !timestamp(tab.readTime) || Date.parse(tab.readTime) < Date.parse(c.readTime) ||
            Date.parse(tab.readTime) - Date.parse(c.readTime) > 30 * 60 * 1000 || tab.complete !== true ||
            !Array.isArray(tab.values) || !Number.isSafeInteger(tab.rowCount) || tab.rowCount !== tab.values.length ||
            stableDigest(tab.values[0]) !== stableDigest(sharedSheetHeaders))
            fail();
        for (let index = 1; index < tab.values.length; index++) {
            const raw = tab.values[index];
            const values = Array.isArray(raw) ? raw : [raw];
            const shapeOk = Array.isArray(raw) && raw.length === 74 && raw.every(v => v === null ||
                typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)));
            if (values.every(v => v === '' || v === null || v === undefined))
                continue;
            const company = String(values[0] ?? '').trim();
            const supplier = sharedSheetChannelOf(tab.title, company);
            // Placeholders such as 「신차」 are not vehicle identities: keep RAW by position and let normalization HOLD the row.
            // A readable plate counts for cross-supplier checks even on a malformed row; identity still needs a valid row.
            const plate = isAssignedPlate(values[4]) ? plateIdentityKey(values[4]) : '';
            rows.push({ tab, index, values, supplierCode: supplier?.code ?? null,
                identity: supplier && plate && shapeOk ? stableDigest([supplier.code, plate]) : null, quarantine: shapeOk ? null : 'ROW_SHAPE_INVALID', plateKey: plate });
        }
    }
    const seen = new Map();
    for (const r of rows)
        if (r.identity)
            seen.set(r.identity, (seen.get(r.identity) ?? 0) + 1);
    // One plate = one canonical row: the same plate offered by two suppliers at once is quarantined on every row.
    const suppliersByPlate = new Map();
    for (const r of rows)
        if (r.plateKey && r.supplierCode)
            (suppliersByPlate.get(r.plateKey) ?? suppliersByPlate.set(r.plateKey, new Set()).get(r.plateKey)).add(r.supplierCode);
    for (const s of c.supplierEntered ?? [])
        if (!timestamp(s?.observedAt) || !['ERP5_PRODUCTS_SOURCE_TEXT', 'SHEET_BACKUP'].includes(s?.source) ||
            typeof s.sourceRef !== 'string' || !s.values || typeof s.values !== 'object' || Array.isArray(s.values))
            fail();
    const cell = (v) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
    for (const x of c.corrections ?? [])
        if (!timestamp(x?.at) || typeof x.column !== 'string' || !x.column || typeof x.source !== 'string' ||
            !('before' in x) || !('after' in x) || !cell(x.before) || !cell(x.after))
            fail();
    const entered = supplementByPlate(c.supplierEntered, true, fail);
    const corrections = supplementByPlate(c.corrections, false, fail);
    const records = rows.map(r => {
        const duplicate = r.identity !== null && seen.get(r.identity) > 1;
        const quarantine = r.quarantine ?? (duplicate ? 'DUPLICATE_IDENTITY'
            : r.plateKey && (suppliersByPlate.get(r.plateKey)?.size ?? 0) > 1 ? 'PLATE_ON_MULTIPLE_SUPPLIERS' : null);
        const rowKey = r.supplierCode && r.plateKey ? `${r.supplierCode}|${r.plateKey}` : '';
        const rowDigest = stableDigest(r.values);
        const sourceRecordId = r.identity && !quarantine ? r.identity : stableDigest([r.tab.title, r.index, rowDigest]);
        return { sourceRecordId, sourceFingerprint: stableDigest({ rowDigest, supplierCode: r.supplierCode }),
            payload: { values: structuredClone(r.values), tab: r.tab.title, row: r.index + 1, readTime: r.tab.readTime,
                spreadsheetId: c.spreadsheetId, revision: c.revision ?? null, captureDigest: digest, rowDigest,
                supplierCode: r.supplierCode, quarantine,
                ...(r.supplierCode && !String(r.values[0] ?? '').trim()
                    ? { supplierCodeBasis: 'REGISTERED_EXCLUSIVE_TAB_OWNER', supplierRegistryDigest: SHARED_SHEET_SPEC_DIGEST } : {}),
                // Evidence beside the row, outside rowDigest/fingerprint: the sheet values themselves stay the RAW of record.
                ...(rowKey && entered.has(rowKey) ? { supplierEntered: entered.get(rowKey)[0] } : {}),
                ...(rowKey && corrections.has(rowKey) ? { corrections: corrections.get(rowKey) } : {}) } };
    });
    if (Math.min(...c.tabs.map(t => Date.parse(t.readTime))) !== Date.parse(c.readTime))
        fail();
    return { laneId: 'PRODUCT_VEHICLE', source: { sourceId, kind: 'GOOGLE_SHEET', displayName: 'Shared supplier input',
            expectedFreshnessSeconds: 1800 }, observedAt: c.readTime, sourceRevision: c.revision ?? digest, checksum: digest,
        // Complete within the explicitly configured input scope, partial against supplier registration.
        // PARTIAL prevents canAssertSourceAbsence from authorizing retirement of absent suppliers' stock.
        coverage: { mode: sharedSheetUnavailableChannels.length ? 'PARTIAL' : 'FULL', completeness: 'COMPLETE',
            scope: `shared-input:${titles.length}-tabs:${sharedSheetChannels.length}-codes`,
            note: `Registered tabs outside capture scope: ${[...new Set(sharedSheetUnavailableChannels.map(x => x.tab))].join(',')}; absence/retirement not authorized.` }, records };
}
