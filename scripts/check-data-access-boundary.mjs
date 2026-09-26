import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const src = path.join(root, 'src');
const allowedRawInfraConsumers = new Set([
  'src/bootstrap.ts',
  'src/api/data-access-runtime.ts',
  'src/jobs/data-access-runtime.ts'
]);

const liveFirestoreAdapters = new Set([
  '../adapters/legacy-freepasserp3.js',
  '../adapters/erp5-source-capture.js'
]);

const isRawFirestoreModule = (specifier) =>
  /(?:^|\/)infra\/[^/]*firestore[^/]*\.js$/.test(specifier);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
  });
}

function imports(text) {
  const out = [];
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) out.push(match[1]);
  for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(match[1]);
  return out;
}

const violations = [];
for (const file of walk(src)) {
  const rel = path.relative(root, file).replaceAll('\\', '/');
  const layer = rel.split('/')[1] ?? '';
  const text = fs.readFileSync(file, 'utf8');

  if (
    text.includes('https://firestore.googleapis.com/') &&
    !['infra', 'adapters'].includes(layer)
  ) {
    violations.push({
      file: rel,
      import: 'firestore.googleapis.com',
      reason: 'direct Firestore REST access is restricted to FreePass Data infra/adapters'
    });
  }

  for (const specifier of imports(text)) {
    if (
      specifier === 'firebase-admin/firestore' &&
      !['infra', 'adapters'].includes(layer)
    ) {
      violations.push({
        file: rel,
        import: specifier,
        reason: 'Firestore SDK is restricted to FreePass Data infra/adapters; execution must be gateway-wrapped'
      });
    }

    if (
      ['api', 'jobs'].includes(layer) &&
      liveFirestoreAdapters.has(specifier) &&
      rel !== 'src/jobs/data-access-runtime.ts'
    ) {
      violations.push({
        file: rel,
        import: specifier,
        reason: 'live Firebase adapter must be hidden behind an audited composition runtime'
      });
    }

    const raw = isRawFirestoreModule(specifier);
    if (
      raw &&
      layer !== 'infra' &&
      !allowedRawInfraConsumers.has(rel)
    ) {
      violations.push({
        file: rel,
        import: specifier,
        reason: 'raw Firestore store/reader bypasses the Data Access Gateway'
      });
    }
  }
}

const server = fs.readFileSync(path.join(src, 'api', 'consumer-server.ts'), 'utf8');
if (
  !server.includes("from './data-access-runtime.js'") ||
  server.includes('firestore-projection-reader') ||
  server.includes('firestore-data-health-reader') ||
  server.includes('firestore-data-access-log')
) {
  violations.push({
    file: 'src/api/consumer-server.ts',
    import: 'composition',
    reason: 'consumer server must receive raw Firebase resources only through data-access-runtime'
  });
}

const requiredGatewayUsage = new Map([
  ['src/api/consumer-gateway.ts', ['access.read(', 'access.deny(']],
  ['src/api/server.ts', ['stores.access.read(', 'stores.access.write(', 'stores.access.deny(']],
  ['src/jobs/ingest-legacy-products.ts', ['runtime.readLegacySnapshot(', 'runtime.ingestLegacySnapshot(']],
  ['src/jobs/inspect-erp5-source.ts', ['runtime.capture(']],
  ['src/jobs/prepare-sheet-publication-bridge.ts', ['runtime.prepare(']],
  ['src/jobs/record-sheet-delivery-evidence.ts', ['runtime.record(']],
  ['src/jobs/assess-sheet-consumer-cutover.ts', ['runtime.assess(']],
  ['src/jobs/check-sheet-consumer-health.ts', ['runtime.health(']],
  ['src/jobs/check-consumer-runtime-evidence.ts', ['runtime.report(']],
  ['src/jobs/check-consumer-health.ts', ['runtime.health(']],
  ['src/jobs/check-consumer-readiness.ts', ['runtime.readiness(']],
  ['src/jobs/check-central-firestore.ts', ['runtime.access.read(']]
]);
for (const [relativeFile, required] of requiredGatewayUsage) {
  const content = fs.readFileSync(path.join(root, relativeFile), 'utf8');
  for (const marker of required) {
    if (!content.includes(marker)) {
      violations.push({
        file: relativeFile,
        import: marker,
        reason: 'known live Firebase path no longer passes through Data Access Gateway'
      });
    }
  }
}

const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
if (!/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/s.test(rules)) {
  violations.push({
    file: 'firestore.rules',
    import: 'rules',
    reason: 'browser/mobile direct Firestore access must remain denied'
  });
}

if (violations.length) {
  console.error('Data Access Gateway boundary violations detected:');
  for (const item of violations) {
    console.error(`- ${item.file}: ${item.import} — ${item.reason}`);
  }
  process.exit(1);
}

console.log('Data Access Gateway boundary OK');
