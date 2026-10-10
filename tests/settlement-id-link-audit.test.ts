import { describe, expect, it } from 'vitest';
import {
  auditSettlementIdLinks,
  type SettlementIdLinkAuditInput, hashAuditId } from '../src/application/settlement-id-link-audit.js';

const base = (): SettlementIdLinkAuditInput => ({
  observedAt: '2026-10-10T00:00:00.000Z',
  settlementRows: [
    { id: 'row-explicit', plate: 'PLATE-FAKE-A', sourceTab: '정산', sourceRow: 2, contractId: 'contract-1', sourceProductId: 'product-1' },
    { id: 'row-plate-only', plate: 'PLATE-FAKE-B' },
    { id: 'row-orphan', plate: 'PLATE-FAKE-C' },
    { id: 'row-ambiguous', plate: 'PLATE-FAKE-D' },
    { id: 'row-excluded', plate: 'PLATE-FAKE-E' },
    { id: 'row-zero-empty', plate: 'PLATE-FAKE-F', contractNo: 0, contractId: '', contractCode: null, intakeRequestId: undefined, sourceProductId: '0' },
  ],
  contracts: [
    { id: 'contract-1', car_number_snapshot: 'PLATE-FAKE-A', contract_code: 'C-1', product_code: 'P-1' },
    { id: 'contract-2', car_number_snapshot: 'PLATE-FAKE-B', contract_code: 'C-2', product_code: 'P-2' },
    { id: 'contract-4a', car_number_snapshot: 'PLATE-FAKE-D', contract_code: 'C-4A', product_code: 'P-4A' },
    { id: 'contract-4b', car_number_snapshot: 'PLATE-FAKE-D', contract_code: 'C-4B', product_code: 'P-4B' },
    { id: 'contract-test', car_number_snapshot: 'PLATE-FAKE-E', contract_code: 'C-T', product_code: 'P-T', test: true },
    { id: 'contract-deleted', car_number_snapshot: 'PLATE-FAKE-E', contract_code: 'C-D', product_code: 'P-D', _deleted: true },
    { id: 'contract-draft', car_number_snapshot: 'PLATE-FAKE-E', contract_code: 'C-R', product_code: 'P-R', is_draft: true },
  ],
  products: [
    { id: 'product-1', car_number: 'PLATE-FAKE-A', product_code: 'P-1' },
    { id: 'product-2', car_number: 'PLATE-FAKE-B', product_code: 'P-2' },
    { id: 'product-4', car_number: 'PLATE-FAKE-D', product_code: 'P-4' },
  ],
});

describe('settlement id link audit', () => {
  it('classifies explicit links without exposing plate values', () => {
    const result = auditSettlementIdLinks(base());
    expect(result.rows.find((row) => row.rowId === hashAuditId('row-explicit'))).toMatchObject({
      classification: 'LINKED_EXPLICIT',
      explicitMatches: { contractIds: ['contract-1'].map(hashAuditId), productIds: ['product-1'].map(hashAuditId) },
    });
    expect(JSON.stringify(result.rows)).not.toContain('PLATE-FAKE-A');
  });

  it('keeps plate-only matches as candidates only', () => {
    const result = auditSettlementIdLinks(base());
    expect(result.rows.find((row) => row.rowId === hashAuditId('row-plate-only'))).toMatchObject({
      classification: 'LINK_CANDIDATE_BY_PLATE',
      plateCandidates: { contractIds: ['contract-2'].map(hashAuditId), productIds: ['product-2'].map(hashAuditId) },
    });
  });

  it('reports orphan rows', () => {
    const result = auditSettlementIdLinks(base());
    expect(result.rows.find((row) => row.rowId === hashAuditId('row-orphan'))!.classification).toBe('ORPHAN');
  });

  it('reports multiple candidates as ambiguous', () => {
    const result = auditSettlementIdLinks(base());
    expect(result.rows.find((row) => row.rowId === hashAuditId('row-ambiguous'))!.classification).toBe('AMBIGUOUS');
    expect(result.summary.productsByPlate.many).toBe(0);
    expect(result.summary.contractsByPlate.validMany).toBe(1);
  });

  it('separates test, deleted, and draft contracts from valid candidates', () => {
    const result = auditSettlementIdLinks(base());
    const row = result.rows.find((item) => item.rowId === hashAuditId('row-excluded'))!;
    expect(row.classification).toBe('ORPHAN');
    expect(row.excludedContractIds).toEqual({
      test: ['contract-test'].map(hashAuditId),
      deleted: ['contract-deleted'].map(hashAuditId),
      draft: ['contract-draft'].map(hashAuditId),
    });
    expect(result.summary.contractsByPlate).toMatchObject({ excludedTest: 1, excludedDeleted: 1, excludedDraft: 1 });
  });

  it('separates zero, empty string, missing, and value presence', () => {
    const result = auditSettlementIdLinks(base());
    const row = result.rows.find((item) => item.rowId === hashAuditId('row-zero-empty'))!;
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
      explicitMatches: { contractIds: ['contract-1'].map(hashAuditId), productIds: ['product-2'].map(hashAuditId) },
    });
  });

  it('keeps source tab but never emits plate or customer identity in row reports', () => {
    const input = base();
    input.settlementRows = [{
      id: 'row-private-fields',
      plate: 'PLATE-FAKE-A',
      sourceTab: '정산',
      sourceRow: 7,
      customerName: 'CUSTOMER-FAKE',
    } as SettlementIdLinkAuditInput['settlementRows'][number] & { customerName: string }];
    const result = auditSettlementIdLinks(input);
    expect(result.rows[0]!.source).toEqual({ tab: '정산', row: 7 });
    const json = JSON.stringify(result);
    expect(json).not.toContain('PLATE-FAKE-A');
    expect(json).not.toContain('CUSTOMER-FAKE');
  });

  it('does not mutate input', () => {
    const input = base();
    const before = structuredClone(input);
    auditSettlementIdLinks(input);
    expect(input).toEqual(before);
  });

  it('returns linked explicit when exactly one explicit id matches', () => {
    const input = base();
    input.settlementRows = [{ id: 'row-explicit-contract-only', plate: 'PLATE-FAKE-A', contractCode: 'C-1' }];
    const result = auditSettlementIdLinks(input);
    expect(result.rows[0]!.classification).toBe('LINKED_EXPLICIT');
  });

  it('returns a plate candidate when exactly one plate candidate exists', () => {
    const input = base();
    input.products = [];
    input.settlementRows = [{ id: 'row-plate-contract-only', plate: 'PLATE-FAKE-B' }];
    const result = auditSettlementIdLinks(input);
    expect(result.rows[0]!.classification).toBe('LINK_CANDIDATE_BY_PLATE');
  });

  it('hashes document ids so plate-shaped ids never reach the report', () => {
    const input = base();
    input.settlementRows = [{ id: 'PLATE-FAKE-A-ledger', plate: 'PLATE-FAKE-A', sourceTab: '정산' }];
    input.products = [{ id: 'PLATE-FAKE-A', car_number: 'PLATE-FAKE-A', product_code: 'P-1' }];
    input.contracts = [{ id: 'PLATE-FAKE-A-contract', car_number_snapshot: 'PLATE-FAKE-A', contract_code: 'C-1', product_code: 'P-1' }];
    const json = JSON.stringify(auditSettlementIdLinks(input).rows);
    expect(json).not.toContain('PLATE-FAKE-A');
    expect(json).toContain(hashAuditId('PLATE-FAKE-A-ledger'));
    expect(hashAuditId('x')).toMatch(/^[0-9a-f]{12}$/);
  });
});
