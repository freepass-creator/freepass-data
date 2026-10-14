// 손오공 제휴사 차량 API(https://sokrc.com/api/partner/v1) 읽기 전용 집계 — 탭(rent·sub·pick) 직렬 호출, 429 즉시 중단.
// 키는 프로세스 환경변수 SONOGONG_PARTNER_API_KEY 로만 받는다(코드·로그·파일·커밋에 남기지 않는다). 키 배치는 대표 권한.
// 사용: SONOGONG_PARTNER_API_KEY=... node scripts/ops/sonogong-partner-api-count.mjs [--out <번호 csv 경로>]
// 출력: 탭별 N·hasActiveContract:true N·사진 있음 N·고유 차량번호 N, 번호 csv(끝4가 아닌 전체 번호 — 저장소 밖 개인 경로에만).
import { writeFileSync } from 'node:fs';

const key = process.env.SONOGONG_PARTNER_API_KEY;
if (!key) { console.error('SONOGONG_PARTNER_API_KEY 환경변수가 없다 — 키는 대표가 둔다'); process.exit(2); }
const base = 'https://sokrc.com/api/partner/v1';
const outAt = process.argv.indexOf('--out');
const outPath = outAt > 0 ? process.argv[outAt + 1] : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tabs = ['rent', 'sub', 'pick'];
const summary = {}, plates = new Map();
for (const tab of tabs) {
  let page = 1, totalPages = 1, n = 0, active = 0, withPhoto = 0;
  while (page <= totalPages) {
    const url = `${base}/vehicles?tab=${tab}&page=${page}&pageSize=50`;
    const res = await fetch(url, { headers: { 'x-partner-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429) { console.error(`429 중단 tab=${tab} page=${page}`); process.exit(3); }
    if (!res.ok) { console.error(`HTTP ${res.status} tab=${tab} page=${page}`); process.exit(4); }
    const body = await res.json();
    if (body.success === false) { console.error('API 오류', body.error?.statusCode, body.error?.message); process.exit(5); }
    totalPages = Number(body.attrs?.totalPages ?? 1);
    for (const v of body.data ?? []) {
      n++; if (v.hasActiveContract === true) active++;
      const hasPhoto = Array.isArray(v.images) ? v.images.length > 0 : !!v.thumbnailUrl;
      if (hasPhoto) withPhoto++;
      const plate = String(v.carNumber ?? '').replace(/\s+/g, '');
      if (plate) { const e = plates.get(plate) ?? { tabs: new Set(), active: false }; e.tabs.add(tab); e.active ||= v.hasActiveContract === true; plates.set(plate, e); }
    }
    page++;
    await sleep(1000);   // 직렬·간격
  }
  summary[tab] = { total: n, hasActiveContract: active, withPhoto };
}
console.log(JSON.stringify({ at: new Date().toISOString(), tabs: summary, uniquePlates: plates.size }));
if (outPath) writeFileSync(outPath, ['carNumber,tabs,hasActiveContract', ...[...plates].map(([p, e]) => `${p},${[...e.tabs].join('|')},${e.active}`)].join('\n'), 'utf8');
