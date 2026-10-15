import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readXlsx, XlsxError } from '../src/adapters/xlsx-reader.js';
import { cellKind, maskCell, previewSupplierXlsx } from '../src/jobs/preview-supplier-xlsx.js';

// 합성 XLSX(실제 공급사 파일이 아님): 최소 zip 작성기 + 마음카 파일과 같은 «모양»(제목 줄·머리글·열 어긋남·차량번호는 둘째 시트에만).
const crc32 = (buf: Buffer) => {
  let c, crc = ~0;
  for (const byte of buf) { c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
};
function zip(files: Record<string, string>, store = false): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8'), data = store ? raw : deflateRawSync(raw), nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(store ? 0 : 8, 10);
    entry.writeUInt32LE(crc32(raw), 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(nameBuf.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const strings = ['마춤카 신차 렌터카 선출고 및 출고가능 차량 리스트', 'NO', '차량명', '카니발 하이브리드 노블레스', '즉시', 'A & B <옵션>', '***5355', '90/90'];
const sharedStrings = `<sst>${strings.map(s => `<si><t>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`).join('')}<si><r><t>리치</t></r><r><t>텍스트</t></r></si></sst>`;
const sheet1 = `<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c></row>
  <row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="s"><v>2</v></c></row>
  <row r="4"><c r="A4"><v>1</v></c><c r="B4" t="s"><v>3</v></c><c r="D4" t="inlineStr"><is><t>화이트</t></is></c><c r="G4"><v>4609</v></c><c r="H4"><v>0.1</v></c><c r="L4" t="s"><v>4</v></c></row>
</sheetData></worksheet>`;
const sheet2 = `<worksheet><sheetData>
  <row r="1"><c r="A1"><v>5</v></c><c r="B1" t="s"><v>3</v></c><c r="F1" t="s"><v>5</v></c><c r="I1" t="s"><v>7</v></c><c r="M1" t="s"><v>6</v></c><c r="N1" t="s"><v>8</v></c></row>
</sheetData></worksheet>`;
const workbook = `<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/><sheet name="재고(차량번호 있음)" sheetId="2" r:id="rId2"/></sheets></workbook>`;
const rels = `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="/xl/worksheets/sheet2.xml"/></Relationships>`;
const build = (store = false) => zip({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': rels, 'xl/sharedStrings.xml': sharedStrings,
  'xl/worksheets/sheet1.xml': sheet1, 'xl/worksheets/sheet2.xml': sheet2 }, store);

describe('XLSX 읽기(의존성 없음)', () => {
  it('reads sheet order/names, shared/inline strings (entities, rich text), numbers kept as stored text, sparse rows and columns', () => {
    for (const store of [false, true]) {
      const sheets = readXlsx(build(store));
      expect(sheets.map(s => s.name)).toEqual(['Sheet1', '재고(차량번호 있음)']);
      expect(sheets[0]!.rows[0]![0]).toBe('마춤카 신차 렌터카 선출고 및 출고가능 차량 리스트');
      expect(sheets[0]!.rows[2]!.slice(0, 2)).toEqual(['NO', '차량명']);
      expect(sheets[0]!.rows[1]).toEqual([]);                           // 비어 있는 줄(빈 배열)
      expect(sheets[0]!.rows[3]).toEqual(['1', '카니발 하이브리드 노블레스', '', '화이트', '', '', '4609', '0.1', '', '', '', '즉시']);
      expect(sheets[1]!.rows[0]![5]).toBe('A & B <옵션>');
      expect(sheets[1]!.rows[0]![8]).toBe('90/90');
      expect(sheets[1]!.rows[0]![12]).toBe('***5355');
      expect(sheets[1]!.rows[0]![13]).toBe('리치텍스트');
    }
  });

  it('rejects non-zip bytes, corrupt zips, missing parts and unsupported archives without guessing', () => {
    expect(() => readXlsx(Buffer.from('not a zip at all'))).toThrow(XlsxError);
    expect(() => readXlsx(Buffer.alloc(0))).toThrow('XLSX_NOT_ZIP');
    expect(() => readXlsx(zip({ 'hello.txt': 'x' }))).toThrow('XLSX_PART_MISSING');
    const broken = build(); broken.writeUInt32LE(0, 0);   // 지역 헤더 서명 깨짐
    expect(() => readXlsx(broken)).toThrow('XLSX_ZIP_CORRUPT');
  });
});

describe('공급사 XLSX 구조 미리보기(비식별)', () => {
  it('masks plates to the last 4 digits and phone-like text, classifies cell shapes without guessing units/meanings', () => {
    expect(maskCell('서울 12가3456 차')).toBe('서울 ****3456 차');
    expect(maskCell('123가 4567')).toBe('****4567');
    expect(maskCell('문의 010-1234-5678')).toBe('문의 [전화]');
    expect(maskCell('x'.repeat(100)).length).toBe(60);
    expect([cellKind(''), cellKind('91'), cellKind('0.1'), cellKind('90/90'), cellKind('2026-09-22'), cellKind('9/9(마음카)'), cellKind('***5355'), cellKind('즉시')])
      .toEqual(['empty', 'int', 'decimal', 'slash', 'date', 'date', 'plate', 'text']);
  });

  it('previews sheets with filled counts and masked cells; no output contains a full plate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlsx-preview-'));
    try {
      const file = join(dir, 'synthetic.xlsx');
      await writeFile(file, build());
      const preview = await previewSupplierXlsx(file, 10);
      expect(preview.map(p => [p.sheet, p.rowCount])).toEqual([['Sheet1', 3], ['재고(차량번호 있음)', 1]]);
      const second = preview[1]!.rows[0]!;
      expect(second.cells.find(c => c.col === 12)).toMatchObject({ kind: 'plate', text: '***5355' });
      expect(second.cells.find(c => c.col === 8)).toMatchObject({ kind: 'slash', text: '90/90' });
      expect(JSON.stringify(preview)).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
