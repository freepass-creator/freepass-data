/** 의존성 없는 최소 XLSX 읽기(읽기 전용, 네트워크·쓰기 없음) — 공급사가 카톡으로 보낸 재고 파일(마음카 kat747.tmp 등)의 «보이는 값»을 줄·칸으로 꺼낸다.
 * 지원: zip(저장·deflate), workbook.xml 시트 순서·이름, sharedStrings(서식 문자 포함), 일반·인라인 문자열, 숫자, 불리언.
 * 수식은 «캐시된 값»만 본다(계산하지 않음). 병합 셀·서식·숨김은 해석하지 않는다. 숫자는 파일에 저장된 문자열 그대로 둔다(부동소수 변환 없음 — 금액 단위 판단은 호출자).
 * 안전: 항목 수 ≤ 200, 해제 후 총 크기 ≤ 20MB, 시트당 행 ≤ 5,000·열 ≤ 200(한도 초과는 거절). 압축 폭탄·경로 조작 이름은 읽지 않는다. */
import { inflateRawSync } from 'node:zlib';

export type XlsxSheet = { name: string; rows: string[][] };
export class XlsxError extends Error { constructor(readonly code: string) { super(code); this.name = 'XlsxError'; } }

const MAX_ENTRIES = 200, MAX_TOTAL = 20 * 1024 * 1024, MAX_ROWS = 5_000, MAX_COLS = 200;

function readZip(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65_535); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new XlsxError('XLSX_NOT_ZIP');
  const count = buffer.readUInt16LE(eocd + 10), directory = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new XlsxError('XLSX_TOO_MANY_ENTRIES');
  const out = new Map<string, Buffer>();
  let at = directory, total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw new XlsxError('XLSX_ZIP_CORRUPT');
    const method = buffer.readUInt16LE(at + 10), compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.includes('..') || name.startsWith('/') || name.endsWith('/')) continue;
    if (size > MAX_TOTAL) throw new XlsxError('XLSX_TOO_LARGE');   // 신고값은 거절 근거로만 쓴다 — 누적은 «실제 해제 크기»로 센다
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new XlsxError('XLSX_ZIP_CORRUPT');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) {
      // 해제 한도는 남은 한도(누적 기준)로 건다 — 헤더 신고 크기가 작아도 실제 해제가 한도를 넘으면 거절한다(압축 폭탄).
      try { content = inflateRawSync(data, { maxOutputLength: Math.max(1, MAX_TOTAL - total) }); }
      catch { throw new XlsxError('XLSX_TOO_LARGE'); }
    } else throw new XlsxError('XLSX_UNSUPPORTED_COMPRESSION');
    total += content.length;
    if (total > MAX_TOTAL) throw new XlsxError('XLSX_TOO_LARGE');
    if (content.length !== size) throw new XlsxError('XLSX_ZIP_CORRUPT');   // 신고 크기와 실제가 다르면 손상
    out.set(name, content);
  }
  return out;
}

const entity = (text: string) => text
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const textOf = (xml: string) => entity([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => m[1]!).join(''));
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const columnIndex = (ref: string) => {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref.toUpperCase())?.[0] ?? '') n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export function readXlsx(buffer: Buffer): XlsxSheet[] {
  const files = readZip(buffer);
  const need = (name: string) => { const v = files.get(name); if (!v) throw new XlsxError('XLSX_PART_MISSING'); return v.toString('utf8'); };
  const workbook = need('xl/workbook.xml');
  const rels = new Map<string, string>();
  for (const m of need('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }
  const shared: string[] = [];
  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (sharedXml) for (const m of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]!));
  const sheets: XlsxSheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = entity(attr(m[0], 'name') ?? ''), rid = attr(m[0], 'r:id') ?? attr(m[0], 'id');
    const target = rid ? rels.get(rid) : undefined;
    const xml = target ? files.get(target)?.toString('utf8') : undefined;
    if (!name || !xml) continue;
    const rows: string[][] = [];
    for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNumber = Number(attr(rowMatch[1]!, 'r') ?? rows.length + 1);
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROWS) throw new XlsxError('XLSX_TOO_MANY_ROWS');
      const cells: string[] = [];
      for (const c of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const column = columnIndex(attr(c[1]!, 'r') ?? '');
        if (column < 0 || column >= MAX_COLS) { if (column >= MAX_COLS) throw new XlsxError('XLSX_TOO_MANY_COLUMNS'); continue; }
        const type = attr(c[1]!, 't'), body = c[2] ?? '';
        let value = '';
        if (type === 's') {
          // 공유 문자열 색인: 숫자가 아니면(빈 <v></v> 포함) 빈 값이다 — Number('')=0 이 첫 문자열로 읽히지 않게(Codex #670 ③).
          const indexText = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]?.trim() ?? '';
          value = /^\d+$/.test(indexText) ? (shared[Number(indexText)] ?? '') : '';
        }
        else if (type === 'inlineStr') value = textOf(body);
        else if (type === 'b') value = /<v>1<\/v>/.test(body) ? 'TRUE' : 'FALSE';
        else value = entity(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        while (cells.length < column) cells.push('');
        cells[column] = value;
      }
      while (rows.length < rowNumber - 1) rows.push([]);
      rows[rowNumber - 1] = cells;
    }
    sheets.push({ name, rows });
  }
  if (!sheets.length) throw new XlsxError('XLSX_NO_SHEETS');
  return sheets;
}
