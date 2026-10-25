import { createHash } from 'node:crypto';
import { stableDigest } from '../shared/stable-digest.js';
/** 보고서에는 원본 문서 ID(차량번호 기반일 수 있음) 대신 이 해시만 나간다. 원본↔해시 대응표는 보고서에 넣지 않는다. */
export const hashAuditId = (id) => createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12);
const hashAll = (ids) => ids.map(hashAuditId);
const idFields = ['contractNo', 'contractId', 'contractCode', 'intakeRequestId', 'sourceProductId'];
const text = (value) => typeof value === 'string' && value.trim() ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value)
        : null;
const plateKey = (value) => {
    const normalized = text(value)?.replace(/\s/g, '').toUpperCase();
    return normalized || null;
};
const unknownTexts = new Set(['unknown', '모름', '확인 필요']);
const valuePresence = (value) => {
    if (value === undefined || value === null)
        return 'MISSING';
    if (typeof value === 'string' && value.length === 0)
        return 'EMPTY_STRING';
    if (typeof value === 'number' && Object.is(value, 0))
        return 'ZERO';
    if (typeof value === 'string' && unknownTexts.has(value.trim().toLowerCase()))
        return 'UNKNOWN';
    return text(value) === null ? 'MISSING' : 'VALUE';
};
const isDeleted = (contract) => contract._deleted === true;
const isDraft = (contract) => contract.is_draft === true;
const isTest = (contract) => contract.test === true
    || contract.is_test === true
    || String(contract.env ?? '').toLowerCase() === 'test'
    || String(contract.type ?? '').toLowerCase() === 'test'
    || String(contract.status ?? '').toLowerCase().includes('test');
