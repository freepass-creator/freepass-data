import { readFile } from 'node:fs/promises';
import {
  buildSheetDeliveryExpectation,
  deriveSheetCutoverEvidence,
  validateSheetDeliveryReceipt,
  type SheetDeliveryReceipt
} from '../domain/consumer-delivery.js';
import type { SheetPublicationHandoff } from '../domain/sheet-publication-handoff.js';
import { recordSheetDeliveryEvidence } from '../application/sheet-delivery-evidence.js';
import { createFirestoreDataStore } from '../infra/firestore-store.js';

function arg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))
    ?.slice(prefix.length) ?? null;
}

async function jsonFile<T>(path: string | null, label: string): Promise<T> {
  if (!path) throw new Error(`${label} path is required`);
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

const handoff = await jsonFile<SheetPublicationHandoff>(
  arg('handoff'),
  'Sheet handoff'
);
const receipt = await jsonFile<SheetDeliveryReceipt>(
  arg('receipt'),
  'Sheet delivery receipt'
);
const expectation = buildSheetDeliveryExpectation(handoff);
const delivery = validateSheetDeliveryReceipt(receipt, expectation);
const cutover = deriveSheetCutoverEvidence(receipt, expectation);
const apply = process.argv.includes('--apply');

if (delivery.status !== 'PASS') {
  console.log(JSON.stringify({
    status: 'HOLD',
    mode: apply ? 'APPLY' : 'DRY_RUN',
    violations: delivery.violations
  }, null, 2));
  process.exitCode = 2;
} else if (!apply) {
  console.log(JSON.stringify({
    status: 'READY_TO_RECORD',
    mode: 'DRY_RUN',
    consumerId: receipt.consumerId,
    workbook: receipt.workbook,
    releaseAuthority: receipt.releaseAuthority,
    publicationHandoffHash: receipt.publicationHandoffHash,
    cutover
  }, null, 2));
} else {
  if (process.env.FREEPASS_SHEET_EVIDENCE_WRITE_AUTHORIZED !== '1') {
    throw new Error(
      'FREEPASS_SHEET_EVIDENCE_WRITE_AUTHORIZED=1 is required for --apply'
    );
  }
  const store = await createFirestoreDataStore();
  const recordedAt = arg('recorded-at');
  const evidence = await recordSheetDeliveryEvidence(store, {
    handoff,
    receipt,
    ...(recordedAt ? { recordedAt } : {})
  });
  console.log(JSON.stringify({
    status: 'RECORDED',
    mode: 'APPLY',
    receiptId: evidence.receiptId,
    consumerId: evidence.consumerId,
    workbook: evidence.workbook,
    releaseAuthority: evidence.receipt.releaseAuthority,
    publicationHandoffHash: evidence.receipt.publicationHandoffHash,
    cutover
  }, null, 2));
}
