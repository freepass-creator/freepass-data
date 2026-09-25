import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createJobDataAccessRuntime } from './data-access-runtime.js';
import { erp5ReadTransport } from '../adapters/erp5-source-capture.js';
import {
  buildSheetBridgeRelease,
  prepareSheetBridgeHandoffs
} from '../application/sheet-publication-bridge.js';
import {
  validateSheetPublicationHandoff,
  type SheetHandoffWorkbook
} from '../domain/sheet-publication-handoff.js';

function parseWorkbook(): SheetHandoffWorkbook | 'ALL' | null {
  const arg = process.argv.slice(2).find((value) => value.startsWith('--workbook='));
  const value = arg?.slice('--workbook='.length);
  return value === 'F01' || value === 'F86' || value === 'ALL' ? value : null;
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
    'Usage: npm run prepare:sheet-bridge -- --live-read-only --workbook=ALL|F01|F86'
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
    const targets: SheetHandoffWorkbook[] = workbook === 'ALL' ? ['F01', 'F86'] : [workbook];
    const runtime = createJobDataAccessRuntime();
    const { capture, bridge, handoffs } = await runtime.access.read({
      context: {
        actor: { id: 'service:freepass-data-sheet-bridge', kind: 'SERVICE' },
        clientId: 'job:prepare-sheet-bridge',
        purpose: 'prepare F01/F86 source handoff through FreePass Data'
      },
      operation: 'READ_SHEET_BRIDGE_SOURCE',
      resource: {
        kind: 'SOURCE',
        name: 'freepasserp5/(default):products+policy+partner'
      },
      summarize: (value) => ({
        count: value.capture.collections.products.count,
        digest: value.bridge.release.dataDigest,
        releaseId: value.bridge.release.releaseId,
        manifestId: value.bridge.release.manifestId
      })
    }, () => prepareSheetBridgeHandoffs(
      erp5ReadTransport(token), targets
    ));

    const runDir = join(privateRoot, randomUUID());
    await mkdir(runDir);

    const capturePath = join(runDir, 'source-capture.json');
    await writeFile(capturePath, JSON.stringify(capture), {
      flag: 'wx',
      mode: 0o600
    });
    const storedCapture = JSON.parse(await readFile(capturePath, 'utf8'));
    const storedBridge = buildSheetBridgeRelease(storedCapture);
    if (JSON.stringify(storedBridge.release) !== JSON.stringify(bridge.release)) {
      throw new Error('SHEET_CAPTURE_PRIVATE_READBACK_FAILED');
    }

    const outputs = [];
    for (const handoff of handoffs) {
      const handoffPath = join(runDir, `${handoff.workbook.toLowerCase()}-handoff.json`);
      await writeFile(handoffPath, JSON.stringify(handoff), { flag: 'wx', mode: 0o600 });
      const stored = JSON.parse(await readFile(handoffPath, 'utf8'));
      if (validateSheetPublicationHandoff(stored).status !== 'PASS' ||
          stored.handoffHash !== handoff.handoffHash) {
        throw new Error('SHEET_HANDOFF_PRIVATE_READBACK_FAILED');
      }
      outputs.push({
        workbook: handoff.workbook,
        handoffHash: handoff.handoffHash,
        privateHandoffPath: handoffPath
      });
    }

    console.log(JSON.stringify({
      status: 'READY_FOR_SHADOW',
      productionWriteAuthorized: false,
      cutoverAuthorized: false,
      releaseAuthority: bridge.releaseAuthority,
      workbook,
      releaseId: bridge.release.releaseId,
      manifestId: bridge.release.manifestId,
      sourceReadTime: bridge.manifest.sourceReadTime,
      sourceCounts: {
        products: capture.collections.products.count,
        policies: capture.collections.policy.count,
        partners: capture.collections.partner.count
      },
      inventory: {
        registered: bridge.inventory.registered,
        unavailable: bridge.inventory.unavailable,
        open: bridge.inventory.open
      },
      inputDigest: bridge.release.inputDigest,
      dataDigest: bridge.release.dataDigest,
      privateCapturePath: capturePath,
      outputs,
      ...(outputs.length === 1 ? {
        handoffHash: outputs[0]!.handoffHash,
        privateHandoffPath: outputs[0]!.privateHandoffPath
      } : {}),
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
