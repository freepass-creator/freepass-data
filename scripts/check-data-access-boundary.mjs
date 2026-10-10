import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const src = path.join(root, 'src');
const allowedRawInfraConsumers = new Set([
  'src/bootstrap.ts',
  'src/api/data-access-runtime.ts',
  'src/jobs/data-access-runtime.ts',
  'src/jobs/apply-iancar-policy-sync.ts',
  'src/jobs/apply-billincar-policy-repair.ts',
  'src/jobs/apply-vehicle-name-reference-repair.ts'
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
  ['src/jobs/ingest-erp5-source.ts', ['readRuntime.capture(', 'writeRuntime.ingestRawBatch(']],
  ['src/jobs/ingest-settlement-source.ts', ['runtime.ingestRawBatch(']],
  ['src/jobs/inspect-erp5-source.ts', ['runtime.capture(']],
  ['src/jobs/prepare-sheet-publication-bridge.ts', ['runtime.prepare(']],
  ['src/jobs/record-sheet-delivery-evidence.ts', ['runtime.record(']],
  ['src/jobs/assess-sheet-consumer-cutover.ts', ['runtime.assess(']],
  ['src/jobs/check-sheet-consumer-health.ts', ['runtime.health(']],
  ['src/jobs/check-consumer-runtime-evidence.ts', ['runtime.report(']],
  ['src/jobs/check-consumer-health.ts', ['runtime.health(']],
  ['src/jobs/check-consumer-readiness.ts', ['runtime.readiness(']],
  ['src/jobs/check-central-firestore.ts', ['runtime.access.read(']],
  ['src/jobs/apply-iancar-policy-sync.ts', ['runtime.access.write(']],
  ['src/jobs/apply-billincar-policy-repair.ts', ['runtime.access.write(']],
  ['src/jobs/apply-vehicle-name-reference-repair.ts', ['runtime.access.write(']]
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

// Data that entered FreePass Data is retired by status, not erased. Every field delete and
// whole-document replacement must match a reviewed call signature below (receiver and
// target document for set()); a new call, a changed target, or a stale entry fails. Comments and string contents are ignored.
const preservationAllowlist = [
  { kind: 'fieldDelete', file: 'src/infra/iancar-publication-withdrawal-firestore.ts',
    call: 'const patch = row.exists ? Object.fromEntries(Object.keys(row.patch).map(key => [key, key in row.data ? row.data[key] : FieldValue.delete()]))',
    reason: 'restore from typed backup; PR1c narrows this' },
  { kind: 'replaceSet', file: 'src/infra/admin-workflow-firestore.ts', call: 'tx.set(ref)',
    reason: 'gateway replacement; refused unless every stored top-level field is kept and no other mutation touches the document' },
  { kind: 'replaceSet', file: 'src/infra/estimate-artifacts-firestore.ts', call: 'tx.set(headRef)', count: 2,
    reason: 'head pointer; versions are create-only' },
  { kind: 'replaceSet', file: 'src/infra/firestore-store.ts', call: 'native.set(this.db.collection(C.vehicleAssets).doc(asset.id))',
    reason: 'current state; revision/audit are appended by callers, not enforced by the store' },
  { kind: 'replaceSet', file: 'src/infra/firestore-store.ts', call: 'native.set(this.db.collection(C.offers).doc(offer.id))',
    reason: 'current state; revision/audit are appended by callers, not enforced by the store' },
  { kind: 'replaceSet', file: 'src/infra/firestore-store.ts', call: 'native.set(this.db.collection(C.sourceBindings).doc(binding.bindingId))',
    reason: 'current binding; audit is appended by callers, no revision' },
  { kind: 'replaceSet', file: 'src/infra/firestore-store.ts', call: 'batch.set(this.db.collection(C.projectionLineage).doc(item.lineageRecordId))',
    reason: 'rebuildable projection lineage' },
  { kind: 'replaceSet', file: 'src/infra/firestore-store.ts', call: 'tx.set(activeRef)',
    reason: 'active release pointer; releases are kept' },
  { kind: 'replaceSet', file: 'src/infra/source-firestore-store.ts', call: 'tx.set(headRef)',
    reason: 'source head pointer; runs and RAW are create-only' },
  { kind: 'replaceSet', file: 'src/infra/vehicle-master-firestore-store.ts', call: 'tx.set(currentRef)', count: 2,
    reason: 'current record; revisions are create-only' }
];

/** A '/' opens a regex literal after an operator/punctuator, a keyword, or at file start. */
function startsRegexLiteral(before) {
  if (!before) return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(before)) return true;
  return /(?:^|[^\w$.])(?:return|typeof|case|do|else|in|of|yield|await|void|delete|throw|new)$/.test(before);
}

/** Start of the receiver expression ending right before `dot` (identifiers, calls, indexing). */
function receiverStart(masked, dot) {
  let index = dot;
  for (;;) {
    let k = index - 1;
    while (k >= 0 && /\s/.test(masked[k])) k--;
    if (masked[k] === ')' || masked[k] === ']') {
      let depth = 0;
      for (; k >= 0; k--) {
        if (masked[k] === ')' || masked[k] === ']') depth++;
        else if ((masked[k] === '(' || masked[k] === '[') && --depth === 0) break;
      }
      index = k;
      continue;
    }
    let start = k;
    while (start >= 0 && /[\w$]/.test(masked[start])) start--;
    if (start === k) return index;
    index = start + 1;
    let p = start;
    while (p >= 0 && /\s/.test(masked[p])) p--;
    if (masked[p] !== '.') return index;
    index = masked[p - 1] === '?' ? p - 1 : p;
  }
}

/** Blank out comments and string/template contents, keeping offsets and newlines. */
function maskCode(text) {
  const out = text.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i); const stop = end < 0 ? text.length : end;
      blank(i, stop); i = stop;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2); const stop = end < 0 ? text.length : end + 2;
      blank(i, stop); i = stop;
    } else if (c === '/' && startsRegexLiteral(text.slice(Math.max(0, i - 200), i).trimEnd())) {
      // Regex literal: skip so quotes inside it are not read as strings.
      let j = i + 1; let inClass = false;
      while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j++;
      }
      blank(i + 1, j); i = j + 1;
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, j); i = j + 1;
    } else i++;
  }
  return out.join('');
}

