// 이안카 정책 연결 — 기본은 읽기 전용 계획(쓰기 0). 적용·복원은 명시 옵션과 외부 승인 환경변수가 모두 있어야 한다.
//   계획: tsx src/jobs/iancar-policy-link.ts [--age-upper=keep|65] [--with-source]      (--with-source: ONE 보험 정보 표본 근거를 계획에 포함, EANCAR_ONE_API_KEY 필요)
//   적용: IANCAR_POLICY_LINK_APPROVED=true tsx src/jobs/iancar-policy-link.ts --apply --expected-digest=<계획 digest> [--age-upper=...]
//   복원: IANCAR_POLICY_LINK_RESTORE_APPROVED=true tsx src/jobs/iancar-policy-link.ts --restore=<백업파일> --expected-digest=<계획 digest> [--apply]   (--apply 없으면 복원 계획만)
import { applyIancarPolicyLink, planIancarPolicyLinkFromFirestore, restoreIancarPolicyLink } from '../infra/iancar-policy-link-firestore.js';
import { createIancarOneApiClient, iancarOneApiConfigFromEnv } from '../adapters/iancar-one-api.js';
import type { AgeUpperChoice } from '../domain/iancar-policy-link.js';

const args = process.argv.slice(2);
const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const known = new Set(['--apply', '--with-source']);
for (const a of args) if (!known.has(a) && !/^--(age-upper|expected-digest|restore)=/.test(a)) throw new Error(`UNKNOWN_OPTION ${a.split('=')[0]}`);
const ageRaw = arg('age-upper') ?? 'keep';
if (ageRaw !== 'keep' && ageRaw !== '65') throw new Error('AGE_UPPER_MUST_BE_keep_OR_65');
const ageUpper: AgeUpperChoice = ageRaw === '65' ? 'ONE_65' : 'KEEP';
const expected = arg('expected-digest');
if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) throw new Error('EXPECTED_DIGEST_INVALID');

async function sourceInsurance() {
  const config = iancarOneApiConfigFromEnv();
  if (!config.apiKey) throw new Error('EANCAR_ONE_API_KEY_REQUIRED_FOR_WITH_SOURCE');
  const client = createIancarOneApiClient(config);
  const list: any = await client.listVehicles(1, 100);
  const sample = (list.data as any[]).filter(v => v.inventory_status === 'AVAILABLE').slice(0, 12);
  const mins = new Set<number>(), maxs = new Set<number>();
  for (const vehicle of sample) {
    const rates: any = await client.getRates(vehicle.vehicle_id);
    for (const row of rates.data ?? []) { mins.add(row.insurance?.minimum_driver_age); maxs.add(row.insurance?.maximum_driver_age); }
  }
  return { sampled: sample.length, minimumDriverAge: [...mins].sort(), maximumDriverAge: [...maxs].sort(), observedAt: list.synced_at as string };
}

const restore = arg('restore');
if (restore) {
  if (!expected) throw new Error('EXPECTED_DIGEST_REQUIRED');
  if (args.includes('--apply') && process.env.IANCAR_POLICY_LINK_RESTORE_APPROVED !== 'true') throw new Error('IANCAR_POLICY_LINK_RESTORE_APPROVAL_REQUIRED');
  console.log(JSON.stringify(await restoreIancarPolicyLink({ backupPath: restore, expectedPlanDigest: expected, apply: args.includes('--apply') })));
  process.exit(0);
}
const source = args.includes('--with-source') ? await sourceInsurance() : undefined;
if (args.includes('--apply')) {
  if (process.env.IANCAR_POLICY_LINK_APPROVED !== 'true') throw new Error('IANCAR_POLICY_LINK_APPROVAL_REQUIRED');
  if (!expected) throw new Error('EXPECTED_DIGEST_REQUIRED');
  console.log(JSON.stringify(await applyIancarPolicyLink({ ageUpper, expectedPlanDigest: expected, ...(source ? { sourceInsurance: source } : {}) }), null, 2));
} else {
  const plan = await planIancarPolicyLinkFromFirestore({ ageUpper, ...(source ? { sourceInsurance: source } : {}) });
  // 상품 문서 ID 에 차량번호가 들어 있을 수 있어 요약에는 ID 를 싣지 않는다(개수와 패치 예시만).
  console.log(JSON.stringify({ ...plan, productPatches: plan.productPatches.length, productPatchSample: plan.productPatches.slice(0, 1).map(p => ({ patch: p.patch })), writeExecuted: false }, null, 2));
}
