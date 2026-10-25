import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTrustScorecard } from '../application/trust-scorecard.js';
import { createFirestoreCatalogCompatibilityReader, isPublicIancarPhotoProduct, withCompatibilityDepositEvidence } from '../infra/erp5-compat-catalog-reader.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';
const dayStamp = (iso) => iso.slice(0, 10).replaceAll('-', '');
export async function auditTrustScorecardJob(deps) {
    const outDir = process.env.TRUST_SCORECARD_OUT_DIR?.trim();
    if (!outDir)
        throw new Error('TRUST_SCORECARD_OUT_DIR_REQUIRED');
    const input = await deps.readTrustScorecardInput();
    const { report, publicSummary } = buildTrustScorecard(input, {
        withCompatibilityDepositEvidence,
        isPublicIancarPhotoProduct,
    });
    const dir = resolve(outDir);
    await mkdir(dir, { recursive: true });
    await deps.writePrivateArtifact(join(dir, `${dayStamp(report.readAt)}.json`), report);
    await deps.writePrivateArtifact(join(dir, 'summary.json'), publicSummary);
    console.log(JSON.stringify({
        schema: report.schema,
        readAt: report.readAt,
        metrics: report.metrics.map((row) => ({
            id: row.id,
            numerator: row.numerator,
            denominator: row.denominator,
        })),
        summary: {
            id: report.summary.id,
            numerator: report.summary.numerator,
            denominator: report.summary.denominator,
        },
        digest: report.digest,
    }));
}
export async function main() {
    const reader = createFirestoreCatalogCompatibilityReader();
    await auditTrustScorecardJob({
        readTrustScorecardInput: async () => reader.readTrustScorecardInput(),
        writePrivateArtifact,
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(`TRUST_SCORECARD_HOLD ${error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : ''}`.trim());
        process.exitCode = 1;
    });
}
