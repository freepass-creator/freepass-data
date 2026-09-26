import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const IANCAR_SOURCE_CAPTURE_VERSION = 'iancar-source-capture/1';
export const IANCAR_SHEET_ID = '1fJuFSdaW559niD0ow7vVC3qcgjy8KRb8Cr3U8Of01vs';
export const IANCAR_SHEET_TABS = [
  { title: '이안카', gid: '2008897223' }, { title: '이안카 재렌트', gid: '126495265' }
] as const;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const text = (x: unknown): x is string => typeof x === 'string' && !!x.trim() && x === x.trim();
const instant = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x)
  && Number.isFinite(Date.parse(x));
const json = (x: unknown): x is Json => x === null || typeof x === 'string' || typeof x === 'boolean'
  || (typeof x === 'number' && Number.isFinite(x)) || (Array.isArray(x) && x.every(json))
  || (!!x && typeof x === 'object' && !Array.isArray(x)
    && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null)
    && Object.values(x).every(json));
const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

export type IancarCaptureTransport = {
  readErp(): Promise<{ sourceRevision: string; observedAt: string; collectionComplete: boolean;
    parserVersion: string; vehicles: Json[]; rateQuotes: Json[]; rateCoverageComplete: boolean; raw: Json }>;
  readSheetTab(tab: typeof IANCAR_SHEET_TABS[number]): Promise<{ sourceRevision: string; observedAt: string;
    collectionComplete: boolean; rowCount: number; rawCsv: string }>;
};

export type IancarSourceCapture = {
  version: typeof IANCAR_SOURCE_CAPTURE_VERSION; capturedAt: string;
  crossSourceConsistency: 'NON_ATOMIC';
  erp: Awaited<ReturnType<IancarCaptureTransport['readErp']>> & {
    rawDigest: string; vehicleDigest: string; rateQuoteDigest: string;
  };
  sheet: { spreadsheetId: typeof IANCAR_SHEET_ID; tabs: Array<typeof IANCAR_SHEET_TABS[number]
    & Awaited<ReturnType<IancarCaptureTransport['readSheetTab']>>>; };
  digest: string;
};

/** Captures both sources as one evidence bundle; no source or canonical writes. */
export async function captureIancarSource(transport: IancarCaptureTransport): Promise<IancarSourceCapture> {
  const [erp, ...tabs] = await Promise.all([
    transport.readErp(), ...IANCAR_SHEET_TABS.map(tab => transport.readSheetTab(tab))
  ]);
  if (!text(erp.sourceRevision) || !instant(erp.observedAt) || !text(erp.parserVersion) || typeof erp.collectionComplete !== 'boolean'
    || typeof erp.rateCoverageComplete !== 'boolean' || !Array.isArray(erp.vehicles) || !erp.vehicles.every(json)
    || !Array.isArray(erp.rateQuotes) || !erp.rateQuotes.every(json) || !json(erp.raw)) throw new Error('INVALID_IANCAR_ERP_CAPTURE');
  const sheetTabs = tabs.map((value, index) => {
    if (!text(value.sourceRevision) || !instant(value.observedAt) || typeof value.collectionComplete !== 'boolean'
      || !Number.isSafeInteger(value.rowCount) || value.rowCount < 0 || typeof value.rawCsv !== 'string') {
      throw new Error('INVALID_IANCAR_SHEET_CAPTURE');
    }
    return { ...IANCAR_SHEET_TABS[index]!, ...structuredClone(value) };
  });
  const unsigned = { version: IANCAR_SOURCE_CAPTURE_VERSION as typeof IANCAR_SOURCE_CAPTURE_VERSION,
    capturedAt: new Date().toISOString(), crossSourceConsistency: 'NON_ATOMIC' as const,
    erp: { ...structuredClone(erp), rawDigest: digest(erp.raw), vehicleDigest: digest(erp.vehicles),
      rateQuoteDigest: digest(erp.rateQuotes) },
    sheet: { spreadsheetId: IANCAR_SHEET_ID as typeof IANCAR_SHEET_ID, tabs: sheetTabs } };
  return { ...unsigned, digest: digest(unsigned) };
}

/** Count-only inspection. Incomplete/freshness-unknown evidence can be preserved but never activated. */
export function inspectIancarCapture(capture: IancarSourceCapture) {
  const { digest: claimed, ...unsigned } = capture;
  if (claimed !== digest(unsigned)) throw new Error('IANCAR_CAPTURE_DIGEST_MISMATCH');
  if (capture.crossSourceConsistency !== 'NON_ATOMIC' || capture.erp.rawDigest !== digest(capture.erp.raw)
    || capture.erp.vehicleDigest !== digest(capture.erp.vehicles)
    || capture.erp.rateQuoteDigest !== digest(capture.erp.rateQuotes)) throw new Error('IANCAR_DERIVATION_DIGEST_MISMATCH');
  const coverageComplete = capture.erp.collectionComplete && capture.sheet.tabs.every(tab => tab.collectionComplete);
  const pricingComplete = capture.erp.rateCoverageComplete;
  return {
    status: coverageComplete && pricingComplete ? 'READY_FOR_MAPPING_REVIEW' as const : 'HOLD' as const,
    canonicalWriteAuthorized: false as const, cutoverAuthorized: false as const, sourceDigest: capture.digest,
    erpVehicles: capture.erp.vehicles.length, erpRateQuotes: capture.erp.rateQuotes.length,
    sheetRows: Object.fromEntries(capture.sheet.tabs.map(tab => [tab.title, tab.rowCount])),
    coverageComplete, pricingComplete, crossSourceConsistency: capture.crossSourceConsistency,
    remaining: [...(!coverageComplete ? ['SOURCE_COLLECTION_INCOMPLETE'] : []),
      ...(!pricingComplete ? ['ERP_RATE_COVERAGE_INCOMPLETE'] : []), 'NO_CANONICAL_WRITE_OR_CONSUMER_CUTOVER']
  };
}

/** Fixed private, exclusive-create persistence. No caller-selected output path and no overwrite. */
export async function persistIancarCapture(capture: IancarSourceCapture) {
  inspectIancarCapture(capture);
  const privateRoot = join(homedir(), '.codex', 'private', 'freepass-data-iancar-captures');
  await mkdir(privateRoot, { recursive: true });
  if ((await realpath(privateRoot)).toLowerCase() !== privateRoot.toLowerCase()) throw new Error('PRIVATE_PATH_REDIRECT');
  for (let folder = privateRoot; ; folder = dirname(folder)) {
    if ((await lstat(folder)).isSymbolicLink()) throw new Error('PRIVATE_PATH_SYMLINK');
    if (dirname(folder) === folder) break;
  }
  const runId = randomUUID();
  const runDir = join(privateRoot, runId);
  await mkdir(runDir, { recursive: false, mode: 0o700 });
  const capturePath = join(runDir, 'capture.json');
  await writeFile(capturePath, JSON.stringify(capture), { flag: 'wx', mode: 0o600 });
  const readback = JSON.parse(await readFile(capturePath, 'utf8')) as IancarSourceCapture;
  if (readback.digest !== capture.digest || inspectIancarCapture(readback).sourceDigest !== capture.digest) {
    throw new Error('PRIVATE_CAPTURE_READBACK_MISMATCH');
  }
  return { runId, capturePath, digest: capture.digest };
}