/** Top-level argument ranges of the call whose '(' is at openIndex - 1. */
function callArgumentRanges(masked, openIndex) {
  const ranges = [];
  let depth = 0; let start = openIndex; let index = openIndex;
  for (; index < masked.length; index++) {
    const c = masked[index];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) { ranges.push([start, index]); start = index + 1; }
  }
  if (masked.slice(start, index).trim()) ranges.push([start, index]);
  return { ranges, end: index };
}

const squash = (value) => value.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/,\s*\)/g, ')').trim();
const observedPreservation = [];
for (const file of walk(src)) {
  const rel = path.relative(root, file).replaceAll('\\', '/');
  const text = fs.readFileSync(file, 'utf8');
  const masked = maskCode(text);
  // FieldValue may only be used as `FieldValue.<method>`; aliases and destructuring hide deletes.
  const withoutImports = masked.replace(/\bimport\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]*['"]/g, '');
  if (/\bFieldValue\s+as\b/.test(masked) || /\bFieldValue\b(?!\s*\.)|\bdeleteField\b/.test(withoutImports)) {
    violations.push({ file: rel, import: 'FieldValue alias', reason: 'aliased field-delete sentinel hides erasure from the preservation check' });
  }
  for (const match of masked.matchAll(/FieldValue\s*\.\s*delete\s*\(/g)) {
    const lineStart = masked.lastIndexOf('\n', match.index) + 1;
    const lineEnd = masked.indexOf('\n', match.index);
    observedPreservation.push({ kind: 'fieldDelete', file: rel, call: squash(text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd)) });
  }
  if (!/from\s+['"]firebase-admin(?:\/firestore)?['"]/.test(text) && !/\.\s*doc\s*\(/.test(masked)) continue;
  for (const match of masked.matchAll(/\.\s*set\s*\(/g)) {
    const { ranges } = callArgumentRanges(masked, match.index + match[0].length);
    const options = ranges.length >= 2 ? squash(text.slice(...ranges.at(-1))) : '';
    if (/^\{\s*(?:merge\s*:\s*true|mergeFields\s*:[^}]*)\s*,?\s*\}$/.test(options)) continue;
    // The written document is the reviewed identity, not the payload: tx/batch.set(ref, data)
    // keeps its ref argument; ref.set(data) keeps the receiver chain.
    const receiver = text.slice(receiverStart(masked, match.index), match.index);
    const target = ranges.length >= 2 ? text.slice(...ranges[0]) : '';
    observedPreservation.push({ kind: 'replaceSet', file: rel, call: squash(`${receiver}.set(${target})`) });
  }
}
const preservationKey = (item) => JSON.stringify([item.kind, item.file, squash(item.call)]);
const remaining = new Map(preservationAllowlist.map((item) => [preservationKey(item), item.count ?? 1]));
for (const item of observedPreservation) {
  const key = preservationKey(item);
  const left = remaining.get(key) ?? 0;
  if (left > 0) { remaining.set(key, left - 1); continue; }
  violations.push({
    file: item.file,
    import: `${item.kind === 'fieldDelete' ? 'FieldValue.delete()' : 'Firestore set() without merge'}: ${item.call.slice(0, 120)}`,
    reason: 'erases or replaces stored data; preserve the prior value and retire by status, or add a reviewed allowlist entry'
  });
}
for (const [key, left] of remaining) {
  if (left > 0) {
    const [kind, file, call] = JSON.parse(key);
    violations.push({ file, import: `${kind} allowlist: ${call.slice(0, 120)}`, reason: 'allowlisted call no longer exists; remove or update the entry' });
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
