import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, 'src');

const forbiddenTargets = {
  domain: new Set(['ports', 'application', 'adapters', 'infra', 'api', 'jobs', 'migration']),
  ports: new Set(['application', 'adapters', 'infra', 'api', 'jobs', 'migration']),
  application: new Set(['infra', 'api', 'jobs']),
  adapters: new Set(['application', 'infra', 'api', 'jobs']),
  infra: new Set(['application', 'adapters', 'api', 'jobs', 'migration']),
  migration: new Set(['ports', 'application', 'adapters', 'infra', 'api', 'jobs']),
  shared: new Set(['ports', 'application', 'adapters', 'infra', 'api', 'jobs', 'migration'])
};

const firebaseForbiddenIn = new Set(['domain', 'ports', 'application', 'shared']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
  });
}

function layerOf(file) {
  const relative = path.relative(srcRoot, file).replaceAll('\\', '/');
  const [first] = relative.split('/');
  return first || 'root';
}

function relativeTargetLayer(file, specifier) {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
  const relative = path.relative(srcRoot, resolved).replaceAll('\\', '/');
  if (relative.startsWith('..')) return null;
  return relative.split('/')[0] || 'root';
}

const violations = [];

function importSpecifiers(text) {
  const out = [];
  for (const statement of text.split(';')) {
    const fromMatch = statement.match(
      /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/
    );
    if (fromMatch?.[1]) {
      out.push(fromMatch[1]);
      continue;
    }

    const sideEffectMatch = statement.match(/\bimport\s+['"]([^'"]+)['"]/);
    if (sideEffectMatch?.[1]) out.push(sideEffectMatch[1]);
  }
  return out;
}

for (const file of walk(srcRoot)) {
  const layer = layerOf(file);
  const text = fs.readFileSync(file, 'utf8');
  const forbidden = forbiddenTargets[layer] ?? new Set();

  for (const specifier of importSpecifiers(text)) {

    if (firebaseForbiddenIn.has(layer) && specifier.startsWith('firebase-admin')) {
      violations.push({
        file: path.relative(repoRoot, file),
        layer,
        import: specifier,
        reason: 'Firebase SDK is forbidden in Domain/Port/Application layers'
      });
      continue;
    }

    const targetLayer = relativeTargetLayer(file, specifier);
    if (targetLayer && forbidden.has(targetLayer)) {
      violations.push({
        file: path.relative(repoRoot, file),
        layer,
        import: specifier,
        reason: `${layer} must not depend on ${targetLayer}`
      });
    }
  }
}

const firebaseTargetOwner = path.join(srcRoot, 'infra', 'firebase-target.ts');

for (const file of walk(srcRoot)) {
  const layer = layerOf(file);
  if (!new Set(['infra', 'api', 'jobs']).has(layer)) continue;
  if (path.resolve(file) === path.resolve(firebaseTargetOwner)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('firebase-admin/app')) {
    violations.push({
      file: path.relative(repoRoot, file),
      layer,
      import: 'firebase-admin/app',
      reason: 'Central FreePass Data Firebase app initialization belongs only in src/infra/firebase-target.ts'
    });
  }
}

const firestoreLayoutOwner = path.join(srcRoot, 'infra', 'firestore-layout.ts');
const firestoreLayoutText = fs.readFileSync(firestoreLayoutOwner, 'utf8');
const firestorePhysicalNames = [
  ...firestoreLayoutText.matchAll(/:\\s*'([^']+)'/g)
]
  .map((match) => match[1])
  .filter((value) => value !== '__');

const physicalLayoutLayers = new Set(['infra', 'api', 'jobs', 'adapters', 'migration']);

for (const file of walk(srcRoot)) {
  if (path.resolve(file) === path.resolve(firestoreLayoutOwner)) continue;
  const layer = layerOf(file);
  if (!physicalLayoutLayers.has(layer)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const collectionName of firestorePhysicalNames) {
    const literal = new RegExp(`['"]${collectionName}['"]`);
    if (literal.test(text)) {
      violations.push({
        file: path.relative(repoRoot, file),
        layer,
        import: collectionName,
        reason: 'FreePass Data Firestore physical layout must come from src/infra/firestore-layout.ts'
      });
    }
  }
}

