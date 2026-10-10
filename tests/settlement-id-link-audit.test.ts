import { describe, expect, it } from 'vitest';
import {
  auditSettlementIdLinks,
  type SettlementIdLinkAuditInput,
} from '../src/application/settlement-id-link-audit.js';

const base = (): SettlementIdLinkAuditInput => ({
  observedAt: '2026-10-10T00:00:00.000Z',
  settlementRows: [
    { id: 'row-explicit', plate: '11가1111', sourceTab: '정산', sourceRow: 2, contractId: 'contract-1', sourceProductId: 'product-1' },
    { id: 'row-plate-only', plate: '22가2222' },
    { id: 'row-orphan', plate: '33가3333' },
    { id: 'row-ambiguous', plate: '44가4444' },
    { id: 'row-excluded', plate: '55가5555' },
    { id: 'row-zero-empty', plate: '66가6666', contractNo: 0, contractId: '', contractCode: null, intakeRequestId: undefined, sourceProductId: '0' },
  ],
  contracts: [
    { id: 'contract-1', car_number_snapshot: '11가1111', contract_code: 'C-1', product_code: 'P-1' },
    { id: 'contract-2', car_number_snapshot: '22가2222', contract_code: 'C-2', product_code: 'P-2' },
    { id: 'contract-4a', car_number_snapshot: '44가4444', contract_code: 'C-4A', product_code: 'P-4A' },
    { id: 'contract-4b', car_number_snapshot: '44가4444', contract_code: 'C-4B', product_code: 'P-4B' },
    { id: 'contract-test', car_number_snapshot: '55가5555', contract_code: 'C-T', product_code: 'P-T', test: true },
    { id: 'contract-deleted', car_number_snapshot: '55가5555', contract_code: 'C-D', product_code: 'P-D', _deleted: true },
    { id: 'contract-draft', car_number_snapshot: '55가5555', contract_code: 'C-R', product_code: 'P-R', is_draft: true },
  ],
  products: [
    { id: 'product-1', car_number: '11가1111', product_code: 'P-1' },
    { id: 'product-2', car_number: '22가2222', product_code: 'P-2' },
    { id: 'product-4', car_number: '44가4444', product_code: 'P-4' },
  ],
});

describe('settlement id link audit', () => {
  it('classifies explicit links without exposing plate values', () => {
    const result = auditSettlementIdLinks(base());
    expect(result.rows.find((row) => row.rowId === 'row-explicit')).toMatchObject({
      classification: 'LINKED_EXPLICIT',
      explicitMatches: { contractIds: ['contract-1'], productIds: ['product-1'] },
    });
    expect(JSON.stringify(result.rows)).not.toContain('11가1111');
  });

  it('keeps plate-only matches as candidates only', () => {
    const result = auditSettlementIdLinks(base());
    expect(result.rows.find((row) => row.rowId === 'row-plate-only')).toMatchObject({
      classification: 'LINK_CANDIDATE_BY_PLATE',
      plateCandidates: { contractIds: ['contract-2'], productIds: ['product-2'] },
    });
  });

  it('reports orphan rows', () => {
    const result = auditSettlementIdLinks(base());
    expect(result.rows.find((row) => row.rowId === 'row-orphan')!.classification).toBe('ORPHAN');
  });

  it('reports multiple candidates as ambiguous', () => {
    const result = auditSettlementIdLinks(base());
    expect(result.rows.find((row) => row.rowId === 'row-ambiguous')!.classification).toBe('AMBIGUOUS');
    expect(result.summary.productsByPlate.many).toBe(0);
    expect(result.summary.contractsByPlate.validMany).toBe(1);
  });

  it('separates test, deleted, and draft contracts from valid candidates', () => {
    const result = auditSettlementIdLinks(base());
    const row = result.rows.find((item) => item.rowId === 'row-excluded')!;
    expect(row.classification).toBe('ORPHAN');
    expect(row.excludedContractIds).toEqual({
      test: ['contract-test'],
      deleted: ['contract-deleted'],
      draft: ['contract-draft'],
    });
    expect(result.summary.contractsByPlate).toMatchObject({ excludedTest: 1, excludedDeleted: 1, excludedDraft: 1 });
  });

  it('separates zero, empty string, missing, and value presence', () => {
    const result = auditSettlementIdLinks(base());
    const row = result.rows.find((item) => item.rowId === 'row-zero-empty')!;
    expect(row.idValuePresence).toMatchObject({
      contractNo: 'ZERO',
      contractId: 'EMPTY_STRING',
      contractCode: 'MISSING',
      intakeRequestId: 'MISSING',
      sourceProductId: 'VALUE',
    });
    expect(result.summary.idValuePresence.contractNo.zero).toBe(1);
    expect(result.summary.idValuePresence.contractId.emptyString).toBe(1);
  });

  it('counts declared unknown values separately from real values', () => {
    const input = base();
    input.settlementRows = [{
      id: 'row-unknown-values',
      contractNo: 'UNKNOWN',
      contractId: 'unknown',
      contractCode: '모름',
      intakeRequestId: '확인 필요',
      sourceProductId: 'real-id',
    }];
    const result = auditSettlementIdLinks(input);
    expect(result.rows[0]!.idValuePresence).toMatchObject({
      contractNo: 'UNKNOWN',
      contractId: 'UNKNOWN',
      contractCode: 'UNKNOWN',
      intakeRequestId: 'UNKNOWN',
      sourceProductId: 'VALUE',
    });
    expect(result.summary.idValuePresence.contractNo.unknown).toBe(1);
    expect(result.summary.idValuePresence.sourceProductId.value).toBe(1);
  });

  it('does not accept contradictory explicit contract and product ids as linked', () => {
    const input = base();
    input.settlementRows = [{
      id: 'row-explicit-conflict',
      contractId: 'contract-1',
      sourceProductId: 'product-2',
    }];
    const result = auditSettlementIdLinks(input);
    expect(result.rows[0]).toMatchObject({
      classification: 'AMBIGUOUS',
      explicitMatches: { contractIds: ['contract-1'], productIds: ['product-2'] },
    });
  });

  it('keeps source tab but never emits plate or customer identity in row reports', () => {
    const input = base();
    input.settlementRows = [{
      id: 'row-private-fields',
      plate: '11가1111',
      sourceTab: '정산',
      sourceRow: 7,
      customerName: '홍길동',
    } as SettlementIdLinkAuditInput['settlementRows'][number] & { customerName: string }];
    const result = auditSettlementIdLinks(input);
    expect(result.rows[0]!.source).toEqual({ tab: '정산', row: 7 });
    const json = JSON.stringify(result);
    expect(json).not.toContain('11가1111');
    expect(json).not.toContain('홍길동');
  });

  it('does not mutate input', () => {
    const input = base();
    const before = structuredClone(input);
    auditSettlementIdLinks(input);
    expect(input).toEqual(before);
  });

  it('returns linked explicit when exactly one explicit id matches', () => {
    const input = base();
    input.settlementRows = [{ id: 'row-explicit-contract-only', plate: '11가1111', contractCode: 'C-1' }];
    const result = auditSettlementIdLinks(input);
    expect(result.rows[0]!.classification).toBe('LINKED_EXPLICIT');
  });

  it('returns a plate candidate when exactly one plate candidate exists', () => {
    const input = base();
    input.products = [];
    input.settlementRows = [{ id: 'row-plate-contract-only', plate: '22가2222' }];
    const result = auditSettlementIdLinks(input);
    expect(result.rows[0]!.classification).toBe('LINK_CANDIDATE_BY_PLATE');
  });
});
