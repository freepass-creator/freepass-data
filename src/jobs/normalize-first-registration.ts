// 최초등록일 표기 통일 — 기본은 읽기 전용 계획(쓰기 0). 적용·복원은 명시 옵션과 외부 승인 환경변수가 모두 있어야 한다.
//   계획: tsx src/jobs/normalize-first-registration.ts
//   적용: FIRST_REGISTRATION_NORMALIZE_APPROVED=true tsx src/jobs/normalize-first-registration.ts --apply --expected-digest=<계획 digest>
//   복원: FIRST_REGISTRATION_RESTORE_APPROVED=true tsx src/jobs/normalize-first-registration.ts --restore=<백업파일> --expected-digest=<계획 digest> [--apply]
import { applyFirstRegistration, planFirstRegistration, restoreFirstRegistration } from '../infra/first-registration-firestore.js';
import { stableDigest } from '../shared/stable-digest.js';
import { createJobDataAccessRuntime } from './data-access-runtime.js';

const args = process.argv.slice(2);
const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
for (const a of args) if (a !== '--apply' && !/^--(expected-digest|restore|now)=/.test(a)) throw new Error(`UNKNOWN_OPTION ${a.split('=')[0]}`);
const expected = arg('expected-digest');
if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) throw new Error('EXPECTED_DIGEST_INVALID');

const runtime = createJobDataAccessRuntime();
const context = { actor: { id: 'service:freepass-data-first-registration', kind: 'SERVICE' as const }, clientId: 'job:normalize-first-registration',
  purpose: 'normalize first_registration_date cleaned values (raw preserved) with private backup and readback' };
const resource = { kind: 'SOURCE' as const, name: 'freepasserp5/first-registration-normalize' };
// 기준 시각: 계획과 적용이 같게 오늘 UTC 0시(하루 안에서 판정이 흔들리지 않음). --now=YYYY-MM-DD 로 고정 가능.
const nowArg = arg('now');
if (nowArg !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(nowArg)) throw new Error('NOW_INVALID');
const nowMs = nowArg ? Date.parse(`${nowArg}T00:00:00Z`) : Math.floor(Date.now() / 86_400_000) * 86_400_000;

const restore = arg('restore');
if (restore) {
  if (!expected) throw new Error('EXPECTED_DIGEST_REQUIRED');
  const apply = args.includes('--apply');
  if (apply && process.env.FIRST_REGISTRATION_RESTORE_APPROVED !== 'true') throw new Error('FIRST_REGISTRATION_RESTORE_APPROVAL_REQUIRED');
  const run = () => restoreFirstRegistration({ backupPath: restore, expectedPlanDigest: expected, apply });
  const result = apply
    ? await runtime.access.write({ context, operation: 'RESTORE_FIRST_REGISTRATION', resource, requestDigest: stableDigest({ restore: expected }), summarize: value => ({ count: value.count }) }, run)
    : await runtime.access.read({ context, operation: 'READ_FIRST_REGISTRATION_RESTORE_PLAN', resource, summarize: value => ({ count: value.count }) }, run);
  console.log(JSON.stringify(result));
} else if (args.includes('--apply')) {
  if (process.env.FIRST_REGISTRATION_NORMALIZE_APPROVED !== 'true') throw new Error('FIRST_REGISTRATION_NORMALIZE_APPROVAL_REQUIRED');
  if (!expected) throw new Error('EXPECTED_DIGEST_REQUIRED');
  const result = await runtime.access.write({ context, operation: 'WRITE_FIRST_REGISTRATION', resource, requestDigest: stableDigest({ expected }),
    summarize: value => ({ count: value.summary.toWrite, digest: value.planDigest }) }, () => applyFirstRegistration({ nowMs, expectedPlanDigest: expected }));
  console.log(JSON.stringify(result, null, 2));
} else {
  const plan = await runtime.access.read({ context, operation: 'READ_FIRST_REGISTRATION_PLAN', resource,
    summarize: value => ({ count: value.summary.toWrite, digest: value.planDigest }) }, () => planFirstRegistration({ nowMs }));
  // 상품 문서 ID 에 차량번호가 들어 있을 수 있어 요약에는 ID 를 싣지 않는다.
  const heldReasons: Record<string, number> = {};
  for (const h of plan.held) heldReasons[h.reason] = (heldReasons[h.reason] ?? 0) + 1;
  console.log(JSON.stringify({ schema: plan.schema, counts: plan.counts, summary: plan.summary, heldReasons, planDigest: plan.planDigest, now: new Date(nowMs).toISOString().slice(0, 10),
    sample: plan.patches.filter(p => p.verdict !== 'TAG').slice(0, 3).map(p => p.patch), writeExecuted: false }, null, 2));
}
