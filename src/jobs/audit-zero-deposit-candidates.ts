import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildZeroDepositCandidateAudit } from '../application/audit-zero-deposit-candidates.js';
import { createSourceIngestDataAccessRuntime } from './data-access-runtime.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

type AuditZeroDepositCandidatesDeps = {
  readProducts: () => Promise<Record<string, Record<string, unknown>>>;
  writePrivateArtifact: typeof writePrivateArtifact;
};

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function auditZeroDepositCandidatesJob(deps: AuditZeroDepositCandidatesDeps) {
  const outDir = process.env.ZERO_DEPOSIT_CANDIDATE_AUDIT_OUT_DIR?.trim();
  if (!outDir) throw new Error('ZERO_DEPOSIT_CANDIDATE_AUDIT_OUT_DIR_REQUIRED');
  const products = await deps.readProducts();
  const { report, publicSummary } = buildZeroDepositCandidateAudit({ products });
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  const detailPath = join(dir, `${report.readAt.slice(0, 10).replaceAll('-', '')}.json`);
  await deps.writePrivateArtifact(detailPath, report);
  await deps.writePrivateArtifact(join(dir, 'summary.json'), publicSummary);
  console.log(JSON.stringify({
    schema: publicSummary.schema,
    productCount: publicSummary.productCount,
    candidateCount: publicSummary.candidateCount,
    countsByReason: publicSummary.countsByReason,
    questionTemplateIdsByReason: publicSummary.questionTemplateIdsByReason,
    reportDigest: publicSummary.reportDigest,
    summaryDigest: digest(publicSummary),
  }));
}

export async function main() {
  const runtime = await createSourceIngestDataAccessRuntime();
  await auditZeroDepositCandidatesJob({
    readProducts: async () => Object.fromEntries((await runtime.readLegacySnapshot()).records.map(row => [row.sourceRecordId, row.data])),
    writePrivateArtifact,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'ZERO_DEPOSIT_CANDIDATE_AUDIT_FAILED';
    console.error(code);
    process.exitCode = 1;
  });
}
