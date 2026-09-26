import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createErp5CaptureAnalysisRuntime } from './data-access-runtime.js';

const analysis = createErp5CaptureAnalysisRuntime();
const args = process.argv.slice(2);
if (![2, 4].includes(args.length) || args[0] !== '--capture' || (args.length === 4 && args[2] !== '--previous')) {
  console.error('Usage: npx tsx src/jobs/build-erp5-canonical-dry-run.ts --capture <current capture.json> [--previous <previous capture.json>]');
  process.exitCode = 2;
} else {
  try {
    const privateRoot = resolve(join(homedir(), '.codex', 'private', 'freepass-data-source-captures'));
    await mkdir(privateRoot, { recursive: true });
    const checkedPath = async (input: string) => {
      const path = await realpath(resolve(input));
      const inside = relative(privateRoot, path);
      if (!inside || inside.startsWith('..') || resolve(privateRoot, inside) !== path) throw new Error('CAPTURE_OUTSIDE_PRIVATE_ROOT');
      for (let folder = dirname(path); ; folder = dirname(folder)) {
        if (await stat(join(folder, '.git')).then(() => true, () => false)) throw new Error('PRIVATE_PATH_IN_GIT');
        if (folder === privateRoot) break;
        if (dirname(folder) === folder) throw new Error('CAPTURE_OUTSIDE_PRIVATE_ROOT');
      }
      return path;
    };
    const capturePath = await checkedPath(args[1]!);
    const capture = JSON.parse(await readFile(capturePath, 'utf8'));
    const dryRun = analysis.buildCanonicalDryRun(capture);
    const delta = args.length === 4
      ? analysis.compareProductCaptures(JSON.parse(await readFile(await checkedPath(args[3]!), 'utf8')), capture)
      : null;
    const outputPath = join(dirname(capturePath), `canonical-dry-run-${randomUUID()}.json`);
    await writeFile(outputPath, JSON.stringify(dryRun, null, 2), { flag: 'wx', mode: 0o600 });
    const readback = JSON.parse(await readFile(outputPath, 'utf8'));
    if (JSON.stringify(readback) !== JSON.stringify(dryRun)) {
      throw new Error('DRY_RUN_READBACK_MISMATCH');
    }
    const deltaOutputPath = delta ? join(dirname(capturePath), `capture-delta-${randomUUID()}.json`) : null;
    if (delta && deltaOutputPath) {
      await writeFile(deltaOutputPath, JSON.stringify(delta, null, 2), { flag: 'wx', mode: 0o600 });
      const deltaReadback = JSON.parse(await readFile(deltaOutputPath, 'utf8'));
      if (JSON.stringify(deltaReadback) !== JSON.stringify(delta)) throw new Error('DELTA_READBACK_MISMATCH');
    }
    console.log(JSON.stringify({
      version: dryRun.version,
      status: dryRun.status,
      canonicalWriteAuthorized: dryRun.canonicalWriteAuthorized,
      sourceDigest: dryRun.sourceDigest,
      digest: dryRun.digest,
      counts: dryRun.counts,
      publicationGate: dryRun.publicationGate,
      issueCounts: dryRun.issueCounts,
      reviewAxisCounts: dryRun.reviewAxisCounts,
      reviewComplexityCounts: dryRun.reviewComplexityCounts,
      fieldProfile: {
        collection: dryRun.fieldProfile.collection,
        documentCount: dryRun.fieldProfile.documentCount,
        fieldPathCount: dryRun.fieldProfile.fieldPathCount
      },
      delta: delta ? {
        status: delta.status,
        digest: delta.digest,
        previous: delta.previous,
        current: delta.current,
        counts: delta.counts,
        inventoryTransitionCount: delta.inventoryTransitionCount,
        destructiveActionAuthorized: delta.destructiveActionAuthorized
      } : null,
      privateOutputPath: outputPath,
      privateDeltaOutputPath: deltaOutputPath
    }, null, 2));
    process.exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'DRY_RUN_BUILD_FAILED';
    console.error(`HOLD: ${code}. No database write or consumer switch performed.`);
    process.exitCode = 2;
  }
}
