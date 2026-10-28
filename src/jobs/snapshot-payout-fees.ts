import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { planPayoutFeeSnapshots, type PayoutFeeEvidence, type PayoutFeeSnapshotPlan } from '../application/payout-fee-snapshot.js';
import type { PayoutFeeSnapshotStore } from '../ports/payout-fee-snapshot-store.js';
import { stableDigest } from '../shared/stable-digest.js';

const digestPattern = /^[a-f0-9]{64}$/;

type NewCarPriceEvidence = {
  plate?: unknown;
  '가격원'?: unknown;
  '확신도'?: unknown;
  '근거URL'?: unknown;
  carName?: unknown;
  '연식'?: unknown;
};

export function parsePayoutFeeEvidence(value: unknown): PayoutFeeEvidence[] {
  if (!Array.isArray(value)) throw new Error('PAYOUT_SNAPSHOT_EVIDENCE_INVALID');
  return value.flatMap((item): PayoutFeeEvidence[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('PAYOUT_SNAPSHOT_EVIDENCE_INVALID');
    const record = item as Record<string, unknown>;
    if ('가격원' in record || '확신도' in record || '근거URL' in record) {
      const source = item as NewCarPriceEvidence;
      const confidence = source['확신도'] === '높음' ? 'high' : source['확신도'] === '중간' ? 'medium' : source['확신도'] === '낮음' ? 'low' : null;
      if (confidence === 'low') return [];   // 확신도 낮음은 가격이 비어 있어도 형식 오류가 아니라 «쓰지 않음»
      if (!confidence || typeof source.plate !== 'string' || !source.plate.trim() || !Number.isSafeInteger(source['가격원']) || (source['가격원'] as number) <= 0)
        throw new Error('PAYOUT_SNAPSHOT_EVIDENCE_INVALID');
      return [{ plate: source.plate.trim(), confidence, vehicleValue: source['가격원'] as number,
        newProductSubtype: 'NEW_PREDELIVERY', priceSource: '신차 증거 파일',
        ...(typeof source['근거URL'] === 'string' && source['근거URL'].trim() ? { evidenceUrl: source['근거URL'].trim() } : {}) }];
    }
    if (!['high', 'medium', 'low'].includes(String(record.confidence))) throw new Error('PAYOUT_SNAPSHOT_EVIDENCE_INVALID');
    return [structuredClone(item as PayoutFeeEvidence)];
  });
}

export async function applyPayoutFeeSnapshotPlan(store: PayoutFeeSnapshotStore, plan: PayoutFeeSnapshotPlan) {
  let created = 0, unchanged = 0;
  for (const document of plan.documents) {
    const documentId = `${plan.snapshotDate}__${document.productId}`;
    const current = await store.readDocument(documentId);
    if (current) {
      if (current.planDigest !== plan.planDigest || current.contentDigest !== document.contentDigest || stableDigest(current) !== stableDigest(document))
        throw new Error('PAYOUT_SNAPSHOT_EXISTING_DOCUMENT_CONFLICT');
      unchanged++;
      continue;
    }
    await store.createDocument(documentId, document); // 어댑터의 create는 currentDocument.exists=false 조건이다.
    const readback = await store.readDocument(documentId);
    if (!readback || stableDigest(readback) !== stableDigest(document)) throw new Error('PAYOUT_SNAPSHOT_READBACK_FAILED');
    created++;
  }
  return { status: 'APPLIED', created, unchanged, planDigest: plan.planDigest };
}

function parseArgs(argv: string[]) {
  let apply = false, mewcarPrepaidDefault = false, expectedDigest: string | null = null, evidencePath: string | null = null, snapshotDate: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === '--apply') apply = true;
    else if (value === '--mewcar-prepaid-default') mewcarPrepaidDefault = true;
    else if (value.startsWith('--expected-digest=')) expectedDigest = value.slice('--expected-digest='.length);
    else if (value === '--evidence') evidencePath = argv[++index] ?? null;
    else if (value === '--snapshot-date') snapshotDate = argv[++index] ?? null;
    else throw new Error('PAYOUT_SNAPSHOT_ARGUMENT_INVALID');
  }
  return { apply, mewcarPrepaidDefault, expectedDigest, evidencePath, snapshotDate };
}

export async function runPayoutFeeSnapshotJob(input: {
  store: PayoutFeeSnapshotStore;
  access: { read<T>(spec: unknown, run: () => Promise<T>): Promise<T>; write<T>(spec: unknown, run: () => Promise<T>): Promise<T> };
  argv: string[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
}) {
  const args = parseArgs(input.argv), env = input.env ?? process.env;
  const evidence = args.evidencePath ? parsePayoutFeeEvidence(JSON.parse(await readFile(args.evidencePath, 'utf8'))) : [];
  const date = args.snapshotDate ?? (input.now ?? new Date()).toISOString().slice(0, 10);
  const spec = { context: { actor: { id: 'service:freepass-data-payout-fee', kind: 'SERVICE' }, clientId: 'job:snapshot-payout-fees', purpose: '상품별 기간별 영업자 지급수수료 비공개 박제' },
    operation: args.apply ? 'WRITE_PAYOUT_FEE_SNAPSHOTS' : 'READ_PAYOUT_FEE_SNAPSHOT_PLAN', resource: { kind: 'SOURCE', name: 'products+policy' },
    summarize: (value: unknown) => ({ digest: stableDigest(value) }) };
  const source = await input.access.read(spec, () => input.store.readInputs());
  const plan = planPayoutFeeSnapshots({ snapshotDate: date, ...source, evidence, mewcarPrepaidDefault: args.mewcarPrepaidDefault });
  if (!args.apply) return { status: 'PLANNED', writes: 0, supplierCounts: plan.supplierCounts,
    evidenceAppliedCounts: plan.evidenceAppliedCounts, nonstandardTermRuleCounts: plan.nonstandardTermRuleCounts,
    payoutExceedsBillingCounts: plan.payoutExceedsBillingCounts,
    planDigest: plan.planDigest };
  if (!args.expectedDigest || !digestPattern.test(args.expectedDigest) || args.expectedDigest !== plan.planDigest) throw new Error('PAYOUT_SNAPSHOT_EXPECTED_DIGEST_MISMATCH');
  if (env.PAYOUT_FEE_SNAPSHOT_APPROVED !== 'true') throw new Error('PAYOUT_SNAPSHOT_APPROVAL_REQUIRED');
  return input.access.write(spec, () => applyPayoutFeeSnapshotPlan(input.store, plan));
}

export async function main(argv = process.argv.slice(2)) {
  const { createPayoutFeeSnapshotRuntime } = await import('./data-access-runtime.js');
  const result = await runPayoutFeeSnapshotJob({ ...createPayoutFeeSnapshotRuntime(), argv });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'PAYOUT_SNAPSHOT_FAILED'); process.exitCode = 1;
});
