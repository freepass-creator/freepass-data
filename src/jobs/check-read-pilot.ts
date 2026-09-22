import { readFile } from 'node:fs/promises';
import { checkReadPilot } from '../migration/read-pilot.js';

// Deliberately imports no runtime/bootstrap: even inherited Firestore env cannot write.
const args = process.argv.slice(2);
if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
  console.error('Usage: npm run pilot:check -- <private-local-evidence.json>');
  process.exitCode = 2;
} else {
  try {
    const input = JSON.parse((await readFile(args[0], 'utf8')).replace(/^\uFEFF/, ''));
    const report = checkReadPilot(input);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'SNAPSHOT_MATCH' ? 0 : report.status === 'MISMATCH' ? 1 : 2;
  } catch {
    console.error('HOLD: evidence file unavailable or invalid JSON. No production action performed.');
    process.exitCode = 2;
  }
}