for (const file of walk(srcRoot)) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\bSourceStore\b/.test(text)) {
    violations.push({
      file: path.relative(repoRoot, file),
      layer: layerOf(file),
      import: 'SourceStore',
      reason: 'Use the responsibility-specific SourceIngestionStore; do not recreate the ambiguous source repository port'
    });
  }
  if (/\.sourceFirestoreDocumentId\s*\(/.test(text)) {
    violations.push({
      file: path.relative(repoRoot, file),
      layer: layerOf(file),
      import: '.sourceFirestoreDocumentId(',
      reason: 'sourceFirestoreDocumentId is a shared function, not an object method'
    });
  }
}

for (const forbiddenDataContract of [
  'contracts/freepass-quote-v2.schema.json',
  'contracts/put-issued-quote-command-v1.schema.json'
]) {
  if (fs.existsSync(path.join(repoRoot, forbiddenDataContract))) {
    violations.push({
      file: forbiddenDataContract,
      layer: 'contract',
      import: forbiddenDataContract,
      reason: 'Quote issuance/calculation contracts belong to the FreePass Estimate product boundary, not FreePass Data'
    });
  }
}

if (violations.length) {
  console.error('Architecture boundary violations detected:');
  for (const item of violations) {
    console.error(`- ${item.file}: ${item.import} — ${item.reason}`);
  }
  process.exit(1);
}

const auditWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'erp5-continuous-audit.yml'),
  'utf8'
);
const watchdogWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'erp5-audit-watchdog.yml'),
  'utf8'
);
if (
  !watchdogWorkflow.includes("cron: '7 * * * *'") ||
  !watchdogWorkflow.includes('ERP5_AUDIT_MAX_GAP_MINUTES') ||
  !watchdogWorkflow.includes('ERP5_READ_SERVICE_ACCOUNT') ||
  !watchdogWorkflow.includes('latest.json') ||
  !watchdogWorkflow.includes('erp5-audit-watchdog/1') ||
  !watchdogWorkflow.includes('exit 2') ||
  watchdogWorkflow.includes('ERP5_POINTER_SERVICE_ACCOUNT') ||
  watchdogWorkflow.includes('gcloud storage cp') ||
  watchdogWorkflow.includes('--apply')
) {
  console.error('ERP5 audit watchdog must remain independent, hourly and read-only');
  process.exit(1);
}


if (!auditWorkflow.includes("cron: '37 * * * *'")) {
  console.error('Continuous audit must remain on the hourly minute-37 schedule');
  process.exit(1);
}
const consumerHealthStart = auditWorkflow.indexOf('- name: Check all consumer health');
const consumerHealthEnd = auditWorkflow.indexOf('- name: Check consumer readiness');
const consumerHealthStep = auditWorkflow.slice(consumerHealthStart, consumerHealthEnd);
if (
  consumerHealthStart < 0 ||
  consumerHealthEnd <= consumerHealthStart ||
  !consumerHealthStep.includes('--scheduled-read-only') ||
  !consumerHealthStep.includes('CONSUMER_HEALTH_MAX_AGE_MINUTES') ||
  !consumerHealthStep.includes('consumer-health-summary.json') ||
  !consumerHealthStep.includes('consumer-health.json') ||
  consumerHealthStep.includes('--apply') ||
  consumerHealthStep.includes('FREEPASS_SHEET_EVIDENCE_WRITE_AUTHORIZED')
) {
  console.error('Scheduled unified consumer health must remain explicit-policy and read-only');
  process.exit(1);
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
);
if (
  packageJson.scripts?.['check:consumer-health'] !==
  'tsx src/jobs/check-consumer-health.ts'
) {
  console.error('Unified consumer health command must remain registered');
  process.exit(1);
}

if (
  packageJson.scripts?.['check:consumer-readiness'] !==
  'tsx src/jobs/check-consumer-readiness.ts'
) {
  console.error('Consumer readiness command must remain registered');
  process.exit(1);
}

if (
  packageJson.scripts?.['build:data-control-tower'] !==
  'tsx src/jobs/build-data-control-tower.ts'
) {
  console.error('FreePass Data control tower builder must remain registered');
  process.exit(1);
}

const readinessStart = auditWorkflow.indexOf('- name: Check consumer readiness');
const readinessEnd = auditWorkflow.indexOf('- name: Check F01/F86 consumer health');
const readinessStep = auditWorkflow.slice(readinessStart, readinessEnd);
if (
  readinessStart < 0 ||
  readinessEnd <= readinessStart ||
  !readinessStep.includes('--scheduled-read-only') ||
  !readinessStep.includes('CONSUMER_READINESS_MAX_AGE_MINUTES') ||
  !readinessStep.includes('consumer-readiness-summary.json') ||
  !readinessStep.includes('consumer-readiness.json') ||
  readinessStep.includes('--apply') ||
  readinessStep.includes('FREEPASS_SHEET_EVIDENCE_WRITE_AUTHORIZED')
) {
  console.error('Scheduled consumer readiness must remain explicit-policy and read-only');
  process.exit(1);
}

