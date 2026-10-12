import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const block = (name: string, next: string) => workflow.split(`      - name: ${name}`)[1]!.split(`      - name: ${next}`)[0]!
  .split('        run: |\n')[1]!.split('\n').map(line => line.slice(10)).join('\n');
const baseline = {
  EXPECTED_BASELINE_REVISION: 'freepass-data-read-00030-bfq', EXPECTED_BASELINE_SOURCE_SHA: 'a'.repeat(40),
  EXPECTED_BASELINE_IMAGE_DIGEST: 'sha256:' + 'b'.repeat(64), REQUESTED_RUNTIME_SOURCE_SHA: 'c'.repeat(40),
};
const photoSource = 'd42c4f58d939d7899457730cd1a82f419b3eade8';
const photoBaseline = {
  EXPECTED_BASELINE_REVISION: 'freepass-data-read-00035-n8q',
  EXPECTED_BASELINE_SOURCE_SHA: '57abb8a978457b87068c3c9c9d76cc8116934bd5',
  EXPECTED_BASELINE_IMAGE_DIGEST: 'sha256:e963c5436954d155119fa0d44a3bcc1c67b0cb38d4b996c886b18187d6f3cb42',
};
const photoCandidates = [
  { source: photoSource, baseline: photoBaseline },
  { source: 'bd03f33b9bdedfb8f49ad8717062b32784e9a08a', baseline: {
    EXPECTED_BASELINE_REVISION: 'freepass-data-read-00038-phh',
    EXPECTED_BASELINE_SOURCE_SHA: 'c9b9a4b31d001c2cbffd43022c9213e01e3d2544',
    EXPECTED_BASELINE_IMAGE_DIGEST: 'sha256:6322eb95ab90882f42febd480844c45e400411ccc1a81c99f8601de3e2e6c5b2',
  } },
];

