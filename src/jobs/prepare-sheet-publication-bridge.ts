import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { erp5ReadTransport } from '../adapters/erp5-source-capture.js';
import {
  buildSheetBridgeHandoff,
  buildSheetBridgeRelease,
  captureErp5SheetSource
} from '../application/sheet-publication-bridge.js';
import {
  validateSheetPublicationHandoff,
  type SheetHandoffWorkbook
} from '../domain/sheet-publication-handoff.js';

function parseWorkbook(): SheetHandoffWorkbook | null {
  const arg = process.argv.slice(2).find((value) => value.startsWith('--workbook='));
  const value = arg?.slice('--workbook='.length);
  return value === 'F01' || value === 'F86' ? value : null;
}

async function assertPrivateRoot(root: string) {
  await mkdir(root, { recursive: true });
  if ((await realpath(root)).toLowerCase() !== root.toLowerCase()) {
    throw new Error('PRIVATE_PATH_REDIRECT');
  }
  for (let folder = root; ; folder = dirname(folder)) {
    if (await stat(join(folder, '.git')).then(() => true, () => false)) {
      throw new Error('PRIVATE_PATH_IN_GIT');
    }
    if (dirname(folder) === folder) break;
  }
}

const workbook = parseWorkbook();
const args = process.argv.slice(2);
if (
  !workbook ||
  args.length !== 2 ||
  !args.includes('--live-read-only')
) {
  console.error(
    'Usage: npm run prepare:sheet-bridge -- --live-read-only --workbook=F01|F86'
  );
  process.exitCode = 2;
} else {
  try {
    const privateRoot = join(
      homedir(),
      '.codex',
      'private',
      'freepass-data-sheet-handoffs'
    );
    await assertPrivateRoot(privateRoot);

    const token = process.env.FREEPASS_ERP5_READ_ACCESS_TOKEN ?? '';
    const capture = await captureErp5SheetSource(erp5ReadTransport(token));
    const bridge = buildSheetBridgeRelease(capture);
    const handoff = buildSheetBridgeHandoff(bridge, workbook);

    const validation = validateSheetPublicationHandoff(handoff);
    if (validation.status !== 'PASS') {
      throw new Error('SHEET_HANDOFF_SELF_VALIDATION_FAILED');
    }

    const runDir = join(privateRoot, randomUUID());
    await mkdir(runDir);

    const capturePath = join(runDir, 'source-capture.json');
    const handoffPath = join(runDir, `${workbook.toLowerCase()}-handoff.json`);
    await writeFile(capturePath, JSON.stringify(capture), {
      flag: 'wx',
      mode: 0o600
    });
    await writeFile(handoffPath, JSON.stringify(handoff), {
      flag: 'wx',
      mode: 0o600
    });

    const stored = JSON.parse(await readFile(handoffPath, 'utf8'));
    const readback = validateSheetPublicationHandoff(stored);
    if (readback.status !== 'PASS') {
      throw new Error('SHEET_HANDOFF_PRIVATE_READBACK_FAILED');
    }

    console.log(JSON.stringify({
      status: 'READY_FOR_SHADOW',
      productionWriteAuthorized: false,
      cutoverAuthorized: false,
      releaseAuthority: handoff.releaseAuthority,
      workbook,
      releaseId: handoff.approvedRelease.releaseId,
      manifestId: handoff.approvedRelease.manifestId,
      sourceReadTime: handoff.manifest.sourceReadTime,
      sourceCounts: {
        products: capture.collections.products.count,
        policies: capture.collections.policy.count,
        partners: capture.collections.partner.count
      },
      inventory: {
        registered: handoff.snapshot.inventory.registered,
        unavailable: handoff.snapshot.inventory.unavailable,
        open: handoff.snapshot.inventory.open
      },
      inputDigest: handoff.approvedRelease.inputDigest,
      dataDigest: handoff.approvedRelease.dataDigest,
      handoffHash: handoff.handoffHash,
      privateCapturePath: capturePath,
      privateHandoffPath: handoffPath,
      remaining: [
        'NO_SHEET_WRITE_PERFORMED',
        'ERP4_SHADOW_ADOPTION_REQUIRED',
        'F01_F86_RENDERED_OUTPUT_PARITY_REQUIRED',
        'DELIVERY_READBACK_RECEIPT_REQUIRED',
        'CANONICAL_ACTIVE_CUTOVER_SEPARATELY_HOLD'
      ]
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(message)
      ? message
      : 'SHEET_BRIDGE_PREPARE_FAILED';
    console.error(`HOLD: ${code}. No Sheet/Firestore write or consumer switch performed.`);
    process.exitCode = 2;
  }
}