const sheetHealthStart = auditWorkflow.indexOf('- name: Check F01/F86 consumer health');
const sheetHealthEnd = auditWorkflow.indexOf('- name: Capture the current FULL Firestore snapshot');
const sheetHealthStep = auditWorkflow.slice(sheetHealthStart, sheetHealthEnd);
if (
  sheetHealthStart < 0 ||
  sheetHealthEnd <= sheetHealthStart ||
  !sheetHealthStep.includes('--scheduled-read-only') ||
  !sheetHealthStep.includes('SHEET_EVIDENCE_MAX_AGE_MINUTES') ||
  !sheetHealthStep.includes('sheet-consumer-health-summary.json') ||
  sheetHealthStep.includes('--apply') ||
  sheetHealthStep.includes('FREEPASS_SHEET_EVIDENCE_WRITE_AUTHORIZED')
) {
  console.error('Scheduled Sheet consumer health must remain explicit-policy and read-only');
  process.exit(1);
}

const auditFreshnessStart = auditWorkflow.indexOf('- name: Check scheduled audit freshness');
const auditFreshnessEnd = auditWorkflow.indexOf('- name: Build immutable dry-run and delta evidence');
const auditFreshnessStep = auditWorkflow.slice(auditFreshnessStart, auditFreshnessEnd);
if (
  auditFreshnessStart < 0 ||
  auditFreshnessEnd <= auditFreshnessStart ||
  !auditFreshnessStep.includes('ERP5_AUDIT_MAX_GAP_MINUTES') ||
  !auditFreshnessStep.includes('audit-schedule-health.json') ||
  !auditWorkflow.includes('audit-schedule-health.json') ||
  auditFreshnessStep.includes('--apply') ||
  auditFreshnessStep.includes('canonicalWriteAuthorized: true')
) {
  console.error('Scheduled audit freshness evidence must remain explicit-policy and read-only');
  process.exit(1);
}

const controlTowerStart = auditWorkflow.indexOf('- name: Build FreePass Data control tower');
const controlTowerEnd = auditWorkflow.indexOf('- name: Persist immutable evidence and read it back');
const controlTowerStep = auditWorkflow.slice(controlTowerStart, controlTowerEnd);
if (
  controlTowerStart < 0 ||
  controlTowerEnd <= controlTowerStart ||
  !controlTowerStep.includes('build:data-control-tower') ||
  !controlTowerStep.includes('data-control-tower.json') ||
  !auditWorkflow.includes('gcloud storage cp "$run_uri/data-control-tower.json"') ||
  !auditWorkflow.includes('cmp -s data-control-tower.json evidence-readback/data-control-tower.json') ||
  !auditWorkflow.includes('data-control-tower.json') ||
  controlTowerStep.includes('--apply')
) {
  console.error('FreePass Data control tower must remain read-only and evidence-backed');
  process.exit(1);
}

const captureStart = auditWorkflow.indexOf('- name: Capture the current FULL Firestore snapshot');
const captureEnd = auditWorkflow.indexOf('- name: Load the last accepted observation pointer');
const dryRunStart = auditWorkflow.indexOf('- name: Build immutable dry-run and delta evidence');
const dryRunEnd = auditWorkflow.indexOf('- name: Build the source identity and count card');
const captureStep = auditWorkflow.slice(captureStart, captureEnd);
const dryRunStep = auditWorkflow.slice(dryRunStart, dryRunEnd);
if (
  captureStart < 0 || captureEnd <= captureStart || dryRunStart < 0 || dryRunEnd <= dryRunStart ||
  !captureStep.includes("' capture-summary.json >/dev/null") ||
  captureStep.includes('.publicationGate.') ||
  !dryRunStep.includes("' dry-run-summary.json >/dev/null") ||
  !dryRunStep.includes('.publicationGate.activeReleaseAuthorized == false') ||
  !dryRunStep.includes('.publicationGate.sourceCoverage.mode == "FULL"')
) {
  console.error('Continuous-audit evidence predicates are attached to the wrong output contract');
  process.exit(1);
}

console.log('Architecture boundaries OK');
