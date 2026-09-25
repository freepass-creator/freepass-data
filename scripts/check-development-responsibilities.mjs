import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const registryPath = path.join(root, 'contracts', 'development-responsibility-registry.v1.json');
const agentsPath = path.join(root, 'AGENTS.md');
const templatePath = path.join(root, '.github', 'pull_request_template.md');

const fail = (message) => {
  console.error(`Development responsibility check failed: ${message}`);
  process.exitCode = 1;
};

if (!fs.existsSync(registryPath)) fail('missing responsibility registry');

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
if (registry.schemaVersion !== 'development-responsibility-registry/v1') {
  fail('unsupported registry schemaVersion');
}

const rows = Array.isArray(registry.responsibilities) ? registry.responsibilities : [];
const ids = new Set();
const activeById = new Map();
const activePrs = new Map();
const activeBranches = new Map();

for (const row of rows) {
  if (!row || typeof row !== 'object') {
    fail('responsibility entry must be an object');
    continue;
  }
  if (typeof row.id !== 'string' || !row.id.trim()) {
    fail('responsibility id must be non-empty');
    continue;
  }
  if (ids.has(row.id)) fail(`duplicate responsibility id: ${row.id}`);
  ids.add(row.id);

  const authority = row.authority ?? {};
  const state = authority.state;
  if (!['ACTIVE_WIP', 'MAIN', 'REFERENCE_ONLY', 'EXTERNAL_AUTHORITY'].includes(state)) {
    fail(`invalid authority state for ${row.id}: ${state}`);
    continue;
  }

  if (state === 'ACTIVE_WIP') {
    if (!Number.isInteger(authority.pr) || authority.pr <= 0) {
      fail(`ACTIVE_WIP requires positive PR number: ${row.id}`);
    }
    if (typeof authority.branch !== 'string' || !authority.branch.trim()) {
      fail(`ACTIVE_WIP requires branch: ${row.id}`);
    }
    if (authority.base !== registry.rules?.canonicalBaseBranch) {
      fail(`canonical WIP must target ${registry.rules?.canonicalBaseBranch}: ${row.id}`);
    }
    if (activeById.has(row.id)) fail(`more than one ACTIVE_WIP for ${row.id}`);
    activeById.set(row.id, row);

    if (activePrs.has(authority.pr)) {
      fail(`PR #${authority.pr} owns more than one canonical responsibility: ${activePrs.get(authority.pr)} and ${row.id}`);
    }
    activePrs.set(authority.pr, row.id);

    if (activeBranches.has(authority.branch)) {
      fail(`branch ${authority.branch} owns more than one canonical responsibility: ${activeBranches.get(authority.branch)} and ${row.id}`);
    }
    activeBranches.set(authority.branch, row.id);
  }

  if (state === 'REFERENCE_ONLY') {
    if (authority.pr || authority.branch) {
      fail(`REFERENCE_ONLY must not claim active PR/branch authority: ${row.id}`);
    }
  }

  if (state === 'EXTERNAL_AUTHORITY') {
    if (typeof authority.repository !== 'string' || !authority.repository.trim()) {
      fail(`EXTERNAL_AUTHORITY requires repository: ${row.id}`);
    }
    for (const forbidden of row.forbiddenHere ?? []) {
      if (fs.existsSync(path.join(root, forbidden))) {
        fail(`external-owned artifact exists in FreePass Data: ${forbidden}`);
      }
    }
  }
}

const retired = Array.isArray(registry.retiredLines) ? registry.retiredLines : [];
const retiredPrs = new Set();
for (const item of retired) {
  if (!Number.isInteger(item?.pr) || item.pr <= 0) fail('retired line requires positive PR number');
  if (retiredPrs.has(item.pr)) fail(`duplicate retired PR #${item.pr}`);
  retiredPrs.add(item.pr);
  if (activePrs.has(item.pr)) fail(`PR #${item.pr} cannot be active and retired`);
}

const agents = fs.readFileSync(agentsPath, 'utf8');
if (!agents.includes('contracts/development-responsibility-registry.v1.json')) {
  fail('AGENTS.md must point to the machine-readable responsibility registry');
}

if (!fs.existsSync(templatePath)) {
  fail('missing pull request template with lineage metadata');
} else {
  const template = fs.readFileSync(templatePath, 'utf8');
  for (const marker of ['Responsibility-ID:', 'Lineage-Mode:', 'Development registry']) {
    if (!template.includes(marker)) fail(`PR template missing marker: ${marker}`);
  }
}

if (!process.exitCode) {
  console.log(`Development responsibility registry OK: ${rows.length} responsibilities, ${activeById.size} canonical WIP lines`);
}
