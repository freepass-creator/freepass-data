// 공급사 원본 ↔ 프리패스 데이터 항목 단위 비교 — 순수 함수. 읽기 전용 도구 scripts/supplier-value-parity.mjs 가 쓴다.
// 결과 분류(항목마다): match 일치 · normalized 정제 차이(양쪽 값 있음, 정제 규칙의 결과일 수 있음) · mismatch 불일치/누락 · sourceBlank 원본 빈칸.
// 원문 보존 항목(raw)은 정제 차이를 허용하지 않는다 — 다르면 mismatch. 차량번호는 마지막 4자리만 예시로 내보낸다.

const squash = v => String(v ?? '').replace(/[\s \t]+/g, '').toLowerCase();
const digits = v => String(v ?? '').replace(/[^\d]/g, '');
const blank = v => { const s = squash(v); return s === '' || s === '-' || s === '무보증'; };
export const plateKey = v => String(v ?? '').replace(/\s+/g, '');

export function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  return null;
}
export const decodeFields = fields => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]));

// Preserve all comparison inputs, including the complete raw and period-price maps.
// Photo archives and unrelated stored metadata must not cross this diagnostic boundary.
export const PARITY_PRODUCT_FIELDS = Object.freeze([
  'provider_company_code', 'partner_code', 'car_number', 'listable', 'status_label_raw',
  '원문', 'options', 'mileage', 'maker', 'model', 'fuel_type', 'ext_color', 'int_color',
  'product_type', 'engine_cc', 'consumer_price', 'first_registration_date', 'price', 'year',
]);

export function parityProductPageQuery(pageToken = '') {
  const query = new URLSearchParams({ pageSize: '300' });
  for (const field of PARITY_PRODUCT_FIELDS) query.append('mask.fieldPaths', /^[A-Za-z_][A-Za-z_0-9]*$/.test(field) ? field : '`' + field + '`');
  if (pageToken) query.set('pageToken', pageToken);
  return query;
}

// One CLI invocation, one complete product observation. Rejections remain rejected:
// never compare a partial page or silently retry a failed scan for the next supplier.
export function createSupplierProductReader(loadProducts) {
  let observation;
  return async code => {
    observation ??= Promise.resolve().then(loadProducts);
    return (await observation).filter(f => (f.provider_company_code || f.partner_code) === code);
  };
}

// 날짜: "23-6-5"·"25-03"·"2023-06-05"·"2023.6.5" → {y, m, d?}
export function parseDate(v) {
  const m = /^(\d{2}|\d{4})\D+(\d{1,2})(?:\D+(\d{1,2}))?/.exec(String(v ?? '').trim());
  if (!m) return null;
  const y = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
  return { y, m: Number(m[2]), d: m[3] ? Number(m[3]) : null };
}
const sameDate = (a, b) => a && b && a.y === b.y && a.m === b.m && (a.d == null || b.d == null || a.d === b.d);

const PERIODS = ['1', '3', '6', '12', '24', '36', '48', '60'];
const rentOf = (price, p) => digits(price?.[p]?.rent);
const depositOf = (price, p) => digits(price?.[p]?.deposit);

// 항목 정의: kind raw(원문 그대로) | refined(정제값) | number | date. data(f) 는 Data 값, src(c) 는 원본 값.
const textRaw = (field, srcCol, data) => ({ field, kind: 'raw', src: c => c[srcCol], data });
const textRefined = (field, srcCol, data, vk = 'contain') => ({ field, kind: 'refined', vk, src: c => c[srcCol], data });
const num = (field, srcCol, data) => ({ field, kind: 'number', src: c => c[srcCol], data });
const date = (field, srcCol, data) => ({ field, kind: 'date', src: c => c[srcCol], data });
const rent = (field, srcCol, period) => ({ field, kind: 'number', src: c => c[srcCol], data: f => rentOf(f.price, period) });
const dep = (field, srcCol, period) => ({ field, kind: 'number', src: c => c[srcCol], data: f => depositOf(f.price, period) });

