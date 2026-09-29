import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const profile = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'contracts', 'freepass-data-standards-profile.v1.json'), 'utf8'));

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

test('known high-risk gaps stay machine-visible', () => {
  for (const capability of ['OPENAPI_PUBLICATION_AND_COMPATIBILITY','ISO_3779_VIN_VALIDATION','VEHICLE_MEDIA_ASSET_CONTRACT','RETENTION_ERASURE_PRIVACY_LIFECYCLE','ALL_CONSUMER_CUTOVER_READBACK']) {
    assert.ok(profile.unresolvedCapabilities.includes(capability));
  }
});
