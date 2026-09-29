import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const contractsDir = path.join(root, 'contracts');
const profile = JSON.parse(fs.readFileSync(path.join(contractsDir, 'freepass-data-standards-profile.v1.json'), 'utf8'));
const failures = [];
const schemaFiles = fs.readdirSync(contractsDir).filter((name) => name.endsWith('.schema.json')).sort();

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
}

const schemaIds = new Set();
for (const file of schemaFiles) {
  const schema = JSON.parse(fs.readFileSync(path.join(contractsDir, file), 'utf8'));
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') failures.push(`JSON_SCHEMA_DIALECT:${file}`);
  if (typeof schema.$id !== 'string' || !schema.$id.startsWith('https://freepass.teamjpk.com/contracts/')) failures.push(`SCHEMA_ID_INVALID:${file}`);
  if (schemaIds.has(schema.$id)) failures.push(`SCHEMA_ID_DUPLICATE:${file}`);
  schemaIds.add(schema.$id);
}

if (failures.length) {
  console.error('FreePass Data standards conformance failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(JSON.stringify({status: profile.status, profile: profile.profile, schemasChecked: schemaFiles.length, standardsTracked: profile.standards.length, unresolvedCapabilities: profile.unresolvedCapabilities}, null, 2));
