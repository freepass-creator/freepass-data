import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = process.cwd();
const contractsDir = path.join(root, 'contracts');
const profile = JSON.parse(fs.readFileSync(path.join(contractsDir, 'freepass-data-standards-profile.v1.json'), 'utf8'));
const failures = [];
const contractJsonFiles = fs.readdirSync(contractsDir).filter((name) => name.endsWith('.json')).sort();
const schemaFiles = contractJsonFiles.filter((name) => name.endsWith('.schema.json'));
const knownAutomatedCheckers = new Set(['AJV_2020_COMPILE_ALL_SCHEMAS', 'RFC3339_SCHEMA_TEMPORAL_FIELDS']);
const executedCheckers = new Set();

if (profile.profile !== 'freepass-data-standards-profile/v1') failures.push('PROFILE_ID_INVALID');
if (!['PARTIAL', 'COMPLETE'].includes(profile.status)) failures.push('PROFILE_STATUS_INVALID');
if (!Array.isArray(profile.standards) || profile.standards.length === 0) failures.push('STANDARDS_EMPTY');
if (!Array.isArray(profile.platformRequiredCapabilities) || profile.platformRequiredCapabilities.length === 0) failures.push('CAPABILITIES_EMPTY');
if (!Array.isArray(profile.unresolvedCapabilities)) failures.push('UNRESOLVED_CAPABILITIES_INVALID');
if (profile.status === 'COMPLETE' && profile.unresolvedCapabilities.length > 0) failures.push('FALSE_COMPLETE_WITH_UNRESOLVED_CAPABILITIES');

const ids = new Set();
for (const standard of profile.standards ?? []) {
  if (!standard.id || ids.has(standard.id)) failures.push(`STANDARD_ID_INVALID_OR_DUPLICATE:${standard.id ?? ''}`);
  ids.add(standard.id);
  if (!/^https:\/\//.test(standard.reference ?? '')) failures.push(`STANDARD_REFERENCE_NOT_HTTPS:${standard.id}`);
  if (!['REQUIRED', 'TARGET'].includes(standard.level)) failures.push(`STANDARD_LEVEL_INVALID:${standard.id}`);
  if (!['AUTOMATED', 'HOLD', 'NOT_APPLICABLE'].includes(standard.verification)) failures.push(`STANDARD_VERIFICATION_INVALID:${standard.id}`);
  if (standard.verification === 'AUTOMATED' && !knownAutomatedCheckers.has(standard.checker)) failures.push(`MISSING_AUTOMATED_CHECK:${standard.id}`);
  if (standard.verification !== 'AUTOMATED' && standard.checker) failures.push(`NON_AUTOMATED_CHECKER_DECLARED:${standard.id}`);
  if (profile.status === 'COMPLETE' && standard.verification === 'HOLD') failures.push(`STANDARD_NOT_VERIFIED_FOR_COMPLETE:${standard.id}`);
  if (standard.verification === 'NOT_APPLICABLE' && !standard.notApplicableDecisionRef) failures.push(`NOT_APPLICABLE_DECISION_REQUIRED:${standard.id}`);
}

const schemaIds = new Set();
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats.default(ajv);
const schemas = schemaFiles.map((file) => ({
  file,
  schema: JSON.parse(fs.readFileSync(path.join(contractsDir, file), 'utf8')),
}));

function resolveLocalRef(rootSchema, candidate) {
  if (!candidate || typeof candidate !== 'object' || typeof candidate.$ref !== 'string' || !candidate.$ref.startsWith('#/')) return candidate;
  return candidate.$ref.slice(2).split('/').reduce((value, segment) => value?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')], rootSchema);
}

function acceptsOnlyRfc3339Temporal(rootSchema, candidate, seen = new Set()) {
  const resolved = resolveLocalRef(rootSchema, candidate);
  if (!resolved || typeof resolved !== 'object' || seen.has(resolved)) return false;
  seen.add(resolved);
  if (['date', 'date-time'].includes(resolved.format) && (resolved.type === 'string' || !resolved.type)) return true;
  const alternatives = resolved.anyOf ?? resolved.oneOf;
  if (!Array.isArray(alternatives) || alternatives.length === 0) return false;
  return alternatives.every((item) => item?.type === 'null' || acceptsOnlyRfc3339Temporal(rootSchema, item, new Set(seen)));
}

function checkTimestampProperties(file, rootSchema) {
  const visit = (node, pointer = '#') => {
    if (!node || typeof node !== 'object') return;
    for (const [name, propertySchema] of Object.entries(node.properties ?? {})) {
      const propertyPointer = `${pointer}/properties/${name}`;
      if (/(?:At|Time)$/.test(name) && !acceptsOnlyRfc3339Temporal(rootSchema, propertySchema)) failures.push(`RFC3339_TEMPORAL_SCHEMA_INVALID:${file}:${propertyPointer}`);
      visit(propertySchema, propertyPointer);
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'properties' && typeof value === 'object') visit(value, `${pointer}/${key}`);
  };
  visit(rootSchema);
}
for (const { file, schema } of schemas) {
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') failures.push(`JSON_SCHEMA_DIALECT:${file}`);
  if (typeof schema.$id !== 'string' || !schema.$id.startsWith('https://freepass.teamjpk.com/contracts/')) failures.push(`SCHEMA_ID_INVALID:${file}`);
  if (schemaIds.has(schema.$id)) failures.push(`SCHEMA_ID_DUPLICATE:${file}`);
  schemaIds.add(schema.$id);
  try {
    ajv.addSchema(schema);
  } catch (error) {
    failures.push(`SCHEMA_REGISTER_FAILED:${file}:${error.message}`);
  }
}
executedCheckers.add('AJV_2020_COMPILE_ALL_SCHEMAS');
for (const { file, schema } of schemas) checkTimestampProperties(file, schema);
executedCheckers.add('RFC3339_SCHEMA_TEMPORAL_FIELDS');

for (const standard of profile.standards ?? []) {
  if (standard.verification === 'AUTOMATED' && !executedCheckers.has(standard.checker)) failures.push(`AUTOMATED_CHECK_NOT_EXECUTED:${standard.id}`);
}
for (const { file, schema } of schemas) {
  try {
    if (!ajv.getSchema(schema.$id)) failures.push(`SCHEMA_COMPILE_FAILED:${file}:validator unavailable`);
  } catch (error) {
    failures.push(`SCHEMA_COMPILE_FAILED:${file}:${error.message}`);
  }
}

const declaredInstances = [...(profile.contractInventory?.instanceContracts ?? [])].sort();
const actualInstances = contractJsonFiles.filter((name) => !name.endsWith('.schema.json')).sort();
for (const file of actualInstances) if (!declaredInstances.includes(file)) failures.push(`UNCLASSIFIED_CONTRACT_JSON:${file}`);
for (const file of declaredInstances) if (!actualInstances.includes(file)) failures.push(`DECLARED_CONTRACT_JSON_MISSING:${file}`);
if (schemaFiles.length === 0) failures.push('NO_SCHEMA_CONTRACTS_FOUND');

if (failures.length) {
  console.error('FreePass Data standards conformance failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(JSON.stringify({status: profile.status, profile: profile.profile, schemasCompiled: schemaFiles.length, instanceContractsAccounted: actualInstances.length, standardsTracked: profile.standards.length, unresolvedCapabilities: profile.unresolvedCapabilities}, null, 2));
