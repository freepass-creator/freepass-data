import { stableDigest } from '../shared/stable-digest.js';
import type { SourceIntakeBatch } from '../domain/source-intake.js';

export const F04_SPREADSHEET_ID = '1BjGBqAjRLEb9ZMKarpQsMF-q_UjdgmEqBAl1uVk8SR4';
export const F04_SOURCE_ID = 'google-sheets/f04-settlement-ledger';

export type F04SheetSnapshot = {
  sheetId: number;
  title: string;
  index: number;
  hidden?: boolean;
  rowCount: number;
  columnCount: number;
  displayRows: unknown[][];
  formulaRows?: unknown[][];
};

export type F04WorkbookSnapshot = {
  spreadsheetId: string;
  title: string;
  observedAt: string;
  revisionBefore: string;
  revisionAfter: string;
  expectedSheetCount: number;
  sheets: F04SheetSnapshot[];
};

function hasValue(value: unknown) {
  return value !== null && value !== undefined && value !== '';
}

function trimTrailingEmpty(values: unknown[]) {
  let length = values.length;
  while (length > 0 && !hasValue(values[length - 1])) length -= 1;
  return values.slice(0, length);
}

function nonEmptyRow(display: unknown[], formula: unknown[]) {
  return display.some(hasValue) || formula.some(hasValue);
}

function validateSnapshot(input: F04WorkbookSnapshot) {
  if (
    input.spreadsheetId !== F04_SPREADSHEET_ID ||
    !input.title.trim() ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    !input.revisionBefore.trim() ||
    !input.revisionAfter.trim() ||
    !Number.isSafeInteger(input.expectedSheetCount) ||
    input.expectedSheetCount < 1 ||
    !Array.isArray(input.sheets)
  ) {
    throw new Error('INVALID_F04_WORKBOOK_SNAPSHOT');
  }

  const sheetIds = new Set<number>();
  const sheetIndexes = new Set<number>();
  for (const sheet of input.sheets) {
    if (
      !Number.isSafeInteger(sheet.sheetId) ||
      !Number.isSafeInteger(sheet.index) ||
      sheetIds.has(sheet.sheetId) ||
      sheetIndexes.has(sheet.index) ||
      !sheet.title.trim() ||
      !Number.isSafeInteger(sheet.rowCount) ||
      sheet.rowCount < 0 ||
      !Number.isSafeInteger(sheet.columnCount) ||
      sheet.columnCount < 0 ||
      !Array.isArray(sheet.displayRows) ||
      (sheet.formulaRows !== undefined && !Array.isArray(sheet.formulaRows))
    ) {
      throw new Error('INVALID_F04_SHEET_SNAPSHOT');
    }
    sheetIds.add(sheet.sheetId);
    sheetIndexes.add(sheet.index);
  }
}

export function buildF04SettlementSourceBatch(
  input: F04WorkbookSnapshot
): SourceIntakeBatch {
  validateSnapshot(input);

  const revisionStable = input.revisionBefore === input.revisionAfter;
  const sheetSetComplete = input.sheets.length === input.expectedSheetCount;
  const captureComplete = revisionStable && sheetSetComplete;
  const records: SourceIntakeBatch['records'] = [];

  for (const sheet of [...input.sheets].sort((a, b) => a.index - b.index)) {
    records.push({
      sourceRecordId: `sheet:${sheet.sheetId}:manifest`,
      payload: {
        recordType: 'SHEET_MANIFEST',
        spreadsheetId: input.spreadsheetId,
        sheetId: sheet.sheetId,
        sheetIndex: sheet.index,
        sheetTitle: sheet.title,
        hidden: sheet.hidden === true,
        grid: { rowCount: sheet.rowCount, columnCount: sheet.columnCount },
      },
    });

    const rowLength = Math.max(
      sheet.displayRows.length,
      sheet.formulaRows?.length ?? 0
    );
    for (let offset = 0; offset < rowLength; offset += 1) {
      const displayValues = trimTrailingEmpty(sheet.displayRows[offset] ?? []);
      const formulaValues = trimTrailingEmpty(sheet.formulaRows?.[offset] ?? []);
      if (!nonEmptyRow(displayValues, formulaValues)) continue;

      const payload = {
        recordType: 'SHEET_ROW',
        spreadsheetId: input.spreadsheetId,
        sheetId: sheet.sheetId,
        sheetIndex: sheet.index,
        sheetTitle: sheet.title,
        hidden: sheet.hidden === true,
        rowNumber: offset + 1,
        displayValues,
        formulaValues,
      };
      records.push({
        sourceRecordId: `sheet:${sheet.sheetId}:row:${offset + 1}`,
        sourceFingerprint: stableDigest(payload),
        payload,
      });
    }
  }

  const checksum = stableDigest({
    spreadsheetId: input.spreadsheetId,
    revision: input.revisionAfter,
    records: records.map((record) => [
      record.sourceRecordId,
      record.sourceFingerprint ?? stableDigest(record.payload),
    ]),
  });

  return {
    laneId: 'SETTLEMENT',
    source: {
      sourceId: F04_SOURCE_ID,
      kind: 'GOOGLE_SHEET',
      displayName: input.title,
      authorityScope: [
        'settlement:source-evidence',
        'settlement:f04-parallel-read',
      ],
      expectedFreshnessSeconds: 60 * 60,
    },
    observedAt: input.observedAt,
    sourceRevision: input.revisionAfter,
    checksum,
    coverage: {
      mode: captureComplete ? 'FULL' : 'PARTIAL',
      completeness: captureComplete ? 'COMPLETE' : 'INCOMPLETE',
      scope: `spreadsheet:${input.spreadsheetId}:all-tabs`,
      note: captureComplete
        ? `Captured ${input.sheets.length} sheets at stable revision ${input.revisionAfter}`
        : `HOLD_SOURCE_PARITY revisionStable=${revisionStable} sheets=${input.sheets.length}/${input.expectedSheetCount}`,
    },
    records,
  };
}
