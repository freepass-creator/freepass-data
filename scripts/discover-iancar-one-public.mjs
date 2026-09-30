const ORIGIN = 'https://xn--le5bt3bwxk.com';
const timeout = (ms = 20000) => AbortSignal.timeout(ms);
const headers = { 'user-agent': 'FreePassData/1 public-one-api-discovery', accept: 'text/html,application/javascript,*/*' };

function sameOriginUrl(path) {
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error('CROSS_ORIGIN_ASSET_REJECTED');
  return url;
}
async function text(url) {
  const res = await fetch(url, { method: 'GET', redirect: 'manual', cache: 'no-store', signal: timeout(), headers });
  if (res.status >= 300 && res.status < 400) throw new Error(`REDIRECT_${res.status}_${new URL(url).pathname}`);
  if (!res.ok) throw new Error(`HTTP_${res.status}_${new URL(url).pathname}`);
  return res.text();
}
const unique = xs => [...new Set(xs)].sort();
const endpointPattern = /(?:https:\/\/[^"'\s)]+)?\/api\/[A-Za-z0-9_?&=./:%{}$-]+/g;
const routePattern = /(?:^|["'`])((?:\/|https:\/\/)[^"'\s]{0,160}(?:one|openapi|swagger|rate|quote|inventory|vehicle|photo|policy|contract|term|mileage)[^"'\s]{0,160})/gi;
const authPattern = /(?:x-api-key|api[-_]?key|authorization|bearer)/gi;

const html = await text(ORIGIN + '/');
const srcs = unique([...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]))
  .filter(src => {
    try { return sameOriginUrl(src).pathname.match(/\.(?:js|mjs)(?:$|\?)/); } catch { return false; }
  })
  .slice(0, 80);

const publicEndpoints = new Set(html.match(endpointPattern) ?? []);
const hints = new Set();
let authHints = new Set();
const scanned = [];

for (const src of srcs) {
  const url = sameOriginUrl(src);
  let body;
  try { body = await text(url); } catch (error) {
    scanned.push({ asset: url.pathname, status: 'ERROR', reason: error instanceof Error ? error.message : 'FETCH_ERROR' });
    continue;
  }
  scanned.push({ asset: url.pathname, status: 'OK', bytes: Buffer.byteLength(body) });
  for (const p of body.match(endpointPattern) ?? []) publicEndpoints.add(p);
  for (const m of body.matchAll(routePattern)) {
    const value = m[1];
    if (value && value.length < 260) hints.add(value);
  }
  for (const m of body.matchAll(authPattern)) authHints.add(m[0].toLowerCase());
}

const oneSpecific = [...hints].filter(x => /one|openapi|swagger|api[-_]?key/i.test(x));
const likelyData = [...hints].filter(x => /rate|quote|inventory|vehicle|photo|policy|contract|term|mileage/i.test(x));

console.log(JSON.stringify({
  origin: ORIGIN,
  htmlBytes: Buffer.byteLength(html),
  scriptAssets: scanned,
  apiEndpoints: unique([...publicEndpoints]).slice(0, 250),
  oneSpecificHints: unique(oneSpecific).slice(0, 120),
  dataRouteHints: unique(likelyData).slice(0, 180),
  authLexemesPresent: unique([...authHints]),
  note: 'PUBLIC_ASSET_DISCOVERY_ONLY_NO_API_KEY_NO_AUTHENTICATED_ENDPOINT_CALLS'
}, null, 2));
