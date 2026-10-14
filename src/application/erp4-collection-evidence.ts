/** ERP4 풀 회차(erp5-ssot-refresh)에서 «현재 원천을 ERP5 에 반영한 쓰기 단계» 가 마지막으로 성공한 시각(순수 판정).
 * ERP4 는 바뀐 문서만 쓰므로 손오공·오토플러스 문서의 updateTime 은 수집 성공 시각이 아니다(2026-10-13 오탐 실측).
 * 발행 단계가 실패해도 이 단계가 success 이면 쓰기는 끝난 것이다. 이안카 전용 회차는 이 단계가 skipped 라 제외된다. */
export const ERP4_COLLECTION_STEP = '원천에서 ERP5 현재 원자 계산';

export type GitHubRun = { id: number; created_at?: string; status?: string; conclusion?: string | null };
export type GitHubJobs = { jobs?: Array<{ steps?: Array<{ name?: string; conclusion?: string | null; completed_at?: string | null }> }> };

export function collectionSuccessAt(jobs: GitHubJobs): string | null {
  let latest: number | null = null;
  for (const job of jobs.jobs ?? []) for (const step of job.steps ?? []) {
    if (step.name !== ERP4_COLLECTION_STEP || step.conclusion !== 'success' || typeof step.completed_at !== 'string') continue;
    const at = Date.parse(step.completed_at);
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/** 최근 완료된 run 들을 최신순으로 훑어 첫 성공 시각을 돌려준다. 미래 시각·해석 불가는 버린다. */
export async function latestCollectionSuccess(options: {
  runs: () => Promise<GitHubRun[]>; jobs: (runId: number) => Promise<GitHubJobs>; now?: () => number; limit?: number;
}): Promise<string | null> {
  const now = (options.now ?? Date.now)(), limit = options.limit ?? 8;
  const runs = (await options.runs()).filter(r => r.status === 'completed' && Number.isSafeInteger(r.id))
    .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? '')).slice(0, limit);
  for (const run of runs) {
    const at = collectionSuccessAt(await options.jobs(run.id));
    if (at !== null && Date.parse(at) <= now + 60_000) return at;
  }
  return null;
}
