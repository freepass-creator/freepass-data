import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const block = (name: string, next: string) => workflow.split(`      - name: ${name}`)[1]!.split(`      - name: ${next}`)[0]!
  .split('        run: |\n')[1]!.split('\n').map(line => line.slice(10)).join('\n');
const baseline = {
  EXPECTED_BASELINE_REVISION: 'freepass-data-read-00030-bfq', EXPECTED_BASELINE_SOURCE_SHA: 'a'.repeat(40),
  EXPECTED_BASELINE_IMAGE_DIGEST: 'sha256:' + 'b'.repeat(64), REQUESTED_RUNTIME_SOURCE_SHA: 'c'.repeat(40),
};

describe('selected source deployment baseline guard', () => {
  it('requires the exact baseline triplet before authentication while retaining default-main mode', () => {
    const script = block('Resolve trusted runtime source', 'Validate public approval before deployment effects');
    const mock = 'git() { if [ "$1" = merge-base ]; then return 0; else echo "$GITHUB_SHA"; fi; }\n';
    const valid = { ...baseline, REQUESTED_RUNTIME_SOURCE_SHA: 'a'.repeat(40), GITHUB_SHA: 'a'.repeat(40),
      GITHUB_REF: 'refs/heads/main', GITHUB_ENV: '/dev/null', GITHUB_OUTPUT: '/dev/null',
      USE_CONSUMER_SECRETS: 'true', ALLOW_UNAUTHENTICATED: 'false', GRANT_PUBLIC_INVOKER: 'false', RUNTIME_ENTRYPOINT: 'dist/src/api/consumer-server.js' };
    const cases: Array<[Record<string, string>, boolean]> = [[{}, true],
      [{ REQUESTED_RUNTIME_SOURCE_SHA: '', EXPECTED_BASELINE_REVISION: '', EXPECTED_BASELINE_SOURCE_SHA: '', EXPECTED_BASELINE_IMAGE_DIGEST: '' }, true],
      [{ EXPECTED_BASELINE_REVISION: 'other' }, false], [{ EXPECTED_BASELINE_SOURCE_SHA: '--help' }, false],
      [{ EXPECTED_BASELINE_IMAGE_DIGEST: 'latest' }, false], [{ USE_CONSUMER_SECRETS: 'false' }, false],
      [{ ALLOW_UNAUTHENTICATED: 'true' }, false], [{ GRANT_PUBLIC_INVOKER: 'true' }, false],
      [{ RUNTIME_ENTRYPOINT: 'dist/src/api/public-server.js' }, false],
    ];
    for (const key of ['EXPECTED_BASELINE_REVISION', 'EXPECTED_BASELINE_SOURCE_SHA', 'EXPECTED_BASELINE_IMAGE_DIGEST']) cases.push([{ [key]: '' }, false]);
    for (const [overrides, pass] of cases) {
      const result = spawnSync(bash, ['-s'], { input: mock + script, encoding: 'utf8', env: { ...process.env, ...valid, ...overrides } });
      expect(result.status === 0, result.stderr).toBe(pass);
    }
  });

  it('stops before deploy on any changed baseline or unknown resource and preserves all environment values', () => {
    const script = block('Deploy private read-only service', 'Grant public invoker only when requested');
    const env = [
      { name: 'NODE_ENV', value: 'production' }, { name: 'FREEPASS_DATA_DRIVER', value: 'firestore' },
      { name: 'FIREBASE_PROJECT_ID', value: 'freepasserp5' }, { name: 'FREEPASS_SHEET_F04_ID', value: 'synthetic-f04' },
      { name: 'EXTRA', value: 'synthetic-extra' },
      { name: 'FREEPASS_DATA_CONSUMERS_JSON', valueFrom: { secretKeyRef: { name: 'freepass-data-consumers', key: '5' } } },
      { name: 'EANCAR_ONE_API_KEY', valueFrom: { secretKeyRef: { name: 'freepass-data-iancar-one-api', key: '1' } } },
    ];
    const service = {
      spec: { template: { metadata: { annotations: { 'autoscaling.knative.dev/maxScale': '10' } }, spec: {
        serviceAccountName: 'freepass-data-read-runtime@freepasserp5.iam.gserviceaccount.com', timeoutSeconds: 300,
        containerConcurrency: 8, volumes: [] as unknown[], containers: [{ env, ports: [{ containerPort: 8080 }],
          resources: { limits: { memory: '512Mi' } },
          image: `asia-northeast3-docker.pkg.dev/freepasserp5/freepass-data/freepass-data-read:${baseline.EXPECTED_BASELINE_SOURCE_SHA}@${baseline.EXPECTED_BASELINE_IMAGE_DIGEST}`,
        }],
      } } }, status: { latestReadyRevisionName: baseline.EXPECTED_BASELINE_REVISION, latestCreatedRevisionName: baseline.EXPECTED_BASELINE_REVISION,
        conditions: [{ type: 'Ready', status: 'True' }], traffic: [{ revisionName: baseline.EXPECTED_BASELINE_REVISION, percent: 100 }],
        url: 'https://freepass-data-read-njl7veujva-du.a.run.app',
      },
    };
    type Service = typeof service;
    const cases: Array<{ change?: (s: Service) => void; overrides?: Record<string, string>; pass: boolean }> = [
      { pass: true }, { pass: false, change: s => { s.status.latestCreatedRevisionName = 'freepass-data-read-00031-abc'; } },
      { pass: false, change: s => { s.status.latestReadyRevisionName = 'freepass-data-read-00031-abc'; } },
      { pass: false, change: s => { s.status.traffic[0]!.percent = 99; } },
      { pass: false, change: s => { s.status.conditions[0]!.status = 'False'; } },
      { pass: false, change: s => { s.status.url = 'other'; } },
      { pass: false, change: s => { s.spec.template.spec.serviceAccountName = 'other'; } },
      { pass: false, change: s => { s.spec.template.spec.timeoutSeconds = 30; } },
      { pass: false, change: s => { s.spec.template.spec.containerConcurrency = 80; } },
      { pass: false, change: s => { s.spec.template.metadata.annotations['autoscaling.knative.dev/maxScale'] = '11'; } },
      { pass: false, change: s => { s.spec.template.spec.volumes.push({ name: 'unexpected' }); } },
      { pass: false, change: s => { delete (s.spec.template.spec as Partial<typeof s.spec.template.spec>).volumes; } },
      { pass: false, change: s => { s.spec.template.spec.containers[0]!.resources.limits.memory = '1Gi'; } },
      { pass: false, change: s => { s.spec.template.spec.containers[0]!.ports[0]!.containerPort = 3000; } },
      { pass: false, change: s => { s.spec.template.spec.containers[0]!.image = 'other'; } },
      { pass: false, change: s => { s.spec.template.spec.containers[0]!.env[3]!.value = ''; } },
      { pass: false, change: s => { s.spec.template.spec.containers[0]!.env[1]!.value = 'memory'; } },
      { pass: false, change: s => { s.spec.template.spec.containers[0]!.env[5]!.valueFrom!.secretKeyRef.key = '4'; } },
      { pass: false, overrides: { EXPECTED_BASELINE_SOURCE_SHA: 'd'.repeat(40) } },
    ];
    const mock = `gcloud() { if [ "$2" = deploy ]; then echo DEPLOY_REACHED; deployed=true;
      elif [ "\${deployed:-false}" = true ]; then printf '%s' "$MOCK_AFTER"; else printf '%s' "$MOCK_BEFORE"; fi; }\n`;
    for (const test of cases) {
      const before = structuredClone(service); test.change?.(before);
      const result = spawnSync(bash, ['-s'], { input: mock + script, encoding: 'utf8', env: {
        ...process.env, ...baseline, USE_CONSUMER_SECRETS: 'true', FREEPASS_SHEET_F04_ID: 'synthetic-f04',
        CONSUMERS_SECRET_NAME: 'freepass-data-consumers', CONSUMERS_SECRET_VERSION: '5',
        IANCAR_SECRET_NAME: 'freepass-data-iancar-one-api', IANCAR_SECRET_VERSION: '1',
        PROJECT_ID: 'freepasserp5', REGION: 'asia-northeast3', SERVICE_NAME: 'freepass-data-read',
        RUNTIME_SERVICE_ACCOUNT: service.spec.template.spec.serviceAccountName, MAX_INSTANCES: '10', RUNTIME_CONCURRENCY: '8',
        IMAGE_REF: 'synthetic-selected-image', GITHUB_ENV: '/dev/null',
        MOCK_BEFORE: JSON.stringify(before), MOCK_AFTER: JSON.stringify(service), ...test.overrides,
      } });
      expect(result.status === 0, result.stderr).toBe(test.pass);
      expect(result.stdout.includes('DEPLOY_REACHED')).toBe(test.pass);
      expect(result.stdout + result.stderr).not.toContain('synthetic-f04');
      expect(result.stdout + result.stderr).not.toContain('synthetic-extra');
    }
  });
});
