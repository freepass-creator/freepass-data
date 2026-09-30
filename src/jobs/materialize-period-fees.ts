import { materializeInternalPeriodFees } from './data-access-runtime.js';

const args = process.argv.slice(2);
if (args.some((arg) => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
  throw new Error('usage: materialize-period-fees [--dry-run|--apply]');
}
console.log(JSON.stringify(await materializeInternalPeriodFees(args.includes('--apply'))));
