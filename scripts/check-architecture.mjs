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

const sourceLayoutOwner = path.join(srcRoot, 'infra', 'source-firestore-layout.ts');
const sourcePhysicalNames = [
  'sources',
  'source_runs',
  'source_heads',
  'raw_records',
  'normalized_candidates',
  'field_lineage'
];

for (const file of walk(srcRoot)) {
  if (path.resolve(file) === path.resolve(sourceLayoutOwner)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const collectionName of sourcePhysicalNames) {
    const literal = new RegExp(`['"]${collectionName}['"]`);
    if (literal.test(text)) {
      violations.push({
        file: path.relative(repoRoot, file),
        layer: layerOf(file),
        import: collectionName,
        reason: 'Source Firestore physical layout must come from src/infra/source-firestore-layout.ts'
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
