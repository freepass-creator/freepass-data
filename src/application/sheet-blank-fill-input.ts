import type { SheetBlankFillInput } from './sheet-blank-fill.js';

type Cell = string | number | null;

export type SheetBlankFillRawInput = {
  spreadsheetId: string;
  capturedAt: string;
  tabs: Record<string, {
    headerRow: Cell[];
    valueRows: Cell[][];
    formulaRows: string[][];
  }>;
  checkRows: Array<Array<string | number>>;
  tabIds: Record<string, number>;
  products: Record<string, Record<string, unknown>>;
  policies: Record<string, Record<string, unknown>>;
};

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');
const present = (value: unknown) => value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
const plainNumber = (value: unknown) => typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()));

const VEHICLE_FIELD_MAP: Record<string, string> = {
  maker: 'maker',
  model: 'model',
  sub_model: 'sub_model',
  trim_name: 'trim_name',
  year: 'year',
  engine_cc: 'engine_cc',
  fuel_type: 'fuel_type',
  seats: 'seats',
  drive_type: 'drivetrain',
  origin: 'origin',
};
const NUMBER_FIELDS = new Set(['year', 'engine_cc', 'seats']);

function assertTabShape(tab: string, valueRows: Cell[][], formulaRows: string[][]): void {
  if (valueRows.length !== formulaRows.length) throw new Error('SHEET_BLANK_FILL_INPUT_SHAPE');
  for (let row = 0; row < valueRows.length; row++) {
    if (!Array.isArray(valueRows[row]) || !Array.isArray(formulaRows[row]) || valueRows[row]!.length !== formulaRows[row]!.length) {
      throw new Error('SHEET_BLANK_FILL_INPUT_SHAPE');
    }
    for (const formula of formulaRows[row]!) {
      if (typeof formula !== 'string') throw new Error('SHEET_BLANK_FILL_INPUT_SHAPE');
    }
  }
  if (!tab.trim()) throw new Error('SHEET_BLANK_FILL_INPUT_SHAPE');
}

function buildVehicles(products: Record<string, Record<string, unknown>>): SheetBlankFillInput['vehicles'] {
  const vehicles: SheetBlankFillInput['vehicles'] = {};
  for (const [plate, product] of Object.entries(products)) {
    if (!plate.trim()) continue;
    const reviewStatus = text(product['검수상태']);
    const confirmed = product['확정'] === true && reviewStatus === '확정';
    const fields: Record<string, string | number> = {};
    for (const [source, target] of Object.entries(VEHICLE_FIELD_MAP)) {
      const value = product[source];
      if (!present(value)) continue;
      if (NUMBER_FIELDS.has(source)) {
        if (plainNumber(value)) fields[target] = typeof value === 'number' ? value : String(value).trim();
        else fields[target] = String(value);
      } else {
        fields[target] = typeof value === 'number' ? value : String(value).trim();
      }
    }
    vehicles[plate] = {
      confirmed,
      evidence: `프리패스 데이터 products 확정(검수상태 ${reviewStatus || '미기재'})`,
      ...(confirmed ? {} : { needsConfirmation: [] }),
      fields,
    };
  }
  return vehicles;
}

function indexByHeader(header: Array<string | number>): Map<string, number> {
  const out = new Map<string, number>();
  header.forEach((value, index) => {
    const key = text(value);
    if (key && !out.has(key)) out.set(key, index);
  });
  return out;
}

function buildPolicyLinks(raw: SheetBlankFillRawInput, tabs: SheetBlankFillInput['tabs']): SheetBlankFillInput['policyLinks'] {
  const links: SheetBlankFillInput['policyLinks'] = {};
  if (!raw.checkRows.length) return links;
  const checkHeader = indexByHeader(raw.checkRows[0] ?? []);
  const tabCol = checkHeader.get('공급사탭ID');
  const rowCol = checkHeader.get('원본행');
  const statusCol = checkHeader.get('상태');
  const codeCol = checkHeader.get('정책코드');
  if (tabCol === undefined || rowCol === undefined || statusCol === undefined || codeCol === undefined) return links;
  const tabNameById = new Map(Object.entries(raw.tabIds).map(([tab, id]) => [String(id), tab]));
  for (const row of raw.checkRows.slice(1)) {
    if (text(row[statusCol]) !== 'MATCHED') continue;
    const tab = tabNameById.get(text(row[tabCol]));
    const sourceRow = Number(row[rowCol]);
    const code = text(row[codeCol]);
    if (!tab || !tabs[tab] || !Number.isSafeInteger(sourceRow) || sourceRow < 2 || !code) continue;
    const plateCol = ['차량번호', '李⑤웾踰덊샇'].map((header) => tabs[tab]!.headers.indexOf(header)).find((index) => index >= 0) ?? -1;
    if (plateCol < 0) continue;
    const sheetRow = tabs[tab].rows.find((item) => item.row === sourceRow);
    const plate = text(sheetRow?.values[plateCol]);
    if (!plate) continue;
    const product = raw.products[plate];
    if (!product || text(product.policy_code) !== code) continue;
    links[`${tab}:${sourceRow}`] = { code, plate };
  }
  return links;
}

export function buildSheetBlankFillInput(raw: SheetBlankFillRawInput): SheetBlankFillInput {
  const tabs: SheetBlankFillInput['tabs'] = {};
  for (const [tab, sheet] of Object.entries(raw.tabs)) {
    assertTabShape(tab, sheet.valueRows, sheet.formulaRows);
    tabs[tab] = {
      headers: sheet.headerRow.map((value) => (value === null ? '' : String(value))),
      rows: sheet.valueRows.map((values, index) => ({
        row: index + 2,
        values,
        formulaCols: sheet.formulaRows[index]!.flatMap((value, col) => value.startsWith('=') ? [col] : []),
      })),
    };
  }
  return {
    spreadsheetId: raw.spreadsheetId,
    capturedAt: raw.capturedAt,
    tabs,
    vehicles: buildVehicles(raw.products),
    policyLinks: buildPolicyLinks(raw, tabs),
    policies: raw.policies,
  };
}
