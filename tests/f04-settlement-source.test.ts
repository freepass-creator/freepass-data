import { describe, expect, it } from 'vitest';
import {
  buildF04SettlementSourceBatch,
  F04_SPREADSHEET_ID,
} from '../src/adapters/f04-settlement-source.js';
import { validateSourceIntakeBatch } from '../src/domain/source-intake.js';

describe('F04 settlement workbook source capture', () => {
  const snapshot = () => ({
    spreadsheetId: F04_SPREADSHEET_ID,
    title: '[F04 사용중] 프리패스 정산원장',
    observedAt: '2026-09-28T10:00:00+09:00',
    revisionBefore: 'version:101',
    revisionAfter: 'version:101',
    expectedSheetCount: 2,
    sheets: [
      {
        sheetId: 20,
        title: '접수',
        index: 1,
        rowCount: 10,
        columnCount: 3,
        displayRows: [['접수번호', '고객명'], ['A-1', '홍길동'], []],
        formulaRows: [[], [], []],
      },
      {
        sheetId: 10,
        title: '_백업',
        index: 0,
        hidden: true,
        rowCount: 5,
        columnCount: 2,
        displayRows: [['합계'], [100]],
        formulaRows: [[], ['=SUM(B2:B3)']],
      },
    ],
  });

  it('keeps every sheet manifest and every non-empty row with stable coordinates', () => {
    const batch = buildF04SettlementSourceBatch(snapshot());

    expect(validateSourceIntakeBatch(batch)).toBe(true);
    expect(batch.coverage).toMatchObject({
      mode: 'FULL',
      completeness: 'COMPLETE',
    });
    expect(batch.records.map((record) => record.sourceRecordId)).toEqual([
      'sheet:10:manifest',
      'sheet:10:row:1',
      'sheet:10:row:2',
      'sheet:20:manifest',
      'sheet:20:row:1',
      'sheet:20:row:2',
    ]);
    expect(batch.records[2]?.payload).toMatchObject({
      sheetTitle: '_백업',
      hidden: true,
      rowNumber: 2,
      displayValues: [100],
      formulaValues: ['=SUM(B2:B3)'],
    });
  });

  it('holds the capture when the source revision changes during the read', () => {
    const input = snapshot();
    input.revisionAfter = 'version:102';

    const batch = buildF04SettlementSourceBatch(input);

    expect(batch.coverage).toMatchObject({
      mode: 'PARTIAL',
      completeness: 'INCOMPLETE',
    });
    expect(batch.coverage.note).toContain('HOLD_SOURCE_PARITY');
  });

  it('holds the capture when even one expected tab is missing', () => {
    const input = snapshot();
    input.sheets = input.sheets.slice(0, 1);

    const batch = buildF04SettlementSourceBatch(input);

    expect(batch.coverage).toMatchObject({
      mode: 'PARTIAL',
      completeness: 'INCOMPLETE',
    });
    expect(batch.coverage.note).toContain('sheets=1/2');
  });
});
