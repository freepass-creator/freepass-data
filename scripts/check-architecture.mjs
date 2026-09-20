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
  migration: new Set(['ports', 'application', 'adapters', 'infra', 'api', 'jobs'])
};

const firebaseForbiddenIn = new Set(['domain', 'ports', 'application']);

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
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

for (const file of walk(srcRoot)) {
  const layer = layerOf(file);
  const text = fs.readFileSync(file, 'utf8');
  const forbidden = forbiddenTargets[layer] ?? new Set();

  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier) continue;

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

if (violations.length) {
  console.error('Architecture boundary violations detected:');
  for (const item of violations) {
    console.error(`- ${item.file}: ${item.import} — ${item.reason}`);
  }
  process.exit(1);
}

console.log('Architecture boundaries OK');
