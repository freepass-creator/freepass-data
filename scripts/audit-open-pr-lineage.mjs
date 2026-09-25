import fs from 'node:fs';

const registry = JSON.parse(
  fs.readFileSync('contracts/development-responsibility-registry.v1.json', 'utf8')
);
const repository = process.env.GITHUB_REPOSITORY || registry.repository;
const token = process.env.GITHUB_TOKEN || '';
const api = process.env.GITHUB_API_URL || 'https://api.github.com';

if (!repository || !repository.includes('/')) {
  throw new Error('GITHUB_REPOSITORY or registry.repository must be owner/name');
}

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'freepass-data-lineage-audit',
  ...(token ? { Authorization: 'Bearer ' + token } : {})
};

const response = await fetch(
  api + '/repos/' + repository + '/pulls?state=open&per_page=100',
  { headers }
);
if (!response.ok) {
  throw new Error('GitHub open-PR audit failed: HTTP ' + response.status);
}

const prs = await response.json();
const responsibilities = new Map(
  registry.responsibilities.map((row) => [row.id, row])
);
const claims = new Map();
const failures = [];

function metadata(body = '') {
  const read = (key) => {
    const pattern = '^' + key + ':\\s*\\x60?([^\\x60\\n]+)\\x60?\\s*$';
    const match = body.match(new RegExp(pattern, 'mi'));
    return match?.[1]?.trim() || null;
  };
  return {
    responsibilityId: read('Responsibility-ID'),
    lineageMode: read('Lineage-Mode')
  };
}

for (const pr of prs) {
  const meta = metadata(pr.body || '');
  if (!meta.responsibilityId || !meta.lineageMode) {
    failures.push('PR #' + pr.number + ' is missing Responsibility-ID or Lineage-Mode');
    continue;
  }

  const row = responsibilities.get(meta.responsibilityId);
  if (!row) {
    failures.push('PR #' + pr.number + ' claims unknown responsibility ' + meta.responsibilityId);
    continue;
  }

  if (meta.lineageMode === 'CANONICAL_WIP') {
    const list = claims.get(meta.responsibilityId) || [];
    list.push(pr.number);
    claims.set(meta.responsibilityId, list);

    if (row.authority?.state !== 'ACTIVE_WIP') {
      failures.push('PR #' + pr.number + ' claims CANONICAL_WIP but registry state is ' + row.authority?.state);
    }
    if (row.authority?.pr !== pr.number) {
      failures.push('PR #' + pr.number + ' is not the registered canonical PR for ' + meta.responsibilityId + '; expected #' + row.authority?.pr);
    }
    if (row.authority?.branch !== pr.head?.ref) {
      failures.push('PR #' + pr.number + ' head mismatch; registry=' + row.authority?.branch + ', GitHub=' + pr.head?.ref);
    }
    if (pr.base?.ref !== registry.rules?.canonicalBaseBranch) {
      failures.push('PR #' + pr.number + ' canonical WIP must target ' + registry.rules?.canonicalBaseBranch + ', got ' + pr.base?.ref);
    }
  } else if (meta.lineageMode !== 'REFERENCE_ONLY') {
    failures.push('PR #' + pr.number + ' has unsupported Lineage-Mode ' + meta.lineageMode);
  }
}

for (const [id, prNumbers] of claims) {
  if (prNumbers.length > (registry.rules?.maxCanonicalWipPerResponsibility ?? 1)) {
    failures.push('responsibility ' + id + ' has multiple canonical WIP PRs: ' + prNumbers.join(', '));
  }
}

for (const row of registry.responsibilities) {
  if (row.authority?.state !== 'ACTIVE_WIP') continue;
  const found = prs.some((pr) => pr.number === row.authority.pr);
  if (!found) {
    failures.push('registered ACTIVE_WIP PR #' + row.authority.pr + ' for ' + row.id + ' is not open');
  }
}

if (failures.length) {
  console.error('Open PR development-lineage audit FAILED');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}

console.log(
  'Open PR development-lineage audit OK: ' + prs.length +
  ' open PRs, ' + claims.size + ' canonical responsibility claims'
);
