/** 영업자용 재고 시트 발행 계획 CLI(읽기 전용: 피드 JSON 파일 입력, 시트 쓰기·네트워크 없음).
 *   node dist/src/jobs/plan-sales-inventory-sheet.js --feed <공개 피드.json> --snapshot-id <ID> [--generated-at <ISO>] [--compare-feed <다시 읽은 피드.json>]
 *     [--audience sales|consumer]   (결과는 표준 출력으로만 — 파일을 쓰지 않는다. 필요하면 호출 쪽이 리다이렉트)
 * 출력: 버전 탭 이름·검증 리포트(건수·금지 필드/문구·번호 중복·칸 허용 목록)·요약. --compare-feed 를 주면 차량 번호 집합을 대조한다.
 * 공급사명: 영업자용(기본)은 표시, --audience consumer 면 숨김(ERP5 와 같은 규칙). 발행(시트 쓰기)·공유 설정은 이 도구가 하지 않는다 — Codex·박대표 확인 뒤 별도 절차. 출력에 전체 차량번호는 없다(차이는 끝 4자리). */
import { readFile } from 'node:fs/promises';
import { compareSalesPlanWithFeed, planSalesInventorySheet, type SalesFeed } from '../application/sales-inventory-sheet.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const feedOf = (raw: unknown): SalesFeed => {
  const feed = raw as SalesFeed;
  if (!feed || typeof feed !== 'object' || !Array.isArray(feed.products) || typeof feed.count !== 'number') throw new Error('SALES_FEED_INVALID');
  return feed;
};

export async function runSalesInventoryPlan(input: { feed: string; snapshotId: string; generatedAt?: string | undefined; compareFeed?: string | undefined; audience?: 'sales' | 'consumer' }) {
  const feed = feedOf(JSON.parse(await readFile(input.feed, 'utf8')));
  const plan = planSalesInventorySheet(feed, { snapshotId: input.snapshotId, generatedAt: input.generatedAt ?? new Date().toISOString(),
    audience: input.audience === 'consumer' ? 'consumer' : 'sales' });
  const compare = input.compareFeed ? compareSalesPlanWithFeed(plan, feedOf(JSON.parse(await readFile(input.compareFeed, 'utf8')))) : null;
  return { versionTab: plan.versionTab, header: plan.header, validation: plan.validation, summary: plan.summary, ...(compare ? { compare } : {}),
    publishable: plan.validation.ok && (compare === null || compare.equal) };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('plan-sales-inventory-sheet.js')) {
  const feed = arg('--feed'), snapshotId = arg('--snapshot-id');
  if (!feed || !snapshotId) { console.error('SALES_PLAN_ARGS_REQUIRED'); process.exitCode = 1; }
  else runSalesInventoryPlan({ feed, snapshotId, generatedAt: arg('--generated-at'), compareFeed: arg('--compare-feed'),
    audience: arg('--audience') === 'consumer' ? 'consumer' : 'sales' }).then(async result => {
    console.log(JSON.stringify({ status: 'SALES_SHEET_PLAN', writes: 0, ...result }, null, 1));
    if (!result.publishable) process.exitCode = 2;
  }).catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'SALES_PLAN_FAILED'); process.exitCode = 1; });
}
