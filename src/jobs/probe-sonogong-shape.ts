/** 손오공 파트너 API 응답 «모양» 확인(읽기 전용, 쓰기 0): 탭별 1대의 목록 행·상세에서 키 경로와 값 타입만 꺼낸다(대표 질문 «API 가 제공하는 정보가 뭐뭐냐»).
 *   SONOGONG_API_BASE / SONOGONG_API_KEY 환경변수 필요. node dist/src/jobs/probe-sonogong-shape.js [--out <shape.json>]
 * 안전: 직렬·최소 간격·재시도 0(기존 클라이언트). 출력에 키·주소·차량번호·금액 값은 없다 — 키 경로와 타입만, 그리고 options 배열의 «이름 문자열»(숫자 3자리 이상은 # 로 가림)
 * 최대 20개, carDescription 은 길이와 «금액·전화번호 꼴 포함 여부»만(본문은 출력하지 않음). */
import { writeFile } from 'node:fs/promises';
import { createSonogongApiClient, SONOGONG_API_TABS, type SonogongApiClient } from '../adapters/sonogong-api.js';

type Shape = Record<string, string>;
const typeOf = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/** 객체를 키 경로 → 타입 목록으로 편다. 배열은 길이와 «항목 모양의 합집합»(최대 3단계, 항목 최대 5개). */
export function shapeOf(value: unknown, prefix = '', depth = 0, out: Shape = {}): Shape {
  if (depth > 3) return out;
  if (Array.isArray(value)) {
    out[prefix || '$'] = `array(${value.length})`;
    for (const item of value.slice(0, 5)) {
      if (item && typeof item === 'object') shapeOf(item, `${prefix}[]`, depth + 1, out);
      else out[`${prefix}[]`] = [...new Set([out[`${prefix}[]`], typeOf(item)].filter(Boolean))].join('|');
    }
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') shapeOf(v, key, depth + 1, out);
      else out[key] = typeOf(v);
    }
    return out;
  }
  out[prefix || '$'] = typeOf(value);
  return out;
}

const maskDigits = (s: string) => s.replace(/\d{3,}/g, '#').slice(0, 40);
export function optionNames(options: unknown): { count: number; itemKind: string; names: string[] } {
  if (!Array.isArray(options)) return { count: 0, itemKind: typeOf(options), names: [] };
  const kinds = [...new Set(options.map(o => typeOf(o)))].join('|') || 'none';
  const names = options.flatMap(o => typeof o === 'string' ? [o]
    : o && typeof o === 'object' ? ['name', 'optionName', 'title', 'label'].flatMap(k => typeof (o as Record<string, unknown>)[k] === 'string' ? [String((o as Record<string, unknown>)[k])] : []).slice(0, 1) : []);
  return { count: options.length, itemKind: kinds, names: names.slice(0, 20).map(maskDigits) };
}
export function descriptionFlags(text: unknown) {
  const s = typeof text === 'string' ? text : '';
  return { type: typeOf(text), length: s.length, hasMoneyLike: /\d[\d,]*\s*(?:원|만원|%)/.test(s), hasPhoneLike: /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/.test(s) };
}

export async function probeSonogongShape(client: Pick<SonogongApiClient, 'get'>) {
  const result: Record<string, unknown> = {};
  for (const tab of SONOGONG_API_TABS) {
    const list = await client.get('/vehicles', { tab, page: 1, pageSize: 5 });
    const rows = Array.isArray(list.data) ? list.data : (list.data && typeof list.data === 'object'
      ? (['items', 'vehicles', 'list', 'rows', 'content'] as const).map(k => (list.data as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined : undefined) ?? [];
    // 상세가 있는 첫 행 하나를 쓴다(사진·옵션이 있는 차를 우선).
    const row = (rows.find(r => r && typeof r === 'object' && Array.isArray((r as Record<string, unknown>).images)
      && ((r as Record<string, unknown>).images as unknown[]).length) ?? rows[0]) as Record<string, unknown> | undefined;
    if (!row) { result[tab] = { listRowKeys: null, note: 'EMPTY_TAB' }; continue; }
    const id = typeof row.id === 'number' || typeof row.id === 'string' ? String(row.id) : null;
    const detail = id ? (await client.get(`/vehicles/${encodeURIComponent(id)}`)).data : null;
    const d = (detail && typeof detail === 'object' ? detail : {}) as Record<string, unknown>;
    result[tab] = {
      listPageAttrs: Object.keys(list.attrs).sort(),
      listRow: shapeOf(row), detail: shapeOf(d),
      options: optionNames(d.options), carDescription: descriptionFlags(d.carDescription),
    };
  }
  return result;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('probe-sonogong-shape.js')) {
  const out = process.argv.indexOf('--out') >= 0 ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
  const base = process.env.SONOGONG_API_BASE?.trim(), key = process.env.SONOGONG_API_KEY?.trim();
  if (!base || !key) { console.error('SONOGONG_API_NOT_CONFIGURED'); process.exitCode = 1; }
  else probeSonogongShape(createSonogongApiClient({ base, key })).then(async result => {
    const text = JSON.stringify({ at: new Date().toISOString(), tabs: result }, null, 1);
    if (out) await writeFile(out, text, { mode: 0o600 }); else console.log(text);
  }).catch(e => { console.error(e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'PROBE_FAILED'); process.exitCode = 1; });
}
