import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const script = readFileSync(new URL('../scripts/verify-read-runtime.sh', import.meta.url), 'utf8');
describe('existing private runtime verification', () => {
  it('keeps explicit expected pins separate from declared pins and out of deployment', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const input = workflow.split('  workflow_dispatch:\n')[1]!.split('  push:')[0]!
      .split('      expected_consumers_secret_version:\n')[1]!.split(/\n {6}\S/)[0]!;
    expect(input).toContain('type: string');
    expect(input).toContain('required: false');
    const verify = workflow.split('\n  verify:')[1]!;
    expect(verify).toContain('EXPECTED_CONSUMERS_SECRET_VERSION: ${{ inputs.expected_consumers_secret_version || vars.FREEPASS_DATA_CONSUMERS_SECRET_VERSION }}');
    expect(verify).toContain('CONSUMERS_SECRET_VERSION: ${{ vars.FREEPASS_DATA_CONSUMERS_SECRET_VERSION }}');
    expect(verify).not.toContain('CONSUMERS_SECRET_VERSION: ${{ inputs.expected_consumers_secret_version }}');
    const deploy = workflow.split('\n  deploy:')[1]!.split('\n  verify:')[0]!;
    expect(deploy).not.toContain('inputs.expected_consumers_secret_version');
    expect(deploy).not.toContain('EXPECTED_CONSUMERS_SECRET_VERSION:');
    expect(verify.indexOf('Validate verification scope before authentication')).toBeLessThan(verify.indexOf('Authenticate existing verification identity'));
    expect(verify).toContain('run: bash scripts/verify-read-runtime.sh');
  });
  it('requires an explicit positive expected pin matching the declaration before authentication', () => {
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const base = {
      GITHUB_REF: 'refs/heads/main', EXPECTED_SOURCE_SHA: 'a'.repeat(40),
      EXPECTED_IMAGE_DIGEST: 'sha256:' + 'b'.repeat(64), EXPECTED_REVISION: 'freepass-data-read-00030-bfq',
      PROJECT_ID: 'freepasserp5', REGION: 'asia-northeast3', SERVICE_NAME: 'freepass-data-read',
      RUNTIME_SERVICE_ACCOUNT: 'freepass-data-read-runtime@freepasserp5.iam.gserviceaccount.com',
      CONSUMERS_SECRET_NAME: 'freepass-data-consumers', CONSUMERS_SECRET_VERSION: '5',
      EXPECTED_CONSUMERS_SECRET_VERSION: '5', IANCAR_SECRET_NAME: 'freepass-data-iancar-one-api',
      IANCAR_SECRET_VERSION: '1', VERIFY_PREFLIGHT_ONLY: 'true',
    };
    const cases: Array<[Record<string, string>, boolean]> = [
      [{}, true], [{ CONSUMERS_SECRET_VERSION: '4', EXPECTED_CONSUMERS_SECRET_VERSION: '4' }, true],
      [{ CONSUMERS_SECRET_NAME: 'alias' }, false], [{ CONSUMERS_SECRET_VERSION: '4' }, false],
      [{ EXPECTED_CONSUMERS_SECRET_VERSION: '4' }, false], [{ IANCAR_SECRET_VERSION: '2' }, false],
    ];
    for (const key of ['CONSUMERS_SECRET_VERSION', 'EXPECTED_CONSUMERS_SECRET_VERSION']) {
      for (const value of ['', '0', 'latest', 'alias', '05', '-1', '5.0', ' 5']) cases.push([{ [key]: value }, false]);
    }
    for (const [overrides, pass] of cases) {
      const result = spawnSync(bash, ['-s'], { input: 'gcloud() { echo UNEXPECTED_AUTH_OR_READ >&2; return 1; }\n' + script,
        encoding: 'utf8', env: { ...process.env, ...base, ...overrides } });
      expect(result.status === 0, JSON.stringify(overrides) + result.stderr).toBe(pass);
      expect(result.stdout + result.stderr).not.toContain('UNEXPECTED_AUTH_OR_READ');
    }
  });
  it('uses explicit serialized boolean mode and makes private readback mandatory', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8');
    expect(workflow).toContain("USE_CONSUMER_SECRETS: ${{ toJSON(inputs.use_consumer_secrets) != 'false' }}");
    expect(workflow).not.toContain('inputs.use_consumer_secrets != false');
    expect(workflow).toContain("if: ${{ env.USE_CONSUMER_SECRETS == 'true' }}");
    const modes = [
      ['workflow_dispatch', undefined, true], ['push', undefined, true], ['workflow_dispatch', '', true],
      ['workflow_dispatch', null, true], ['workflow_call', true, true], ['workflow_call', false, false],
      ['caller workflow_dispatch', false, false], ['caller push', false, false], ['workflow_call', 'false', true],
    ] as const;
    for (const [event, input, privateMode] of modes) {
      expect(JSON.stringify(input) !== 'false', event).toBe(privateMode);
    }
    // Typed false remains explicit; absent inputs must not enter the false branch through loose coercion.
    expect(JSON.stringify(false)).toBe('false');
    expect(JSON.stringify('')).not.toBe('false');
    const deployment = workflow.split('      - name: Deploy private read-only service')[1]!.split('      - name: Grant public invoker only when requested')[0]!;
    expect(deployment).toContain('public_runtime_args+=(--timeout=300s)');
    expect(deployment).toContain('public_runtime_args+=(--timeout=30s --cpu=1 --memory=512Mi)');
    const readiness = workflow.split('      - name: Verify service readiness metadata')[1]!.split('      - name: Authenticate readback identity')[0]!;
    expect(readiness).toContain('timeoutSeconds');
    expect(readiness).toContain('= "300"');
  });
  it('isolates verification from all deployment effects', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('if: ${{ inputs.verify_only != true }}');
    const verify = workflow.split('\n  verify:')[1]!;
    expect(verify).toContain("github.event_name == 'workflow_dispatch' && inputs.verify_only == true");
    expect(verify.indexOf('Validate verification scope before authentication')).toBeLessThan(verify.indexOf('Authenticate existing verification identity'));
    for (const forbidden of ['gcloud run deploy', 'docker build', 'docker push', 'add-iam-policy-binding', 'gh issue comment', '--set-env-vars', '--update-env-vars']) {
      expect(verify + script).not.toContain(forbidden);
    }
    expect(verify).toContain('DIRECT_FIRESTORE_REQUIRED');
    expect(verify).toContain('LEGACY_READ_PENDING_RETIREMENT');
    expect(verify).toContain('catalog-compat/v1');
    const summary = verify.split('      - name: Record verification summary')[1]!;
    expect(summary).toContain('test "${READ_RUNTIME_UNAUTHENTICATED_STATUS:-UNVERIFIED}" = "403"');
    expect(summary).toContain('test "${READ_RUNTIME_AUTHENTICATED_STATUS:-UNVERIFIED}" = "200"');
    expect(verify).not.toContain('inputs.use_consumer_secrets');
    for (const step of ['Authenticate readback identity', 'Verify IAM denial and authenticated compatibility readback']) {
      const section = verify.split('      - name: ' + step)[1]!.split('      - name:')[0]!;
      expect(section).not.toContain('        if:');
    }
  });
  it('never logs arbitrary response codes from a failed verification readback', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const verify = workflow.split('\n  verify:')[1]!;
    const failure = verify.split('          if [ "$authenticated_status" != "200" ]; then')[1]!.split('          fi')[0]!;
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const result = spawnSync(bash, ['-s'], { input: 'authenticated_status=503\njq() { echo synthetic-secret-body-code; }\n' + failure,
      encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('HTTP 503 / UNRECOGNIZED');
    expect(result.stdout + result.stderr).not.toContain('synthetic-secret-body-code');
    expect(verify).not.toContain('response_code');
  });
  it('refuses a successful summary without both actual readbacks and contract evidence', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const summary = workflow.split('      - name: Record verification summary')[1]!.split('        run: |\n')[1]!
      .split('\n').map(line => line.slice(10)).join('\n');
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const base = { VERIFY_JOB_STATUS: 'success', READ_RUNTIME_UNAUTHENTICATED_STATUS: '403', READ_RUNTIME_AUTHENTICATED_STATUS: '200',
      READ_RUNTIME_READBACK_OK: 'true', READ_RUNTIME_MIGRATION_SIGNAL_OK: 'true', GITHUB_STEP_SUMMARY: '/dev/null',
      EXPECTED_SOURCE_SHA: 'a'.repeat(40), SINGLE_PRODUCT_READBACK_OK: '' };
    const singleSource = '8af86d3b84020a402e21ec3c34a8498bd3066148';
    const fixedSource = '7a02e85475ffb4a3f1d417987403a3fa3e6b3be8';
    const diagnosticSource = '2ebdb18822416847b2019f6506b7b0d65daf0ee2';
    const observerSource = '57abb8a978457b87068c3c9c9d76cc8116934bd5';
    const renditionSource = 'd42c4f58d939d7899457730cd1a82f419b3eade8';
    const runtime38Source = 'bd03f33b9bdedfb8f49ad8717062b32784e9a08a';
    for (const [overrides, pass] of [[{}, true], [{ READ_RUNTIME_AUTHENTICATED_STATUS: 'UNVERIFIED' }, false],
      [{ READ_RUNTIME_READBACK_OK: 'false' }, false], [{ READ_RUNTIME_MIGRATION_SIGNAL_OK: 'false' }, false],
      [{ EXPECTED_SOURCE_SHA: singleSource, SINGLE_PRODUCT_READBACK_OK: 'true' }, true],
      [{ EXPECTED_SOURCE_SHA: singleSource, SINGLE_PRODUCT_READBACK_OK: 'false' }, false],
      [{ EXPECTED_SOURCE_SHA: singleSource, SINGLE_PRODUCT_READBACK_OK: undefined }, false],
      [{ EXPECTED_SOURCE_SHA: fixedSource, SINGLE_PRODUCT_READBACK_OK: 'true' }, true],
      [{ EXPECTED_SOURCE_SHA: fixedSource, SINGLE_PRODUCT_READBACK_OK: 'false' }, false],
      [{ EXPECTED_SOURCE_SHA: fixedSource, SINGLE_PRODUCT_READBACK_OK: undefined }, false],
      [{ EXPECTED_SOURCE_SHA: diagnosticSource, SINGLE_PRODUCT_READBACK_OK: 'true' }, true],
      [{ EXPECTED_SOURCE_SHA: diagnosticSource, SINGLE_PRODUCT_READBACK_OK: 'false' }, false],
      [{ EXPECTED_SOURCE_SHA: diagnosticSource, SINGLE_PRODUCT_READBACK_OK: undefined }, false],
      [{ EXPECTED_SOURCE_SHA: observerSource, SINGLE_PRODUCT_READBACK_OK: 'true' }, true],
      [{ EXPECTED_SOURCE_SHA: observerSource, SINGLE_PRODUCT_READBACK_OK: 'false' }, false],
      [{ EXPECTED_SOURCE_SHA: observerSource, SINGLE_PRODUCT_READBACK_OK: undefined }, false],
      [{ EXPECTED_SOURCE_SHA: renditionSource, SINGLE_PRODUCT_READBACK_OK: 'true' }, true],
      [{ EXPECTED_SOURCE_SHA: renditionSource, SINGLE_PRODUCT_READBACK_OK: 'false' }, false],
      [{ EXPECTED_SOURCE_SHA: renditionSource, SINGLE_PRODUCT_READBACK_OK: undefined }, false],
      [{ EXPECTED_SOURCE_SHA: runtime38Source, SINGLE_PRODUCT_READBACK_OK: 'true' }, true],
      [{ EXPECTED_SOURCE_SHA: runtime38Source, SINGLE_PRODUCT_READBACK_OK: 'false' }, false],
      [{ EXPECTED_SOURCE_SHA: runtime38Source, SINGLE_PRODUCT_READBACK_OK: undefined }, false],
      [{ SINGLE_PRODUCT_READBACK_OK: 'false' }, true]] as const) {
      const result = spawnSync(bash, ['-s'], { input: summary, encoding: 'utf8', env: { ...process.env, ...base, ...overrides } });
      expect(result.status === 0, result.stderr).toBe(pass);
    }
  });
  it.skipIf(process.platform === 'win32')('accepts pinned image representations and rejects every mismatched authority', () => {
    const sha = 'a'.repeat(40), digest = 'sha256:' + 'b'.repeat(64), revision = 'freepass-data-read-00027-9kd';
    const path = 'asia-northeast3-docker.pkg.dev/freepasserp5/freepass-data/freepass-data-read';
    const spec = {
      serviceAccountName: 'freepass-data-read-runtime@freepasserp5.iam.gserviceaccount.com', containerConcurrency: 8,
      containers: [{ image: path + '@' + digest, env: [
        { name: 'NODE_ENV', value: 'production' }, { name: 'FREEPASS_DATA_DRIVER', value: 'firestore' },
        { name: 'FIREBASE_PROJECT_ID', value: 'freepasserp5' }, { name: 'FREEPASS_SHEET_F04_ID', value: 'synthetic-private-binding' },
        { name: 'FREEPASS_DATA_CONSUMERS_JSON', valueFrom: { secretKeyRef: { key: '4', name: 'freepass-data-consumers' } } },
        { name: 'EANCAR_ONE_API_KEY', valueFrom: { secretKeyRef: { key: '1', name: 'freepass-data-iancar-one-api' } } },
      ] }],
    };
    const service = { spec: { template: { spec } }, status: { url: 'https://freepass-data-read-njl7veujva-du.a.run.app', conditions: [{ type: 'Ready', status: 'True' }],
      latestReadyRevisionName: revision, latestCreatedRevisionName: revision, traffic: [{ revisionName: revision, percent: 100 }] } };
    const rev = { spec, status: { conditions: [{ type: 'Ready', status: 'True' }] } };
    const mock = `gcloud() {
      case "$1/$2/$3" in
        run/services/describe) printf '%s' "$MOCK_SERVICE" ;;
        run/revisions/describe) printf '%s' "$MOCK_REVISION" ;;
        run/services/get-iam-policy) printf '%s' "$MOCK_POLICY" ;;
        artifacts/docker/images) printf '%s' "$MOCK_SOURCE_DIGEST" ;;
        *) echo UNEXPECTED_EFFECT >&2; return 1 ;;
      esac
    }\n`;
    const cases: Array<{ change?: (s: typeof service, r: typeof rev) => void; overrides?: Record<string, string>; pass: boolean }> = [
      { pass: true }, { pass: true, change: (s, r) => { s.spec.template.spec.containers[0]!.image = path + ':' + sha + '@' + digest; r.spec.containers[0]!.image = path + '@' + digest; } },
      { pass: true, overrides: { EXPECTED_CONSUMERS_SECRET_VERSION: '5', CONSUMERS_SECRET_VERSION: '5' }, change: (s, r) => {
        s.spec.template.spec.containers[0]!.env[4]!.valueFrom!.secretKeyRef.key = '5';
        r.spec.containers[0]!.env[4]!.valueFrom!.secretKeyRef.key = '5';
      } },
      { pass: false, overrides: { EXPECTED_CONSUMERS_SECRET_VERSION: '5', CONSUMERS_SECRET_VERSION: '5' } },
      { pass: false, change: (_s, r) => { r.spec.containers[0]!.env[4]!.valueFrom!.secretKeyRef.name = 'alias'; } },
      { pass: false, overrides: { GITHUB_REF: 'refs/heads/other' } }, { pass: false, overrides: { EXPECTED_SOURCE_SHA: 'bad' } },
      { pass: false, overrides: { EXPECTED_IMAGE_DIGEST: 'bad' } }, { pass: false, overrides: { EXPECTED_REVISION: 'other' } },
      { pass: false, overrides: { MOCK_SOURCE_DIGEST: 'sha256:' + 'c'.repeat(64) } },
      { pass: false, overrides: { MOCK_POLICY: JSON.stringify({ bindings: [{ members: ['allUsers'] }] }) } },
      { pass: false, change: s => { s.status.latestCreatedRevisionName = 'other'; } },
      { pass: false, change: s => { s.status.traffic[0]!.percent = 99; } },
      { pass: false, change: s => { s.status.conditions[0]!.status = 'False'; } },
      { pass: false, change: (_s, r) => { r.spec.serviceAccountName = 'other'; } },
      { pass: false, change: (_s, r) => { r.spec.containerConcurrency = 80; } },
      { pass: false, change: (_s, r) => { r.spec.containers[0]!.image = path.replace('freepass-data-read', 'other') + '@' + digest; } },
      { pass: false, change: (_s, r) => { r.spec.containers[0]!.image = path + '@sha256:' + 'c'.repeat(64); } },
      { pass: false, change: (_s, r) => { r.spec.containers[0]!.env[4]!.valueFrom!.secretKeyRef.key = '3'; } },
    ];
    for (const test of cases) {
      const s = structuredClone(service), r = structuredClone(rev); test.change?.(s, r);
      const result = spawnSync('bash', ['-s'], { input: mock + script, encoding: 'utf8', env: {
        ...process.env, GITHUB_REF: 'refs/heads/main', EXPECTED_SOURCE_SHA: sha, EXPECTED_IMAGE_DIGEST: digest, EXPECTED_REVISION: revision,
        PROJECT_ID: 'freepasserp5', REGION: 'asia-northeast3', SERVICE_NAME: 'freepass-data-read', RUNTIME_SERVICE_ACCOUNT: spec.serviceAccountName,
        CONSUMERS_SECRET_NAME: 'freepass-data-consumers', CONSUMERS_SECRET_VERSION: '4', EXPECTED_CONSUMERS_SECRET_VERSION: '4', IANCAR_SECRET_NAME: 'freepass-data-iancar-one-api', IANCAR_SECRET_VERSION: '1',
        MOCK_SERVICE: JSON.stringify(s), MOCK_REVISION: JSON.stringify(r), MOCK_POLICY: '{"bindings":[]}', MOCK_SOURCE_DIGEST: digest,
        GITHUB_ENV: '/dev/null', GITHUB_OUTPUT: '/dev/null', ...test.overrides,
      } });
      expect(result.status === 0, result.stderr).toBe(test.pass);
      expect(result.stdout + result.stderr).not.toContain('synthetic-private-binding');
      expect(result.stdout + result.stderr).not.toContain('UNEXPECTED_EFFECT');
    }
  });
});
