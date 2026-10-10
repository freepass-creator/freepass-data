import { createHash } from 'node:crypto';
import { stableDigest } from '../shared/stable-digest.js';
import type {
  SettlementIdLinkAuditSource,
  SettlementIdLinkContract,
  SettlementIdLinkProduct,
  SettlementIdLinkRawValue,
} from '../domain/settlement-id-link-audit.js';

export type SettlementIdLinkClassification =
  | 'LINKED_EXPLICIT'
  | 'LINK_CANDIDATE_BY_PLATE'
  | 'ORPHAN'
  | 'AMBIGUOUS';

export type SettlementIdLinkAuditInput = SettlementIdLinkAuditSource & {
  observedAt?: string;
};

export type SettlementIdLinkAuditReport = {
  schema: 'freepass-data.settlement-id-link-audit/v1';
  observedAt: string;
  summary: {
    settlementRows: number;
    idValuePresence: Record<'contractNo' | 'contractId' | 'contractCode' | 'intakeRequestId' | 'sourceProductId', {
      value: number;
      unknown: number;
      zero: number;
      emptyString: number;
      missing: number;
    }>;
    productsByPlate: { one: number; zero: number; many: number };
    contractsByPlate: {
      validOne: number;
      validZero: number;
      validMany: number;
      excludedTest: number;
      excludedDeleted: number;
      excludedDraft: number;
    };
    classifications: Record<SettlementIdLinkClassification, number>;
  };
  rows: Array<{
    rowId: string;
    source: { tab: string | null; row: string | number | null };
    classification: SettlementIdLinkClassification;
    explicitMatches: { contractIds: string[]; productIds: string[] };
    plateCandidates: { contractIds: string[]; productIds: string[] };
    excludedContractIds: { test: string[]; deleted: string[]; draft: string[] };
    idValuePresence: Record<'contractNo' | 'contractId' | 'contractCode' | 'intakeRequestId' | 'sourceProductId', 'VALUE' | 'UNKNOWN' | 'ZERO' | 'EMPTY_STRING' | 'MISSING'>;
  }>;
  digest: string;
};

/** 보고서에는 원본 문서 ID(차량번호 기반일 수 있음) 대신 이 해시만 나간다. 원본↔해시 대응표는 보고서에 넣지 않는다. */
export const hashAuditId = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12);
const hashAll = (ids: string[]) => ids.map(hashAuditId);

const idFields = ['contractNo', 'contractId', 'contractCode', 'intakeRequestId', 'sourceProductId'] as const;

const text = (value: SettlementIdLinkRawValue): string | null =>
  typeof value === 'string' && value.trim() ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value)
      : null;

const plateKey = (value: SettlementIdLinkRawValue): string | null => {
  const normalized = text(value)?.replace(/\s/g, '').toUpperCase();
  return normalized || null;
};

const unknownTexts = new Set(['unknown', '모름', '확인 필요']);

const valuePresence = (value: SettlementIdLinkRawValue): 'VALUE' | 'UNKNOWN' | 'ZERO' | 'EMPTY_STRING' | 'MISSING' => {
  if (value === undefined || value === null) return 'MISSING';
  if (typeof value === 'string' && value.length === 0) return 'EMPTY_STRING';
  if (typeof value === 'number' && Object.is(value, 0)) return 'ZERO';
  if (typeof value === 'string' && unknownTexts.has(value.trim().toLowerCase())) return 'UNKNOWN';
  return text(value) === null ? 'MISSING' : 'VALUE';
};

const isDeleted = (contract: SettlementIdLinkContract) => contract._deleted === true;
const isDraft = (contract: SettlementIdLinkContract) => contract.is_draft === true;
const isTest = (contract: SettlementIdLinkContract) =>
  contract.test === true
  || contract.is_test === true
  || String(contract.env ?? '').toLowerCase() === 'test'
  || String(contract.type ?? '').toLowerCase() === 'test'
  || String(contract.status ?? '').toLowerCase().includes('test');

const uniqueSorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
const normalized = (value: SettlementIdLinkRawValue): string | null => text(value)?.toUpperCase() ?? null;