export const FIELD_MAPS = Object.freeze({
  aica: { plate: '차량번호', fields: [
    textRaw('상태(status_label_raw)', '배차상태', f => f.status_label_raw),
    textRaw('차명 원문(원문.차명)', '트림', f => f['원문']?.['차명']),
    textRaw('옵션 원문(options)', '옵션', f => f.options),
    textRaw('주행거리(mileage)', 'Km', f => f.mileage),
    textRefined('제조사(maker)', '제조사', f => f.maker, 'maker'),
    textRefined('차종(model)', '차종분류', f => f.model),
    textRefined('연료(fuel_type)', '연료', f => f.fuel_type, 'fuel'),
    textRefined('외장색(ext_color)', '외장', f => f.ext_color),
    textRefined('내장색(int_color)', '내장', f => f.int_color),
    textRefined('구분(product_type)', '구분', f => f.product_type),
    num('배기량(engine_cc)', '배기량', f => f.engine_cc),
    num('소비자가격(consumer_price)', '소비자가격', f => f.consumer_price),
    date('최초등록(first_registration_date)', '최초등록', f => f.first_registration_date),
    rent('월렌트 36개월', '36개월', '36'), rent('월렌트 48개월', '48개월', '48'), rent('월렌트 60개월', '60개월', '60'), rent('1개월(월렌트)', '월렌트', '1'),
    dep('보증금(48개월 기준)', '장기보증', '48')
  ] },
  billincar: { plate: '차량번호', fields: [
    textRaw('상태(status_label_raw)', '상태', f => f.status_label_raw),
    textRaw('차명 원문(원문.차명)', '차명(세부모델+트림)', f => f['원문']?.['차명(세부모델+트림)'] ?? f['원문']?.['차명']),
    textRaw('옵션 원문(options)', '옵션', f => f.options),
    textRaw('주행거리(mileage)', '주행거리', f => f.mileage),
    textRefined('제조사(maker)', '제조사', f => f.maker, 'maker'),
    textRefined('모델(model)', '모델명', f => f.model),
    textRefined('연료(fuel_type)', '연료', f => f.fuel_type, 'fuel'),
    textRefined('외장색(ext_color)', '외부색상', f => f.ext_color),
    textRefined('내장색(int_color)', '내부색상', f => f.int_color),
    textRefined('분류(product_type)', '분류', f => f.product_type),
    num('연식(year)', '연식', f => f.year),
    num('배기량(engine_cc)', '배기량', f => f.engine_cc),
    num('차량가격(consumer_price)', '차량가격', f => f.consumer_price),
    date('최초등록(first_registration_date)', '최초등록일', f => f.first_registration_date),
    rent('1개월', '1개월', '1'), rent('12개월', '12개월', '12'), rent('24개월', '24개월', '24'), rent('36개월', '36개월', '36'), rent('48개월', '48개월', '48'), rent('60개월', '60개월', '60'),
    dep('단기보증(1개월 보증금)', '단기보증', '1'), dep('장기보증(24개월 보증금)', '장기보증', '24')
  ] }
});


// 정제 차이는 «검증된 변환»만 인정한다: 제조사 = 같은 제조사의 표기 차이(별칭 묶음), 연료 = 같은 연료군, 그 밖 = 한쪽이 다른 쪽을 포함할 때만.
const MAKER_GROUPS = [['현대','현대자동차','hyundai'], ['기아','기아자동차','kia'], ['제네시스','genesis'], ['쉐보레','쉐보레(한국gm)','한국gm','chevrolet'],
  ['르노','르노(삼성)','르노코리아','르노코리아(삼성)','르노삼성','삼성','renault'], ['kgm','kg모빌리티','kg모빌리티(쌍용)','쌍용','ssangyong']];
