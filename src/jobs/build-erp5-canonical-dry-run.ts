import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildErp5CanonicalDryRun } from '../adapters/erp5-source-capture.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--capture') {
  console.error('Usage: npx tsx src/jobs/build-erp5-canonical-dry-run.ts --capture <private capture.json>');
  process.exitCode = 2;
} else {
  try {
    const privateRoot = resolve(join(homedir(), '.codex', 'private', 'freepass-data-source-captures'));
    await mkdir(privateRoot, { recursive: true });
    const capturePath = await realpath(resolve(args[1]!));
    const inside = relative(privateRoot, capturePath);
    if (!inside || inside.startsWith('..') || resolve(privateRoot, inside) !== capturePath) {
      throw new Error('CAPTURE_OUTSIDE_PRIVATE_ROOT');
    }
    for (let folder = dirname(capturePath); ; folder = dirname(folder)) {
      if (await stat(join(folder, '.git')).then(() => true, () => false)) throw new Error('PRIVATE_PATH_IN_GIT');
      if (folder === privateRoot) break;
      if (dirname(folder) === folder) throw new Error('CAPTURE_OUTSIDE_PRIVATE_ROOT');
    }
    const capture = JSON.parse(await readFile(capturePath, 'utf8'));
    const dryRun = buildErp5CanonicalDryRun(capture);
    const outputPath = join(dirname(capturePath), `canonical-dry-run-${randomUUID()}.json`);
    await writeFile(outputPath, JSON.stringify(dryRun, null, 2), { flag: 'wx', mode: 0o600 });
    const readback = JSON.parse(await readFile(outputPath, 'utf8'));
    if (JSON.stringify(readback) !== JSON.stringify(dryRun)) {
      throw new Error('DRY_RUN_READBACK_MISMATCH');
    }
    console.log(JSON.stringify({
      version: dryRun.version,
      status: dryRun.status,
      canonicalWriteAuthorized: dryRun.canonicalWriteAuthorized,
      sourceDigest: dryRun.sourceDigest,
      digest: dryRun.digest,
      counts: dryRun.counts,
      issueCounts: dryRun.issueCounts,
      privateOutputPath: outputPath
    }, null, 2));
    process.exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'DRY_RUN_BUILD_FAILED';
    console.error(`HOLD: ${code}. No database write or consumer switch performed.`);
    process.exitCode = 2;
  }
}
