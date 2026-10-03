import { describe, expect, it } from 'vitest';
import sheetSpec from '../contracts/f01-f86-sheet-spec.v1.json' with { type: 'json' };
import inputSpec from '../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };

describe('F01 supplier layout (2026-10-03 decision, designed not applied)', () => {
  const layout = sheetSpec.f01SupplierLayout;
  const outside = inputSpec.supplierChannels.notInSharedSheet.map((row) => row.code).sort();

  it('gives each supplier outside the shared input sheet exactly one tab', () => {
    expect(layout.supplierTabs.map((tab) => tab.supplierCode).sort()).toEqual(outside);
    expect(new Set(layout.supplierTabs.map((tab) => tab.key)).size).toBe(layout.supplierTabs.length);
    for (const code of outside) {
      expect(inputSpec.supplierChannels.sharedInputSheet.some((row) => row.code === code)).toBe(false);
    }
  });

  it('orders every company tab and the shared summary tab once', () => {
    expect([...layout.proposedOrder].sort())
      .toEqual([...layout.supplierTabs.map((tab) => tab.key), layout.sharedInputSummaryTab.key].sort());
  });

  it('leaves the current executor binding in force until the layout is applied', () => {
    expect(layout.state).toBe('DESIGNED_NOT_APPLIED');
    expect(sheetSpec.primaryTabs).toHaveLength(4);
  });
});
