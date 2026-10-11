import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const script = readFileSync(new URL('../scripts/verify-read-runtime.sh', import.meta.url), 'utf8');
describe('existing private runtime verification', () => {
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
        CONSUMERS_SECRET_NAME: 'freepass-data-consumers', CONSUMERS_SECRET_VERSION: '4', IANCAR_SECRET_NAME: 'freepass-data-iancar-one-api', IANCAR_SECRET_VERSION: '1',
        MOCK_SERVICE: JSON.stringify(s), MOCK_REVISION: JSON.stringify(r), MOCK_POLICY: '{"bindings":[]}', MOCK_SOURCE_DIGEST: digest,
        GITHUB_ENV: '/dev/null', GITHUB_OUTPUT: '/dev/null', ...test.overrides,
      } });
      expect(result.status === 0, result.stderr).toBe(test.pass);
      expect(result.stdout + result.stderr).not.toContain('synthetic-private-binding');
      expect(result.stdout + result.stderr).not.toContain('UNEXPECTED_EFFECT');
    }
  });
});
