#!/usr/bin/env node
// 이안카 사진 ID 게이트 켜기 전/후 측정 — 읽기 전용. 노출 중인 이안카 상품 각각에 대해 사진 목록(manifest)과 첫 사진(0번)을 요청해 200 응답 수를 센다.
// 출력은 개수와 차량번호 끝 4자리뿐(토큰·사진 ID·원본 주소 없음). 토큰은 환경변수로만 받는다(READ_RUNTIME_ID_TOKEN, ERP5_PHOTO_CONSUMER_TOKEN).
// 사용: READ_RUNTIME_URL=<읽기 런타임 주소> READ_RUNTIME_ID_TOKEN=<Cloud Run ID 토큰> ERP5_PHOTO_CONSUMER_TOKEN=<erp5-public-media 토큰> node scripts/iancar-photo-gate-measure.mjs [--label 켜기전|켠뒤]
import { execFileSync } from 'node:child_process';

export function summarize(results) {
  const by = {};
  for (const r of results) by[`${r.manifest}/${r.first}`] = (by[`${r.manifest}/${r.first}`] || 0) + 1;
  return {
    total: results.length,
    manifest200: results.filter(r => r.manifest === 200).length,
    first200: results.filter(r => r.first === 200).length,
    both200: results.filter(r => r.manifest === 200 && r.first === 200).length,
    byStatusPair: by,
    failedLast4: results.filter(r => !(r.manifest === 200 && r.first === 200)).map(r => r.last4),
  };
}

async function main() {
  const base = process.env.READ_RUNTIME_URL, idToken = process.env.READ_RUNTIME_ID_TOKEN, token = process.env.ERP5_PHOTO_CONSUMER_TOKEN;
  if (!base || !idToken || !token) { console.error('READ_RUNTIME_URL, READ_RUNTIME_ID_TOKEN, ERP5_PHOTO_CONSUMER_TOKEN 필요'); process.exit(64); }
  const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : '';
  const gcloud = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  // 노출 중인 이안카 상품(문서 ID·번호 끝 4자리)만 읽는다.
  const docs = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    for (const f of ['car_number', 'provider_company_code', 'listable', 'iancar_one_photo_ids']) q.append('mask.fieldPaths', f);
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/freepasserp5/databases/(default)/documents/products?${q}`, { headers: { Authorization: `Bearer ${gcloud}` } });
    if (!res.ok) throw new Error(`FIRESTORE_READ_${res.status}`);
    const body = await res.json();
    for (const d of body.documents ?? []) {
      const f = d.fields ?? {};
      if (f.provider_company_code?.stringValue === 'RP031' && f.listable?.booleanValue === true)
        docs.push({ id: d.name.split('/').pop(), last4: String(f.car_number?.stringValue ?? '').slice(-4) });
    }
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  const get = async path => {
    const res = await fetch(`${base}/v1/consumers/erp5-public-media/catalog-compat/products/${encodeURIComponent(path)}`, {
      headers: { 'X-Serverless-Authorization': `Bearer ${idToken}`, Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel();
    return res.status;
  };
  const results = [];
  for (const doc of docs) {
    results.push({ last4: doc.last4, manifest: await get(`${doc.id}/photos`), first: await get(`${doc.id}/photos/0`) });
    await new Promise(resolve => setTimeout(resolve, 400)); // 소비처 한도(초당 10)와 원천 한도 보호
  }
  console.log(JSON.stringify({ label, at: new Date().toISOString(), ...summarize(results) }));
}
if (process.argv[1]?.endsWith('iancar-photo-gate-measure.mjs')) await main();
