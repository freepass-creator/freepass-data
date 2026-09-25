import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const src = path.join(root, 'src');
const allowedRawInfraConsumers = new Set([
  'src/bootstrap.ts',
  'src/api/data-access-runtime.ts',
  'src/jobs/data-access-runtime.ts'
]);

const rawFirestoreModules = [
  'firestore-store',
  'firestore-projection-reader',
  'firestore-data-health-reader',
  'source-firestore-store'
];

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

  for (const specifier of imports(text)) {
    if (specifier === 'firebase-admin/firestore' && layer !== 'infra') {
      violations.push({
        file: rel,
        import: specifier,
        reason: 'Firestore SDK is restricted to FreePass Data infra'
      });
    }

    const raw = rawFirestoreModules.find((name) => specifier.includes(name));
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
