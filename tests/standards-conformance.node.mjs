import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const profile = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'contracts', 'freepass-data-standards-profile.v1.json'), 'utf8'));
const checker = path.join(process.cwd(), 'scripts', 'check-standards-conformance.mjs');

function withContractFixture(mutator) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freepass-standards-'));
  fs.cpSync(path.join(process.cwd(), 'contracts'), path.join(root, 'contracts'), { recursive: true });
  try {
    mutator(path.join(root, 'contracts'));
    return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the platform cannot claim COMPLETE while a capability remains unresolved', () => {
  assert.equal(profile.status, 'PARTIAL');
  assert.ok(profile.unresolvedCapabilities.length > 0);
  assert.match(profile.completionRule, /unresolvedCapabilities is empty/);
});

test('international references are explicit and uniquely identified', () => {
  for (const standard of profile.standards) {
    assert.match(standard.reference, /^https:\/\//);
    assert.ok(['REQUIRED', 'TARGET'].includes(standard.level));
    assert.ok(['AUTOMATED', 'HOLD', 'NOT_APPLICABLE'].includes(standard.verification));
  }
  assert.equal(new Set(profile.standards.map((item) => item.id)).size, profile.standards.length);
});

test('AUTOMATED is reserved for a named implemented checker', () => {
  const automated = profile.standards.filter((standard) => standard.verification === 'AUTOMATED');
  assert.deepEqual(automated.map((standard) => standard.id), ['JSON_SCHEMA_2020_12', 'RFC_3339_DATETIME', 'ISO_4217_CURRENCY']);
  assert.deepEqual(automated.map((standard) => standard.checker), ['AJV_2020_COMPILE_ALL_SCHEMAS', 'RFC3339_SCHEMA_TEMPORAL_FIELDS', 'ISO4217_KRW_CURRENCY_FIELDS']);
  for (const id of ['SHA_256']) {
    assert.equal(profile.standards.find((standard) => standard.id === id)?.verification, 'HOLD');
  }
});

test('every non-schema contract JSON is explicitly inventoried', () => {
  const contractFiles = fs.readdirSync(path.join(process.cwd(), 'contracts')).filter((name) => name.endsWith('.json'));
  const instances = contractFiles.filter((name) => !name.endsWith('.schema.json')).sort();
  assert.deepEqual(instances, [...profile.contractInventory.instanceContracts].sort());
});

test('rejects an AUTOMATED claim that has no implemented checker', () => {
  const result = withContractFixture((contracts) => {
    const file = path.join(contracts, 'freepass-data-standards-profile.v1.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rfc9457 = value.standards.find((standard) => standard.id === 'RFC_9457_PROBLEM_DETAILS');
    rfc9457.verification = 'AUTOMATED';
    fs.writeFileSync(file, JSON.stringify(value));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MISSING_AUTOMATED_CHECK:RFC_9457_PROBLEM_DETAILS/);
});

test('rejects a timestamp property without an RFC3339 date-time schema', () => {
  const result = withContractFixture((contracts) => {
    const file = path.join(contracts, 'catalog-data-health-v1.schema.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.properties.generatedAt = { type: 'string' };
    fs.writeFileSync(file, JSON.stringify(value));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RFC3339_TEMPORAL_SCHEMA_INVALID:catalog-data-health-v1\.schema\.json:#\/properties\/generatedAt/);
});

test('rejects a currency property outside the Catalog V1 KRW-only contract', () => {
  const result = withContractFixture((contracts) => {
    const file = path.join(contracts, 'catalog-v1.schema.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.$defs.money.properties.currency = { type: 'string' };
    fs.writeFileSync(file, JSON.stringify(value));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ISO4217_KRW_SCHEMA_INVALID:catalog-v1\.schema\.json:#\/\$defs\/money\/properties\/currency/);
});

test('rejects COMPLETE while any standard remains HOLD', () => {
  const result = withContractFixture((contracts) => {
    const file = path.join(contracts, 'freepass-data-standards-profile.v1.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.status = 'COMPLETE';
    value.unresolvedCapabilities = [];
    fs.writeFileSync(file, JSON.stringify(value));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STANDARD_NOT_VERIFIED_FOR_COMPLETE:SHA_256/);
});

test('rejects COMPLETE while any platform capability remains unresolved', () => {
  const result = withContractFixture((contracts) => {
    const file = path.join(contracts, 'freepass-data-standards-profile.v1.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.status = 'COMPLETE';
    fs.writeFileSync(file, JSON.stringify(value));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FALSE_COMPLETE_WITH_UNRESOLVED_CAPABILITIES/);
});

test('requires an approval reference for NOT_APPLICABLE', () => {
  const result = withContractFixture((contracts) => {
    const file = path.join(contracts, 'freepass-data-standards-profile.v1.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.standards.find((standard) => standard.id === 'RFC_9457_PROBLEM_DETAILS').verification = 'NOT_APPLICABLE';
    fs.writeFileSync(file, JSON.stringify(value));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NOT_APPLICABLE_DECISION_REQUIRED:RFC_9457_PROBLEM_DETAILS/);
});

test('rejects a schema that Ajv 2020 cannot compile', () => {
  const result = withContractFixture((contracts) => {
    const file = path.join(contracts, 'catalog-v1.schema.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.type = 'not-a-json-schema-type';
    fs.writeFileSync(file, JSON.stringify(value));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SCHEMA_COMPILE_FAILED:catalog-v1\.schema\.json/);
});

test('rejects a contract JSON that is outside the explicit inventory', () => {
  const result = withContractFixture((contracts) => {
    fs.writeFileSync(path.join(contracts, 'unclassified.v1.json'), '{}');
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNCLASSIFIED_CONTRACT_JSON:unclassified\.v1\.json/);
});

test('rejects a declared instance contract that is missing', () => {
  const result = withContractFixture((contracts) => {
    fs.rmSync(path.join(contracts, 'firebase-access-authority.v1.json'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DECLARED_CONTRACT_JSON_MISSING:firebase-access-authority\.v1\.json/);
});

test('rejects duplicate schema identities', () => {
  const result = withContractFixture((contracts) => {
    const source = JSON.parse(fs.readFileSync(path.join(contracts, 'catalog-v1.schema.json'), 'utf8'));
    const target = path.join(contracts, 'duplicate.schema.json');
    fs.writeFileSync(target, JSON.stringify(source));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SCHEMA_ID_DUPLICATE:duplicate\.schema\.json/);
});

test('known high-risk gaps stay machine-visible', () => {
  for (const capability of ['OPENAPI_PUBLICATION_AND_COMPATIBILITY','ISO_3779_VIN_VALIDATION','VEHICLE_MEDIA_ASSET_CONTRACT','RETENTION_ERASURE_PRIVACY_LIFECYCLE','ALL_CONSUMER_CUTOVER_READBACK']) {
    assert.ok(profile.unresolvedCapabilities.includes(capability));
  }
});