const FUEL_GROUPS = [['가솔린','휘발유','gasoline','가솔린터보'], ['디젤','경유','diesel'], ['lpg','lpi','엘피지','lpe'], ['하이브리드','hev','hybrid','가솔린하이브리드','phev'], ['전기','ev','electric','전기차']];
const groupOf = (groups, v, allowContain = false) => {
  const k = squash(v);
  const exact = groups.findIndex(g => g.some(x => squash(x) === k));
  if (exact >= 0 || !allowContain) return exact;
  const part = groups.map((g, i) => (g.some(x => squash(x).length >= 3 && k.includes(squash(x))) ? i : -1)).filter(i => i >= 0);
  return part.length === 1 ? part[0] : -1;
};
const REFINE_CHECKS = {
  maker: (a, b) => { const x = groupOf(MAKER_GROUPS, a, true), y = groupOf(MAKER_GROUPS, b, true); return x >= 0 && x === y; },
  fuel: (a, b) => { const x = groupOf(FUEL_GROUPS, a), y = groupOf(FUEL_GROUPS, b); return x >= 0 && x === y; },
  contain: (a, b) => { const x = squash(a), y = squash(b); return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)); }
};
function judge(def, srcRaw, dataRaw) {
  if (def.kind === 'number') {
    const s = digits(srcRaw), d = digits(dataRaw);
    if (blank(srcRaw) || s === '') return d === '' || d === '0' ? 'blankBoth' : 'extra'; // 원본 빈칸인데 Data 에 값
    return s === d ? 'match' : d === '' ? 'mismatch' : 'mismatch';
  }
  if (def.kind === 'date') {
    if (blank(srcRaw)) return blank(dataRaw) ? 'blankBoth' : 'extra';
    const a = parseDate(srcRaw), b = parseDate(dataRaw);
    return sameDate(a, b) ? 'match' : !b ? 'mismatch' : 'mismatch';
  }
  if (blank(srcRaw)) return blank(dataRaw) ? 'blankBoth' : 'extra';
  if (def.kind === 'raw') {
    // 원문 보존 항목: 글자 그대로(앞뒤 공백만 허용)여야 match. 공백·대소문자만 다르면 «형식 차이»(normalized, exactRate 에서 제외), 그 밖은 mismatch.
    if (String(srcRaw).trim() === String(dataRaw ?? '').trim()) return 'match';
    return squash(srcRaw) === squash(dataRaw) ? 'normalized' : 'mismatch';
  }
  if (squash(srcRaw) === squash(dataRaw)) return 'match';
  if (def.kind === 'refined') return !blank(dataRaw) && REFINE_CHECKS[def.vk ?? 'contain'](srcRaw, dataRaw) ? 'normalized' : 'mismatch';
  return 'mismatch';
}

export const _judgeForTest = (...a) => judge(...a);
export function compareSupplier({ map, sourceRows, products, samples = 3 }) {
  const srcByPlate = new Map();
  for (const r of sourceRows) {
    const p = plateKey(r.cells[map.plate]);
    if (p) srcByPlate.set(p, r); // 같은 번호가 여러 탭이면 마지막 행(아래쪽)이 이긴다 — 중복은 duplicates 로 센다
  }
  const dupPlates = sourceRows.filter(r => plateKey(r.cells[map.plate])).length - srcByPlate.size;
  const dataByPlate = new Map(products.map(f => [plateKey(f.car_number), f]));
  const both = [...srcByPlate.keys()].filter(p => dataByPlate.has(p));
  const fields = map.fields.map(def => {
    const acc = { field: def.field, kind: def.kind, compared: 0, match: 0, normalized: 0, mismatch: 0, extra: 0, sourceBlank: 0, examples: [] };
    for (const p of both) {
      const res = judge(def, def.src(srcByPlate.get(p).cells), def.data(dataByPlate.get(p)));
      if (res === 'blankBoth') { acc.sourceBlank++; continue; }
      acc.compared++;
      if (res === 'match') acc.match++;
      else {
        acc[res]++;
        if (acc.examples.length < samples && res !== 'normalized' || (res === 'normalized' && acc.examples.length < samples))
          acc.examples.push(`${res}:${p.slice(-4)} 원본「${String(def.src(srcByPlate.get(p).cells)).slice(0, 40)}」→ Data「${String(def.data(dataByPlate.get(p)) ?? '').slice(0, 40)}」`);
      }
    }
    return { ...acc, rate: acc.compared ? +((acc.match + acc.normalized) / acc.compared).toFixed(3) : null,
      exactRate: acc.compared ? +(acc.match / acc.compared).toFixed(3) : null };
  });
  return { sourceRows: sourceRows.length, sourcePlates: srcByPlate.size, duplicatePlatesInSource: dupPlates, dataProducts: products.length, both: both.length,
    onlySource: [...srcByPlate.keys()].filter(p => !dataByPlate.has(p)).map(p => p.slice(-4)),
    onlyData: [...dataByPlate.keys()].filter(p => !srcByPlate.has(p)).length,
    // 원본에서 사라졌는데 Data 가 아직 판매 중으로 둔 차 — 사라짐 자체를 퇴역 근거로 쓰지 않는다(공급사 확인 동선 대상).
    onlyDataListable: [...dataByPlate.entries()].filter(([p, f]) => !srcByPlate.has(p) && f.listable === true).length, fields };
}