describe('selected source deployment baseline guard', () => {
  it('binds the rendition exception to the exact approved baseline before authentication', () => {
    for (const chosen of photoCandidates) {
    const script = block('Resolve trusted runtime source', 'Validate public approval before deployment effects');
    const mock = 'git() { if [ "$1" = merge-base ]; then return 0; elif [ "$2" = HEAD ]; then echo "$GITHUB_SHA"; else echo "$REQUESTED_RUNTIME_SOURCE_SHA"; fi; }\n';
    const dir = mkdtempSync(join(tmpdir(), 'photo-source-resolve-'));
    try {
    for (const [overrides, pass] of [
      [{}, true], [{ IANCAR_PHOTO_ID_GATE_SUPPLIERS: 'RP031' }, true],
      [{ IANCAR_PHOTO_ID_GATE_SUPPLIERS: 'RP012' }, false], [{ IANCAR_PHOTO_ID_GATE_SUPPLIERS: 'RP031,RP012' }, false],
      [{ EXPECTED_BASELINE_REVISION: 'freepass-data-read-00034-abc' }, false],
      [{ EXPECTED_BASELINE_SOURCE_SHA: 'a'.repeat(40) }, false],
      [{ EXPECTED_BASELINE_IMAGE_DIGEST: 'sha256:' + 'b'.repeat(64) }, false],
      [photoCandidates.find(candidate => candidate.source !== chosen.source)!.baseline, false],
    ] as const) {
      const result = spawnSync(bash, ['-s'], { input: mock + script, encoding: 'utf8', env: {
        ...process.env, ...chosen.baseline, REQUESTED_RUNTIME_SOURCE_SHA: chosen.source, GITHUB_SHA: 'a'.repeat(40),
        GITHUB_REF: 'refs/heads/main', GITHUB_ENV: '/dev/null', GITHUB_OUTPUT: '/dev/null', RUNNER_TEMP: dir,
        USE_CONSUMER_SECRETS: 'true', ALLOW_UNAUTHENTICATED: 'false', GRANT_PUBLIC_INVOKER: 'false',
        RUNTIME_ENTRYPOINT: 'dist/src/api/consumer-server.js', IANCAR_PHOTO_ID_GATE_SUPPLIERS: '', ...overrides,
      } });
      expect(result.status === 0, result.stderr).toBe(pass);
    }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('changes only the approved photo gate and captures its exact rollback presence', () => {
    for (const chosen of photoCandidates) {
    const script = block('Deploy private read-only service', 'Grant public invoker only when requested');
    const gate = { name: 'IANCAR_PHOTO_ID_GATE_SUPPLIERS', value: 'RP031' };
    const env: Array<Record<string, unknown>> = [
      { name: 'NODE_ENV', value: 'production' }, { name: 'FREEPASS_DATA_DRIVER', value: 'firestore' },
      { name: 'FIREBASE_PROJECT_ID', value: 'freepasserp5' }, { name: 'FREEPASS_SHEET_F04_ID', value: 'synthetic-f04' },
      { name: 'EXTRA', value: 'synthetic-extra' },
      { name: 'FREEPASS_DATA_CONSUMERS_JSON', valueFrom: { secretKeyRef: { name: 'freepass-data-consumers', key: '5' } } },
      { name: 'EANCAR_ONE_API_KEY', valueFrom: { secretKeyRef: { name: 'freepass-data-iancar-one-api', key: '1' } } },
    ];
    const account = 'freepass-data-read-runtime@freepasserp5.iam.gserviceaccount.com';
    const snapshot = (values: Array<Record<string, unknown>>) => JSON.stringify({
      spec: { template: { metadata: { annotations: { 'autoscaling.knative.dev/maxScale': '10' } }, spec: {
        serviceAccountName: account, timeoutSeconds: 300, containerConcurrency: 8, volumes: [],
        containers: [{ env: values, ports: [{ containerPort: 8080 }], resources: { limits: { memory: '512Mi' } },
          image: `asia-northeast3-docker.pkg.dev/freepasserp5/freepass-data/freepass-data-read:${chosen.baseline.EXPECTED_BASELINE_SOURCE_SHA}@${chosen.baseline.EXPECTED_BASELINE_IMAGE_DIGEST}` }],
      } } }, status: { latestReadyRevisionName: chosen.baseline.EXPECTED_BASELINE_REVISION,
        latestCreatedRevisionName: chosen.baseline.EXPECTED_BASELINE_REVISION, conditions: [{ type: 'Ready', status: 'True' }],
        traffic: [{ revisionName: chosen.baseline.EXPECTED_BASELINE_REVISION, percent: 100 }], url: 'https://freepass-data-read-njl7veujva-du.a.run.app' },
    });
    const mock = `gcloud() { if [ "$2" = deploy ]; then
      if [ "$EXPECTED_SOURCE_SHA" = '${photoSource}' ]; then
        case "$*" in *'@IANCAR_PHOTO_ID_GATE_SUPPLIERS=RP031'*) ;; *) return 1 ;; esac
      else
        case "$*" in *IANCAR_PHOTO_ID_GATE_SUPPLIERS*) return 1 ;; esac
      fi
      echo DEPLOY_REACHED; deployed=true;
      elif [ "\${deployed:-false}" = true ]; then printf '%s' "$MOCK_AFTER"; else printf '%s' "$MOCK_BEFORE"; fi; }\n`;
    const dir = mkdtempSync(join(tmpdir(), 'photo-gate-env-'));
    try {
      for (const [beforeGate, afterEnv, pass, deployed] of [
        [[], [...env, gate], chosen.source === photoSource, chosen.source === photoSource], [[gate], [...env, gate], true, true],
        [[gate, gate], [...env, gate], false, false], [[{ ...gate, value: '' }], [...env, gate], false, false],
        [[{ ...gate, value: 'RP012' }], [...env, gate], false, false],
        [[{ ...gate, value: null }], [...env, gate], false, false],
        [[{ name: gate.name, valueFrom: { secretKeyRef: { name: 'synthetic', key: '1' } } }], [...env, gate], false, false],
        [[gate], env, false, true], [[gate], [...env, gate, gate], false, true],
        [[gate], [...env, { ...gate, value: 'RP012' }], false, true],
        [[gate], [...env.filter(v => v.name !== 'EXTRA'), gate], false, true],
        [[gate], [...env.map(v => v.name === 'FREEPASS_SHEET_F04_ID' ? { ...v, value: 'changed' } : v), gate], false, true],
        [[gate], [...env.map(v => v.name === 'EANCAR_ONE_API_KEY' ? { ...v, valueFrom: { secretKeyRef: { name: 'freepass-data-iancar-one-api', key: '2' } } } : v), gate], false, true],
      ] as const) {
        const output = join(dir, `env-${Math.random()}`);
        const result = spawnSync(bash, ['-s'], { input: mock + script, encoding: 'utf8', env: {
          ...process.env, ...chosen.baseline, REQUESTED_RUNTIME_SOURCE_SHA: chosen.source, EXPECTED_SOURCE_SHA: chosen.source,
          IANCAR_PHOTO_ID_GATE_SUPPLIERS: 'RP031', USE_CONSUMER_SECRETS: 'true', FREEPASS_SHEET_F04_ID: 'synthetic-f04',
          CONSUMERS_SECRET_NAME: 'freepass-data-consumers', CONSUMERS_SECRET_VERSION: '5',
          IANCAR_SECRET_NAME: 'freepass-data-iancar-one-api', IANCAR_SECRET_VERSION: '1',
          PROJECT_ID: 'freepasserp5', REGION: 'asia-northeast3', SERVICE_NAME: 'freepass-data-read',
          RUNTIME_SERVICE_ACCOUNT: account, MAX_INSTANCES: '10', RUNTIME_CONCURRENCY: '8',
          IMAGE_REF: 'synthetic-selected-image', GITHUB_ENV: output,
          MOCK_BEFORE: snapshot([...env, ...beforeGate]), MOCK_AFTER: snapshot([...afterEnv]),
        } });
        expect(result.status === 0, result.stderr).toBe(pass);
        expect(result.stdout.includes('DEPLOY_REACHED')).toBe(deployed);
        expect(result.stdout + result.stderr).not.toContain('synthetic-extra');
        if (pass) {
          const receipt = readFileSync(output, 'utf8');
          expect(receipt).toContain(`ROLLBACK_PHOTO_ID_GATE_PRESENT=${beforeGate.length === 1}`);
          expect(receipt).toContain(`ROLLBACK_PHOTO_ID_GATE_VALUE=${beforeGate.length === 1 ? 'RP031' : ''}\n`);
          expect(receipt).toContain('READ_RUNTIME_ENV_PRESERVED=true');
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }, 30_000);
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
      { pass: true, change: s => { delete (s.spec.template.spec as Partial<typeof s.spec.template.spec>).volumes; } },
      { pass: true, change: s => { (s.spec.template.spec.containers[0]! as Record<string, unknown>).volumeMounts = []; } },
      { pass: true, change: s => {
        delete (s.spec.template.spec as Partial<typeof s.spec.template.spec>).volumes;
        (s.spec.template.spec.containers[0]! as Record<string, unknown>).volumeMounts = [];
      } },
      ...[null, {}, 'unknown'].map(value => ({ pass: false, change: (s: Service) => {
        (s.spec.template.spec as Record<string, unknown>).volumes = value;
      } })),
      ...[null, {}, 'unknown', [{ name: 'unexpected', mountPath: '/data' }]].map(value => ({ pass: false, change: (s: Service) => {
        (s.spec.template.spec.containers[0]! as Record<string, unknown>).volumeMounts = value;
      } })),
      { pass: false, change: s => { delete (s.spec.template.spec as Partial<typeof s.spec.template.spec>).containers; } },
      ...[null, {}, [], [null], [{}]].map(value => ({ pass: false, change: (s: Service) => {
        (s.spec.template.spec as Record<string, unknown>).containers = value;
      } })),
      { pass: false, change: s => { delete (s.spec.template as Partial<typeof s.spec.template>).spec; } },
      { pass: false, change: s => { delete (s.spec as Partial<typeof s.spec>).template; } },
      { pass: false, change: s => { delete (s as Partial<Service>).spec; } },
      { pass: false, change: s => { delete (s.spec.template.spec.containers[0]!.resources.limits as Partial<typeof s.spec.template.spec.containers[0]['resources']['limits']>).memory; } },
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
        ...process.env, ...baseline, EXPECTED_SOURCE_SHA: baseline.REQUESTED_RUNTIME_SOURCE_SHA,
        USE_CONSUMER_SECRETS: 'true', FREEPASS_SHEET_F04_ID: 'synthetic-f04',
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
  }, 15_000);
});