const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
const normalized = (value) => text(value)?.toUpperCase() ?? null;
function push(map, key, value) {
    if (key === null)
        return;
    const values = map.get(key) ?? [];
    values.push(value);
    map.set(key, values);
}
export function auditSettlementIdLinks(input) {
    const productsByPlate = new Map();
    const productsByCode = new Map();
    const productsById = new Map();
    for (const product of input.products) {
        push(productsByPlate, plateKey(product.car_number), product);
        push(productsByCode, text(product.product_code), product);
        push(productsById, product.id, product);
    }
    const validContractsByPlate = new Map();
    const excludedContractsByPlate = {
        test: new Map(),
        deleted: new Map(),
        draft: new Map(),
    };
    const contractsById = new Map();
    const contractsByCode = new Map();
    for (const contract of input.contracts) {
        push(contractsById, contract.id, contract);
        push(contractsByCode, text(contract.contract_code), contract);
        const key = plateKey(contract.car_number_snapshot);
        if (isDeleted(contract))
            push(excludedContractsByPlate.deleted, key, contract);
        else if (isDraft(contract))
            push(excludedContractsByPlate.draft, key, contract);
        else if (isTest(contract))
            push(excludedContractsByPlate.test, key, contract);
        else
            push(validContractsByPlate, key, contract);
    }
    const presenceCounts = Object.fromEntries(idFields.map((field) => [field, {
            value: 0, unknown: 0, zero: 0, emptyString: 0, missing: 0,
        }]));
    const classifications = {
        LINKED_EXPLICIT: 0,
        LINK_CANDIDATE_BY_PLATE: 0,
        ORPHAN: 0,
        AMBIGUOUS: 0,
    };
    const rows = input.settlementRows.map((row) => {
        const rowPresence = Object.fromEntries(idFields.map((field) => {
            const presence = valuePresence(row[field]);
            presenceCounts[field][presence === 'VALUE' ? 'value' : presence === 'UNKNOWN' ? 'unknown' : presence === 'ZERO' ? 'zero' : presence === 'EMPTY_STRING' ? 'emptyString' : 'missing']++;
            return [field, presence];
        }));
        const rowPlate = plateKey(row.plate);
        const explicitContracts = uniqueSorted([
            ...(text(row.contractId) ? (contractsById.get(text(row.contractId)) ?? []).map((contract) => contract.id) : []),
            ...(text(row.contractCode) ? (contractsByCode.get(text(row.contractCode)) ?? []).map((contract) => contract.id) : []),
            ...(text(row.contractNo) ? (contractsByCode.get(text(row.contractNo)) ?? []).map((contract) => contract.id) : []),
        ].filter((id) => {
            const contract = input.contracts.find((candidate) => candidate.id === id);
            return contract && !isDeleted(contract) && !isDraft(contract) && !isTest(contract);
        }));
        const explicitProducts = uniqueSorted([
            ...(text(row.sourceProductId) ? (productsById.get(text(row.sourceProductId)) ?? []).map((product) => product.id) : []),
            ...(text(row.sourceProductId) ? (productsByCode.get(text(row.sourceProductId)) ?? []).map((product) => product.id) : []),
        ]);
        const explicitContractProductCode = explicitContracts.length === 1
            ? normalized(input.contracts.find((contract) => contract.id === explicitContracts[0])?.product_code)
            : null;
        const explicitProductCode = explicitProducts.length === 1
            ? normalized(input.products.find((product) => product.id === explicitProducts[0])?.product_code)
            : null;
        const hasExplicitContradiction = explicitContractProductCode !== null
            && explicitProductCode !== null
            && explicitContractProductCode !== explicitProductCode;
        const plateContracts = uniqueSorted((rowPlate ? validContractsByPlate.get(rowPlate) ?? [] : []).map((contract) => contract.id));
        const plateProducts = uniqueSorted((rowPlate ? productsByPlate.get(rowPlate) ?? [] : []).map((product) => product.id));
        const excluded = {
            test: uniqueSorted((rowPlate ? excludedContractsByPlate.test.get(rowPlate) ?? [] : []).map((contract) => contract.id)),
            deleted: uniqueSorted((rowPlate ? excludedContractsByPlate.deleted.get(rowPlate) ?? [] : []).map((contract) => contract.id)),
            draft: uniqueSorted((rowPlate ? excludedContractsByPlate.draft.get(rowPlate) ?? [] : []).map((contract) => contract.id)),
        };
        const explicitCount = explicitContracts.length + explicitProducts.length;
        const plateCandidateCount = plateContracts.length + plateProducts.length;
        const classification = explicitContracts.length > 1 || explicitProducts.length > 1 || plateContracts.length > 1 || plateProducts.length > 1 ? 'AMBIGUOUS'
            : hasExplicitContradiction ? 'AMBIGUOUS'
                : explicitCount > 0 ? 'LINKED_EXPLICIT'
                    : plateCandidateCount > 0 ? 'LINK_CANDIDATE_BY_PLATE'
                        : 'ORPHAN';
        classifications[classification]++;
        return {
            rowId: hashAuditId(row.id),
            source: { tab: text(row.sourceTab), row: typeof row.sourceRow === 'number' ? row.sourceRow : text(row.sourceRow) },
            classification,
            explicitMatches: { contractIds: hashAll(explicitContracts), productIds: hashAll(explicitProducts) },
            plateCandidates: { contractIds: hashAll(plateContracts), productIds: hashAll(plateProducts) },
            excludedContractIds: { test: hashAll(excluded.test), deleted: hashAll(excluded.deleted), draft: hashAll(excluded.draft) },
            idValuePresence: rowPresence,
        };
    });
    const countMatches = (map) => {
        let one = 0, zero = 0, many = 0;
        for (const row of input.settlementRows) {
            const key = plateKey(row.plate);
            const count = key ? (map.get(key)?.length ?? 0) : 0;
            if (count === 0)
                zero++;
            else if (count === 1)
                one++;
            else
                many++;
        }
        return { one, zero, many };
    };
    const countContracts = () => {
        let validOne = 0, validZero = 0, validMany = 0, excludedTest = 0, excludedDeleted = 0, excludedDraft = 0;
        for (const row of input.settlementRows) {
            const key = plateKey(row.plate);
            const valid = key ? validContractsByPlate.get(key)?.length ?? 0 : 0;
            if (valid === 0)
                validZero++;
            else if (valid === 1)
                validOne++;
            else
                validMany++;
            excludedTest += key ? excludedContractsByPlate.test.get(key)?.length ?? 0 : 0;
            excludedDeleted += key ? excludedContractsByPlate.deleted.get(key)?.length ?? 0 : 0;
            excludedDraft += key ? excludedContractsByPlate.draft.get(key)?.length ?? 0 : 0;
        }
        return { validOne, validZero, validMany, excludedTest, excludedDeleted, excludedDraft };
    };
    const report = {
        schema: 'freepass-data.settlement-id-link-audit/v1',
        observedAt: input.observedAt ?? new Date().toISOString(),
        summary: {
            settlementRows: input.settlementRows.length,
            idValuePresence: presenceCounts,
            productsByPlate: countMatches(productsByPlate),
            contractsByPlate: countContracts(),
            classifications,
        },
        rows,
    };
    return { ...report, digest: stableDigest(report) };
}
