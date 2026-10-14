// 손오공 API 사진 URL 직접 열림 확인(읽기 전용, 표본 N건): 인증·Referer 없이 브라우저처럼 열리는지 상태 코드·헤더 «종류»만 낸다.
//   node scripts/ops/sonogong-photo-url-probe.mjs [--samples 5] [--tab sub]
// 필요: SONOGONG_API_KEY, SONOGONG_API_BASE (환경 변수, 출력·로그에 남기지 않음), dist 빌드.
// 호출량: 목록 1페이지(≤5건) + 상세 N건 + 사진 URL N×2 (직렬·간격 1.5초, 상한 표본 10). 사진 본문은 받지 않는다(Range 0-0).
// 출력: 표본별 상태·콘텐츠 유형·서명성 쿼리 여부·캐시 헤더 «종류» 와 묶음 판정(URL_AS_IS / COPY_TO_DRIVE). URL·키·번호는 출력하지 않는다.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const samples = Math.max(1, Math.min(10, Number(arg('--samples', '5'))));
const tab = ['rent', 'sub', 'pick'].includes(arg('--tab', 'sub')) ? arg('--tab', 'sub') : 'sub';
const load = async (rel) => import(pathToFileURL(join(process.cwd(), 'dist', 'src', ...rel)).href);
const { createSonogongApiClient } = await load(['adapters', 'sonogong-api.js']);
const { isSignedLooking, summarizePhotoUrlProbe, classifyPhotoUrlSample } = await load(['adapters', 'sonogong-photo-probe.js']);
const apiBase = (process.env.SONOGONG_API_BASE ?? '').trim();
const client = createSonogongApiClient({ base: apiBase, key: process.env.SONOGONG_API_KEY ?? '' });
const apiHost = new URL(apiBase).hostname;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { data } = await client.get('/vehicles', { tab, page: 1, pageSize: samples });
const rows = (Array.isArray(data) ? data : data?.items ?? data?.vehicles ?? data?.list ?? data?.rows ?? []).slice(0, samples);
const results = [];
for (const row of rows) {
  const { data: detail } = await client.get(`/vehicles/${encodeURIComponent(String(row.id))}`);
  const image = Array.isArray(detail?.images) ? detail.images.map(i => (i && typeof i === 'object' ? i.url : i)).find(u => typeof u === 'string' && /^https:\/\//.test(u)) : null;
  if (!image) { results.push({ noImage: true }); continue; }
  const probe = async headers => {
    try {
      const res = await fetch(image, { method: 'GET', headers: { range: 'bytes=0-0', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      await res.body?.cancel().catch(() => undefined);
      return res;
    } catch { return null; }
  };
  await sleep(1500);
  const plain = await probe({});
  await sleep(1500);
  const withReferer = await probe({ referer: 'https://freepasserp.com/' });
  const first = plain ?? withReferer;
  const headerOf = (name) => first?.headers.get(name) ?? null;
  const length = Number(headerOf('content-length'));
  const sample = {
    statusPlain: plain?.status ?? 0, statusWithReferer: withReferer?.status ?? 0,
    contentType: headerOf('content-type')?.split(';')[0] ?? null, contentLength: Number.isFinite(length) ? length : null,
    cacheControl: headerOf('cache-control'), expires: headerOf('expires'),
    signedLooking: isSignedLooking(image), sameHostAsApi: new URL(image).hostname === apiHost,
    redirected: !!plain && plain.status >= 300 && plain.status < 400,
    corsOpen: ['*', 'https://freepasserp.com'].includes(headerOf('access-control-allow-origin') ?? ''),
  };
  results.push({ ...sample, verdict: classifyPhotoUrlSample(sample) });
}
const measured = results.filter(r => !r.noImage);
const summary = summarizePhotoUrlProbe(measured);
console.log(JSON.stringify({ tab, requested: samples, withImage: measured.length, withoutImage: results.length - measured.length,
  ...summary, samples: measured.map(r => ({ statusPlain: r.statusPlain, statusWithReferer: r.statusWithReferer, contentType: r.contentType,
    contentLength: r.contentLength, signedLooking: r.signedLooking, expires: r.expires !== null, cacheControlMaxAge: /max-age=(\d+)/.exec(r.cacheControl ?? '')?.[1] ?? null,
    sameHostAsApi: r.sameHostAsApi, redirected: r.redirected, corsOpen: r.corsOpen, verdict: r.verdict })) }, null, 2));
