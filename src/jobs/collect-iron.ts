import { pathToFileURL } from 'node:url';
import { ironSourceAdapter, type IronDetailFetcher, type IronDetailTarget } from '../adapters/supplier-source-capture.js';
import { ironDetailReader } from '../infra/iron-detail-reader.js';
import {
  collectSupplierSource,
  type SourceIntakeBatch,
  type SupplierSourceAdapter,
} from '../domain/source-intake.js';

type IronCaptureReport = {
  counts: { records: number };
  digest: string | null | undefined;
  issues: readonly string[];
};

type IronEvidence = Awaited<ReturnType<typeof collectSupplierSource>>['evidence'];

const validTarget = (value: unknown): value is IronDetailTarget => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  if (typeof target.id !== 'string' || typeof target.url !== 'string' || typeof target.plate !== 'string') return false;
  if (!target.id.trim() || !target.plate.trim()) return false;
  try {
    const url = new URL(target.url);
    return url.origin === 'https://ironrentcar.com' && !url.username && !url.password && !url.search
      && !url.hash && url.pathname === `/vehicles/${encodeURIComponent(target.id)}`;
  } catch {
    return false;
  }
};

export function parseIronTargetsJson(value: string | undefined): IronDetailTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? 'null');
  } catch {
    throw new Error('IRON_TARGETS_INVALID');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => !validTarget(item)))
    throw new Error('IRON_TARGETS_INVALID');
  return parsed.map(target => ({ id: target.id, url: target.url, plate: target.plate }));
}

export async function captureIron(input: {
  targets: readonly IronDetailTarget[];
  applyRaw: boolean;
  approved: boolean;
}, ports: {
  fetchDetail?: IronDetailFetcher;
  ingestRawBatch?: (batch: SourceIntakeBatch) => Promise<unknown>;
  collect?: (adapter: SupplierSourceAdapter) => Promise<{ batch: SourceIntakeBatch; evidence: IronEvidence }>;
} = {}): Promise<IronCaptureReport> {
  if (input.applyRaw && !input.approved) throw new Error('IRON_RAW_APPROVAL_REQUIRED');
  const adapter = ironSourceAdapter({
    sourceId: 'supplier:RP006:iron-original-html',
    targets: input.targets,
    expectedFreshnessSeconds: null,
    fetchDetail: ports.fetchDetail ?? ironDetailReader(),
  });
  const { batch, evidence } = await (ports.collect ?? collectSupplierSource)(adapter);
  if (input.applyRaw) {
    if (evidence.status !== 'RAW_READY') throw new Error('IRON_RAW_SOURCE_HOLD');
    const ingest = ports.ingestRawBatch ?? (async (value: SourceIntakeBatch) => {
      const { createSourceIngestDataAccessRuntime } = await import('./data-access-runtime.js');
      return (await createSourceIngestDataAccessRuntime()).ingestRawBatch(value);
    });
    await ingest(batch);
  }
  return { counts: { records: batch.records.length }, digest: batch.checksum, issues: evidence.issues };
}

export async function ironCaptureCommand(args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.some(arg => arg !== '--apply-raw') || args.length > 1) throw new Error('IRON_OPTIONS_INVALID');
  return captureIron({
    targets: parseIronTargetsJson(env.IRON_TARGETS_JSON),
    applyRaw: args.includes('--apply-raw'),
    approved: env.IRON_RAW_INGEST_APPROVED === 'true',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ironCaptureCommand(process.argv.slice(2)).then(report => {
    console.log(JSON.stringify(report));
    if (report.issues.length) process.exitCode = 2;
  }).catch(error => {
    const code = error instanceof Error && /^IRON_[A-Z0-9_]+$/.test(error.message)
      ? error.message : 'IRON_CAPTURE_HOLD';
    console.error(JSON.stringify({ issues: [code] }));
    process.exitCode = 2;
  });
}
