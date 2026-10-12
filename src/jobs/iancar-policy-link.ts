// 이안카 정책 연결 — 기본은 읽기 전용 계획(쓰기 0). 적용·복원은 명시 옵션과 외부 승인 환경변수가 모두 있어야 한다.
// 원천(ONE 요금 원문의 보험·추가요금)에서 연령·면허·보험·초과 주행 요금을 당겨 공통 정책 FP-RP031-RENT 에 반영하고(모든 차량이 같은 값일 때만),
// 차량마다 다른 값은 상품 문서 iancar_policy_terms 에 차량별 보존한 뒤 노출 이안카 상품을 공통 정책에 연결한다.
//   계획: EANCAR_ONE_API_KEY=… tsx src/jobs/iancar-policy-link.ts
//   적용: IANCAR_POLICY_LINK_APPROVED=true EANCAR_ONE_API_KEY=… tsx src/jobs/iancar-policy-link.ts --apply --expected-digest=<계획 digest>
//   복원: IANCAR_POLICY_LINK_RESTORE_APPROVED=true tsx src/jobs/iancar-policy-link.ts --restore=<백업파일> --expected-digest=<계획 digest> [--apply]   (--apply 없으면 복원 계획만)
import { applyIancarPolicyLink, planIancarPolicyLinkFromFirestore, restoreIancarPolicyLink, type FetchVehicleTerms } from '../infra/iancar-policy-link-firestore.js';
import { createIancarOneApiClient, iancarOneApiConfigFromEnv } from '../adapters/iancar-one-api.js';
import { extractVehicleTerms } from '../domain/iancar-policy-link.js';
import { stableDigest } from '../shared/stable-digest.js';
import { createJobDataAccessRuntime } from './data-access-runtime.js';

const args = process.argv.slice(2);
const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
for (const a of args) if (a !== '--apply' && !/^--(expected-digest|restore)=/.test(a)) throw new Error(`UNKNOWN_OPTION ${a.split('=')[0]}`);
const expected = arg('expected-digest');
if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) throw new Error('EXPECTED_DIGEST_INVALID');

// 모든 읽기·쓰기는 Data Access Gateway 를 거친다(접근 기록·승인 문맥).
const runtime = createJobDataAccessRuntime();
const context = { actor: { id: 'service:freepass-data-iancar-policy-link', kind: 'SERVICE' as const }, clientId: 'job:iancar-policy-link',
  purpose: 'link RP031 listable products to the common policy and pull supplier-original insurance terms with private backup and readback' };
const resource = { kind: 'SOURCE' as const, name: 'freepasserp5/iancar-policy-link' };

const restore = arg('restore');
if (restore) {
  if (!expected) throw new Error('EXPECTED_DIGEST_REQUIRED');
  if (args.includes('--apply') && process.env.IANCAR_POLICY_LINK_RESTORE_APPROVED !== 'true') throw new Error('IANCAR_POLICY_LINK_RESTORE_APPROVAL_REQUIRED');
  const apply = args.includes('--apply');
  const run = () => restoreIancarPolicyLink({ backupPath: restore, expectedPlanDigest: expected, apply });
  const result = apply
    ? await runtime.access.write({ context, operation: 'RESTORE_IANCAR_POLICY_LINK', resource, requestDigest: stableDigest({ restore: expected }), summarize: value => ({ count: value.count }) }, run)
    : await runtime.access.read({ context, operation: 'READ_IANCAR_POLICY_LINK_RESTORE_PLAN', resource, summarize: value => ({ count: value.count }) }, run);
  console.log(JSON.stringify(result));
  process.exit(0);
}

const config = iancarOneApiConfigFromEnv();
if (!config.apiKey) throw new Error('EANCAR_ONE_API_KEY_REQUIRED');
const client = createIancarOneApiClient(config);
const fetchTerms: FetchVehicleTerms = async vehicleId => {
  try {
    const response: any = await client.getRates(vehicleId);
    const parsed = extractVehicleTerms(response?.data, String(response?.updated_at ?? ''));
    if (!parsed.ok) return { error: parsed.reason };
    if (!parsed.terms.observedAt) return { error: 'RATES_UPDATED_AT_MISSING' };
    await new Promise(resolve => setTimeout(resolve, 150));          // ONE 호출 간격(429 방지)
    return { terms: parsed.terms };
  } catch (error) {
    const code = error instanceof Error ? error.message : 'UNKNOWN';
    return { error: code === 'IANCAR_ONE_API_HTTP_404' ? 'NOT_IN_SOURCE' : code };
  }
};

if (args.includes('--apply')) {
  if (process.env.IANCAR_POLICY_LINK_APPROVED !== 'true') throw new Error('IANCAR_POLICY_LINK_APPROVAL_REQUIRED');
  if (!expected) throw new Error('EXPECTED_DIGEST_REQUIRED');
  const result = await runtime.access.write({ context, operation: 'WRITE_IANCAR_POLICY_LINK', resource, requestDigest: stableDigest({ expected }),
    summarize: value => ({ count: value.counts.toLink, digest: value.planDigest }) }, () => applyIancarPolicyLink({ expectedPlanDigest: expected, fetchTerms }));
  console.log(JSON.stringify(result, null, 2));
} else {
  const plan = await runtime.access.read({ context, operation: 'READ_IANCAR_POLICY_LINK_PLAN', resource,
    summarize: value => ({ count: value.counts.toLink, digest: value.planDigest }) }, () => planIancarPolicyLinkFromFirestore({ fetchTerms }));
  // 상품 문서 ID 에 차량번호가 들어 있을 수 있어 요약에는 ID 를 싣지 않는다(개수·패치 예시·사유 분포만).
  const reasons: Record<string, number> = {};
  for (const row of plan.withoutSourceTerms) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  console.log(JSON.stringify({ ...plan, productPatches: plan.productPatches.length, productPatchSample: plan.productPatches.slice(0, 1).map(p => ({ patch: p.patch })),
    skipped: plan.skipped.length, withoutSourceTerms: reasons, writeExecuted: false }, null, 2));
}
