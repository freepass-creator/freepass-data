import { pathToFileURL } from 'node:url';
import { auditSettlementIdLinks } from '../application/settlement-id-link-audit.js';
import type { SettlementIdLinkAuditSource } from '../domain/settlement-id-link-audit.js';
import { readSettlementIdLinkAuditSource } from '../infra/settlement-id-link-audit-reader.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

type AuditSettlementIdLinksDeps = {
  readSettlementIdLinkAuditSource: () => Promise<SettlementIdLinkAuditSource>;
  writePrivateArtifact: typeof writePrivateArtifact;
};

export async function main() {
  await auditSettlementIdLinksJob({
    readSettlementIdLinkAuditSource,
    writePrivateArtifact,
  });
}

export async function auditSettlementIdLinksJob(deps: AuditSettlementIdLinksDeps) {
  const out = process.env.SETTLEMENT_ID_LINK_AUDIT_OUT?.trim();
  if (!out) throw new Error('SETTLEMENT_ID_LINK_AUDIT_OUT_REQUIRED');
  const source = await deps.readSettlementIdLinkAuditSource();
  const report = auditSettlementIdLinks(source);
  await deps.writePrivateArtifact(out, report);
  console.log(JSON.stringify({
    schema: report.schema,
    settlementRows: report.summary.settlementRows,
    classifications: report.summary.classifications,
    digest: report.digest,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`SETTLEMENT_ID_LINK_AUDIT_HOLD ${error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : ''}`.trim());
    process.exitCode = 1;
  });
}
