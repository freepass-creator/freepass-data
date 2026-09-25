import { readFileSync, writeFileSync } from 'node:fs';
import { stableDigest } from '../shared/stable-digest.js';
import { mapLegacyNewcarSnapshotToEstimateMaster } from '../adapters/erp4-estimate-master.js';

const S = (value: unknown) => String(value ?? '').trim();
const arg = (name: string) => {
  const prefix = `--${name}=`;
  return S(process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length));
};

const feedPath = arg('feed');
const masterPath = arg('master');
const outputPath = arg('output');
if (!feedPath || !masterPath) {
  throw new Error('Usage: tsx src/jobs/build-estimate-newcar-master-dry-run.ts --feed=<current-feed.json> --master=<vehicle-trim-master.json> [--output=<result.json>]');
}

const feed = JSON.parse(readFileSync(feedPath, 'utf8'));
const master = JSON.parse(readFileSync(masterPath, 'utf8'));
const result = mapLegacyNewcarSnapshotToEstimateMaster(feed, master);

const artifact = {
  contract: 'estimate-newcar-master-dry-run/v1',
  generatedAt: new Date().toISOString(),
  sourceEvidence: {
    feed: {
      path: feedPath,
      dataAsOf: S(feed?.data_as_of) || null,
      rowCount: Array.isArray(feed?.rows) ? feed.rows.length : 0,
      digest: stableDigest(feed),
    },
    trimMaster: {
      path: masterPath,
      dataAsOf: S(master?.data_as_of) || null,
      rowCount: Array.isArray(master?.records) ? master.records.length : 0,
      digest: stableDigest(master),
    },
  },
  summary: result.summary,
  records: result.records,
};

const text = JSON.stringify(artifact, null, 2) + '\n';
if (outputPath) writeFileSync(outputPath, text, 'utf8');
console.log(JSON.stringify({
  contract: artifact.contract,
  sourceEvidence: artifact.sourceEvidence,
  summary: artifact.summary,
  output: outputPath || null,
}, null, 2));

if (result.summary.active === 0) process.exitCode = 2;
else if (result.summary.hold > 0) process.exitCode = 1;
