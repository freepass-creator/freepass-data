import { mkdir, realpath, writeFile, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createErp5InspectionDataAccessRuntime } from './data-access-runtime.js';

// Fixed private destination, outside the repository. No arbitrary --out or database writes.
if (process.argv.slice(2).join(' ') !== '--live-read-only') {
  console.error('Usage: npx tsx src/jobs/inspect-erp5-source.ts --live-read-only');
  process.exitCode = 2;
} else {
  try {
    // Avoid packaged-app LocalAppData virtualization; keep source evidence outside Git.
    const privateRoot = join(homedir(), '.codex', 'private', 'freepass-data-source-captures');
    await mkdir(privateRoot, { recursive: true });
    if ((await realpath(privateRoot)).toLowerCase() !== privateRoot.toLowerCase()) throw new Error('PRIVATE_PATH_REDIRECT');
    for (let folder = privateRoot; ; folder = dirname(folder)) {
      if (await stat(join(folder, '.git')).then(() => true, () => false)) throw new Error('PRIVATE_PATH_IN_GIT');
      if (dirname(folder) === folder) break;
    }
    const token = process.env.FREEPASS_ERP5_READ_ACCESS_TOKEN ?? '';
    const runtime = createErp5InspectionDataAccessRuntime({
      accessToken: token,
      evidenceBucket:
        process.env.FREEPASS_DATA_EVIDENCE_BUCKET ??
        process.env.EVIDENCE_BUCKET ??
        ''
    });
    const capture = await runtime.capture();
    const runDir = join(privateRoot, randomUUID());
    await mkdir(runDir);
    const capturePath = join(runDir, 'capture.json');
    await writeFile(capturePath, JSON.stringify(capture), { flag: 'wx', mode: 0o600 });
    // Fresh file readback validates the stored evidence before producing the summary.
    const report = runtime.inspectCapture(JSON.parse(await readFile(capturePath, 'utf8')));
    await writeFile(join(runDir, 'summary.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ ...report, privateCapturePath: capturePath }, null, 2));
    process.exitCode = 2; // Successful collection still leaves production readiness on HOLD.
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'CAPTURE_OR_READBACK_FAILED';
    console.error(`HOLD: ${code}. No database write or consumer switch performed.`);
    process.exitCode = 2;
  }
}