function push<K, V>(map: Map<K, V[]>, key: K | null, value: V) {
  if (key === null) return;
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

export function auditSettlementIdLinks(input: SettlementIdLinkAuditInput): SettlementIdLinkAuditReport {
  const productsByPlate = new Map<string, SettlementIdLinkProduct[]>();
  const productsByCode = new Map<string, SettlementIdLinkProduct[]>();
  const productsById = new Map<string, SettlementIdLinkProduct[]>();
  for (const product of input.products) {
    push(productsByPlate, plateKey(product.car_number), product);
    push(productsByCode, text(product.product_code), product);
    push(productsById, product.id, product);
  }

  const validContractsByPlate = new Map<string, SettlementIdLinkContract[]>();
  const excludedContractsByPlate = {
    test: new Map<string, SettlementIdLinkContract[]>(),
    deleted: new Map<string, SettlementIdLinkContract[]>(),
    draft: new Map<string, SettlementIdLinkContract[]>(),
  };
  const contractsById = new Map<string, SettlementIdLinkContract[]>();
  const contractsByCode = new Map<string, SettlementIdLinkContract[]>();
  for (const contract of input.contracts) {
    push(contractsById, contract.id, contract);
    push(contractsByCode, text(contract.contract_code), contract);
    const key = plateKey(contract.car_number_snapshot);
    if (isDeleted(contract)) push(excludedContractsByPlate.deleted, key, contract);
    else if (isDraft(contract)) push(excludedContractsByPlate.draft, key, contract);
    else if (isTest(contract)) push(excludedContractsByPlate.test, key, contract);
    else push(validContractsByPlate, key, contract);
  }

  const presenceCounts = Object.fromEntries(idFields.map((field) => [field, {
    value: 0, unknown: 0, zero: 0, emptyString: 0, missing: 0,
  }])) as SettlementIdLinkAuditReport['summary']['idValuePresence'];
  const classifications: Record<SettlementIdLinkClassification, number> = {
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
    })) as SettlementIdLinkAuditReport['rows'][number]['idValuePresence'];

    const rowPlate = plateKey(row.plate);
    const explicitContracts = uniqueSorted([
      ...(text(row.contractId) ? (contractsById.get(text(row.contractId)!) ?? []).map((contract) => contract.id) : []),
      ...(text(row.contractCode) ? (contractsByCode.get(text(row.contractCode)!) ?? []).map((contract) => contract.id) : []),
      ...(text(row.contractNo) ? (contractsByCode.get(text(row.contractNo)!) ?? []).map((contract) => contract.id) : []),
    ].filter((id) => {
      const contract = input.contracts.find((candidate) => candidate.id === id);
      return contract && !isDeleted(contract) && !isDraft(contract) && !isTest(contract);
    }));
    const explicitProducts = uniqueSorted([
      ...(text(row.sourceProductId) ? (productsById.get(text(row.sourceProductId)!) ?? []).map((product) => product.id) : []),
      ...(text(row.sourceProductId) ? (productsByCode.get(text(row.sourceProductId)!) ?? []).map((product) => product.id) : []),
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
    const classification: SettlementIdLinkClassification =
      explicitContracts.length > 1 || explicitProducts.length > 1 || plateContracts.length > 1 || plateProducts.length > 1 ? 'AMBIGUOUS'
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

  const countMatches = (map: Map<string, unknown[]>) => {
    let one = 0, zero = 0, many = 0;
    for (const row of input.settlementRows) {
      const key = plateKey(row.plate);
      const count = key ? (map.get(key)?.length ?? 0) : 0;
      if (count === 0) zero++;
      else if (count === 1) one++;
      else many++;
    }
    return { one, zero, many };
  };
  const countContracts = () => {
    let validOne = 0, validZero = 0, validMany = 0, excludedTest = 0, excludedDeleted = 0, excludedDraft = 0;
    for (const row of input.settlementRows) {
      const key = plateKey(row.plate);
      const valid = key ? validContractsByPlate.get(key)?.length ?? 0 : 0;
      if (valid === 0) validZero++;
      else if (valid === 1) validOne++;
      else validMany++;
      excludedTest += key ? excludedContractsByPlate.test.get(key)?.length ?? 0 : 0;
      excludedDeleted += key ? excludedContractsByPlate.deleted.get(key)?.length ?? 0 : 0;
      excludedDraft += key ? excludedContractsByPlate.draft.get(key)?.length ?? 0 : 0;
    }
    return { validOne, validZero, validMany, excludedTest, excludedDeleted, excludedDraft };
  };

  const report = {
    schema: 'freepass-data.settlement-id-link-audit/v1' as const,
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
