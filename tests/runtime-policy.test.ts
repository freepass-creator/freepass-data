import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertConsumerRuntime, assertDevelopmentApi } from '../src/api/runtime-policy.js';

describe('API runtime boundary', () => {
  it('audit recovery dispatches only overdue runs outside the active-run and retry cooldown gates', () => {
    const workflow = readFileSync(new URL('../.github/workflows/erp5-audit-watchdog.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const section = workflow.split('      - name: Recover a missed audit')[1]?.split('      - name: Retain watchdog summary')[0];
    const block = section?.split('        run: |\n')[1];
    if (!block) throw new Error('Audit recovery script missing');
    const script = block.split('\n').map(line => line.slice(10)).join('\n');
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const mock = 'gh() { if [ "$1" = workflow ]; then echo DISPATCHED; else printf "%s" "$MOCK_RUNS"; fi; }\n';
    const old = new Date(Date.now() - 3_600_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    for (const [age, gap, status, created, dispatched] of [
      [30, 360, 'completed', old, false],
      [100, 360, 'in_progress', old, false],
      [100, 360, 'queued', old, false],
      [100, 360, 'completed', recent, false],
      [100, 360, 'completed', old, true],
      [61, 60, 'completed', old, true],
    ] as const) {
      const result = spawnSync(bash, ['-s'], { input: mock + script, encoding: 'utf8', env: {
        ...process.env, AUDIT_AGE_MINUTES: String(age), ERP5_AUDIT_MAX_GAP_MINUTES: String(gap),
        AUDIT_WORKFLOW: 'erp5-continuous-audit.yml', GITHUB_REPOSITORY: 'test/repo', GITHUB_STEP_SUMMARY: '/dev/null',
        MOCK_RUNS: JSON.stringify({ workflow_runs: [{ status, created_at: created }] }),
      } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.includes('DISPATCHED')).toBe(dispatched);
    }
  });
  it('refuses the unauthenticated development API for any Firestore target', () => {
    expect(() => assertDevelopmentApi({ FREEPASS_DATA_DRIVER: 'firestore', FIREBASE_PROJECT_ID: 'freepasserp5' })).toThrow('memory-only');
    expect(() => assertDevelopmentApi({ NODE_ENV: 'production' })).toThrow('memory-only');
    expect(() => assertDevelopmentApi({ FREEPASS_DATA_DRIVER: 'memory' })).not.toThrow();
  });
  it('binds the consumer server even when NODE_ENV was omitted', () => {
    const valid = { FREEPASS_DATA_DRIVER: 'firestore', FIREBASE_PROJECT_ID: 'freepasserp5' };
    expect(() => assertConsumerRuntime(valid)).not.toThrow();
    for (const invalid of [
      {}, { ...valid, FREEPASS_DATA_DRIVER: 'memory' },
      { ...valid, FIREBASE_PROJECT_ID: 'freepasserp3' },
      { ...valid, FIRESTORE_EMULATOR_HOST: 'localhost:8080' },
    ]) expect(() => assertConsumerRuntime(invalid)).toThrow();
  });
  it('actual entrypoints refuse unsafe configuration before opening a server or storage', () => {
    for (const [file, env, message] of [
      ['src/api/server.ts', { FREEPASS_DATA_DRIVER: 'firestore', FIREBASE_PROJECT_ID: 'freepasserp5' }, 'Development API is memory-only'],
      ['src/api/consumer-server.ts', { FREEPASS_DATA_DRIVER: 'memory', FIREBASE_PROJECT_ID: 'freepasserp5' }, 'Consumer server requires explicit'],
      ['src/api/consumer-server.ts', { FREEPASS_DATA_DRIVER: 'firestore', FIREBASE_PROJECT_ID: 'freepasserp3' }, 'Consumer server requires explicit'],
    ] as const) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', file], {
        env: { ...process.env, NODE_ENV: 'test', ...env }, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain('Could not load the default credentials');
    }
  });
  it('deployment evidence binds Ready by type, immutable image identity, IAM denial and authenticated readback', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(workflow).toContain('select(.type == "Ready")');
    expect(workflow).toContain('status.latestReadyRevisionName');
    expect(workflow).toContain("--format='value(image_summary.digest)'");
    expect(workflow).toContain('test "$unauthenticated_status" = "403"');
    expect(workflow).toContain("--write-out '%{http_code}'");
    expect(workflow).not.toContain("--write-out='%{http_code}'");
    expect(workflow).toContain('token_format: id_token');
    expect(workflow).toContain('id_token_audience: ${{ steps.readiness.outputs.url }}');
    expect(workflow).toContain('--header "X-Serverless-Authorization: Bearer $cloud_run_token"');
    expect(workflow).not.toContain('--header="X-Serverless-Authorization: Bearer $cloud_run_token"');
    expect(workflow).toContain('Reusing existing immutable image for $GITHUB_SHA');
    expect(workflow).toContain('/v1/consumers/erp-com/catalog-compat');
    expect(workflow).toContain('.schema == "freepass-data.catalog-compat/v1"');
    expect(workflow).toContain('.data.products | type == "object"');
    expect(workflow).toContain('Authenticated compatibility readback failed: HTTP $authenticated_status / $response_code');
    expect(workflow).toContain('READ_RUNTIME_READBACK_OK=true');
    expect(workflow).toContain("test \"$GITHUB_REF\" = 'refs/heads/main'");
    expect(workflow).toContain('--image="$IMAGE_REF"');
    expect(workflow).toContain('test "$deployed_image" = "$IMAGE_REF"');
    expect(workflow).toContain('test "$secret_version" = "$CONSUMERS_SECRET_VERSION"');
    expect(workflow).toContain('test "$latest_traffic" = "true"');
    expect(workflow).not.toContain('$CONSUMERS_SECRET_NAME:latest');
  });
  it('Admin deployment makes write authority explicit and pins immutable runtime inputs', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-admin-runtime.yml', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(workflow).toContain("default: 'off'");
    expect(workflow).toContain("test \"$GITHUB_REF\" = 'refs/heads/main'");
    expect(workflow).toContain('--image="$IMAGE_REF"');
    expect(workflow).toContain('FREEPASS_DATA_ADMIN_WORKFLOW_WRITE=$WRITE_MODE');
    expect(workflow).toContain('test "$write_mode" = "$WRITE_MODE"');
    expect(workflow).toContain('test "$secret_version" = "$CONSUMERS_SECRET_VERSION"');
    expect(workflow).toContain('test "$latest_traffic" = "true"');
    expect(workflow).not.toContain('$CONSUMERS_SECRET_NAME:latest');
  });
  it('Estimate writer deployment stays separate, immutable, private and write-disabled by default', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-estimate-writer-runtime.yml', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(workflow).toContain("default: 'off'");
    expect(workflow).toContain("test \"$GITHUB_REF\" = 'refs/heads/main'");
    expect(workflow).toContain('test "$SERVICE_NAME" != "$READ_SERVICE_NAME"');
    expect(workflow).toContain('test "$RUNTIME_SERVICE_ACCOUNT" != "$READ_RUNTIME_SERVICE_ACCOUNT"');
    expect(workflow).toContain('length == 1');
    expect(workflow).toContain('.[0].id == "freepass-estimate"');
    expect(workflow).toContain('test "$runtime_roles" = "$WRITER_IAM_ROLE"');
    expect(workflow).toContain('test "$writer_role_members" = "serviceAccount:$RUNTIME_SERVICE_ACCOUNT"');
    expect(workflow).toContain("expected_permissions=$'datastore.databases.get\\ndatastore.entities.create\\ndatastore.entities.get\\ndatastore.entities.list\\ndatastore.entities.update'");
    expect(workflow).toContain('test -z "$caller_roles"');
    expect(workflow).toContain('--image="$IMAGE_REF"');
    expect(workflow).toContain('test "$deployed_image" = "$IMAGE_REF"');
    expect(workflow).toContain('test "$latest_traffic" = "true"');
    expect(workflow).toContain('id_token_audience: ${{ steps.readiness.outputs.url }}');
    expect(workflow).toContain('.code == "ESTIMATE_ARTIFACT_WRITE_DISABLED"');
    expect(workflow).toContain("if: inputs.write_mode == 'on'");
    expect(workflow).toContain('npm run --silent probe:estimate-writer-canary');
    expect(workflow).not.toContain('npx tsx src/jobs/probe-estimate-writer-canary.ts');
    expect(workflow).toContain('github-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.sha }}');
    expect(workflow).toContain("jq -e '.status == \"PASS\"'");
    expect(workflow).toContain("if: ${{ inputs.write_mode == 'on' && (failure() || cancelled()) }}");
    expect(workflow).toContain('--update-env-vars="FREEPASS_DATA_ESTIMATE_ARTIFACT_WRITE=off"');
    expect(workflow).toContain('test "$write_mode" = "off"');
    expect(workflow).toContain('test "$latest_traffic" = "true"');
    expect(workflow).not.toContain('$CONSUMERS_SECRET_NAME:latest');
  });
  it('the production container starts the compiled consumer entrypoint', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(dockerfile).toContain('ARG FREEPASS_DATA_ENTRYPOINT=dist/src/api/consumer-server.js');
    expect(dockerfile).toContain('CMD ["sh", "-c", "exec node \\"$FREEPASS_DATA_ENTRYPOINT\\""]');
    expect(dockerfile).not.toContain('CMD ["node", "dist/api/consumer-server.js"]');
  });
  it('public runtime entrypoint registers only health and public catalog routes', () => {
    const source = readFileSync(new URL('../src/api/public-server.ts', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(source).toContain("app.get('/health'");
    expect(source).toContain("'/v1/public/catalog/feed'");
    expect(source).toContain("'/v1/public/catalog/quote'");
    expect(source).toContain("readCollections: ['products', 'policy']");
    expect(source).toContain('app.setNotFoundHandler');
    expect(source).not.toContain('/v1/consumers/:consumerId');
    expect(source).not.toContain('admin-workflow');
    expect(source).not.toContain('settlement-ledger');
    expect(source).not.toContain('FREEPASS_DATA_CONSUMERS_JSON');
    expect(source).not.toContain('iancarOneApiConfigFromEnv');
  });
  it('public deployment reuses read-runtime workflow with no consumer or Iancar secrets by default', () => {
    const publicWorkflow = readFileSync(new URL('../.github/workflows/deploy-public-runtime.yml', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    const readWorkflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(readWorkflow).toContain('workflow_call:');
    expect(readWorkflow).toContain('FREEPASS_DATA_ENTRYPOINT=$RUNTIME_ENTRYPOINT');
    expect(readWorkflow).toContain('--service "$SERVICE_NAME"');
    expect(readWorkflow).toContain('--service-account "$RUNTIME_SERVICE_ACCOUNT"');
    expect(readWorkflow).toContain('--entrypoint "$RUNTIME_ENTRYPOINT"');
    expect(readWorkflow).toContain('--use-consumer-secrets "$USE_CONSUMER_SECRETS"');
    expect(readWorkflow).toContain('--max-instances "$MAX_INSTANCES"');
    expect(readWorkflow).toContain('--runtime-concurrency "$RUNTIME_CONCURRENCY"');
    expect(readWorkflow).toContain('Grant public invoker only when requested');
    expect(readWorkflow).toContain('inputs.grant_public_invoker == true');
    expect(readWorkflow).toContain('/v1/consumers/erp-com/catalog")" = "404"');
    expect(publicWorkflow).toContain('uses: ./.github/workflows/deploy-read-runtime.yml');
    expect(publicWorkflow).toContain('service_name: freepass-data-public');
    expect(publicWorkflow).toContain('runtime_service_account: freepass-data-public-runtime@freepasserp5.iam.gserviceaccount.com');
    expect(publicWorkflow).toContain('entrypoint: dist/src/api/public-server.js');
    expect(publicWorkflow).toContain('use_consumer_secrets: false');
    expect(publicWorkflow).not.toContain('FREEPASS_DATA_CONSUMERS_JSON');
    expect(publicWorkflow).not.toContain('EANCAR_ONE_API_KEY');
  });
  it('rejects an unapproved public target before reaching deployment', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const section = workflow.split('      - name: Validate public approval before deployment effects')[1]?.split('      - name: Authenticate deploy identity')[0];
    const block = section?.split('        run: |\n')[1];
    if (!block) throw new Error('Public approval preflight missing');
    const script = block.split('\n').map(line => line.slice(10)).join('\n');
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const valid = { ALLOW_UNAUTHENTICATED: 'true', GRANT_PUBLIC_INVOKER: 'true', PROJECT_ID: 'freepasserp5',
      REGION: 'asia-northeast3', SERVICE_NAME: 'freepass-data-public',
      RUNTIME_SERVICE_ACCOUNT: 'freepass-data-public-runtime@freepasserp5.iam.gserviceaccount.com',
      RUNTIME_ENTRYPOINT: 'dist/src/api/public-server.js', USE_CONSUMER_SECRETS: 'false',
      MAX_INSTANCES: '4', RUNTIME_CONCURRENCY: '16', APPROVED_PLAN_DIGEST: 'approved-plan', GITHUB_ENV: '/dev/null' };
    const cases = [
      [{}, true], [{ APPROVED_PLAN_DIGEST: '' }, false], [{ APPROVED_PLAN_DIGEST: 'old-plan' }, false],
      [{ ALLOW_UNAUTHENTICATED: 'true', GRANT_PUBLIC_INVOKER: 'false' }, false],
      [{ ALLOW_UNAUTHENTICATED: 'false', GRANT_PUBLIC_INVOKER: 'true' }, false],
      [{ PROJECT_ID: 'other' }, false], [{ REGION: 'us-central1' }, false],
      [{ SERVICE_NAME: 'freepass-data-read' }, false], [{ RUNTIME_SERVICE_ACCOUNT: 'private-runtime' }, false],
      [{ RUNTIME_ENTRYPOINT: 'dist/src/api/consumer-server.js' }, false], [{ USE_CONSUMER_SECRETS: 'true' }, false],
      [{ MAX_INSTANCES: '10' }, false], [{ RUNTIME_CONCURRENCY: '80' }, false],
      [{ ALLOW_UNAUTHENTICATED: 'false', GRANT_PUBLIC_INVOKER: 'false', APPROVED_PLAN_DIGEST: '' }, false],
      [{ ALLOW_UNAUTHENTICATED: 'false', GRANT_PUBLIC_INVOKER: 'false' }, true],
      [{ ALLOW_UNAUTHENTICATED: 'false', GRANT_PUBLIC_INVOKER: 'false', APPROVED_PLAN_DIGEST: '', SERVICE_NAME: 'freepass-data-read', RUNTIME_ENTRYPOINT: 'dist/src/api/consumer-server.js', RUNTIME_SERVICE_ACCOUNT: 'private-runtime', USE_CONSUMER_SECRETS: 'true' }, true],
    ] as const;
    for (const [overrides, allowed] of cases) {
      const result = spawnSync(bash, ['-s'], { input: 'node() { printf "%s\\n" "approved-plan"; }\n' + script + '\necho DEPLOYMENT_REACHED\n',
        encoding: 'utf8', env: { ...process.env, ...valid, ...overrides } });
      expect(result.status === 0, JSON.stringify(overrides) + result.stderr).toBe(allowed);
      expect(result.stdout.includes('DEPLOYMENT_REACHED')).toBe(allowed);
    }
  });
  it('public plan digest includes actual deployment arguments', () => {
    const base = [
      'scripts/public-runtime-plan-digest.mjs',
      'docs/PUBLIC-RUNTIME-PLAN.md',
      '--service', 'freepass-data-public',
      '--service-account', 'freepass-data-public-runtime@freepasserp5.iam.gserviceaccount.com',
      '--entrypoint', 'dist/src/api/public-server.js',
      '--use-consumer-secrets', 'false',
      '--max-instances', '4',
      '--runtime-concurrency', '16',
    ];
    const run = (args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8' });
    const approved = run(base);
    expect(approved.status, approved.stderr).toBe(0);
    expect(approved.stdout.trim()).toBe('3e0f0a8a3d9f8b7edc4f1781598781af2eba6dfaff9cd41c9a744e70c3a9bdbe');
    for (const [index, value] of [[3, 'freepass-data-read'], [5, 'private-runtime'], [7, 'dist/src/api/consumer-server.js'], [9, 'true']] as const) {
      const changed = [...base];
      changed[index] = value;
      const result = run(changed);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).not.toBe(approved.stdout.trim());
    }
  });
  it.skipIf(process.platform === 'win32')('deployment preserves bindings and rejects missing or changed private environment', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const section = workflow.split('      - name: Deploy private read-only service')[1]!.split('      - name: Grant public invoker only when requested')[0]!;
    const script = section.split('        run: |\n')[1]!.split('\n').map(line => line.slice(10)).join('\n');
    expect(section).toContain('secrets.FREEPASS_SHEET_F04_ID');
    expect(section).toContain('MISSING_SHEET_ID_ENV: FREEPASS_SHEET_F04_ID');
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const env = [
      { name: 'NODE_ENV', value: 'production' }, { name: 'FREEPASS_DATA_DRIVER', value: 'firestore' },
      { name: 'FIREBASE_PROJECT_ID', value: 'freepasserp5' }, { name: 'FREEPASS_SHEET_F04_ID', value: 'synthetic-f04' },
      { name: 'EXISTING_EXTRA', value: 'synthetic-extra' },
      { name: 'FREEPASS_DATA_CONSUMERS_JSON', valueFrom: { secretKeyRef: { name: 'synthetic-consumers', key: '4' } } },
      { name: 'EANCAR_ONE_API_KEY', valueFrom: { secretKeyRef: { name: 'synthetic-one', key: '1' } } },
    ];
    const snapshot = (values: unknown[]) => JSON.stringify({ spec: { template: { spec: { containers: [{ env: values }] } } } });
    const mock = `gcloud() {
      if [ "$2" = deploy ]; then
        case "$*" in *--update-env-vars=NODE_ENV=production,FREEPASS_DATA_DRIVER=firestore,FIREBASE_PROJECT_ID=freepasserp5*) ;; *) return 1 ;; esac
        case "$*" in *--timeout=300s*) ;; *) return 1 ;; esac
        echo DEPLOY_REACHED
        deployed=true
      elif [ "\${deployed:-false}" = true ]; then printf '%s' "$MOCK_AFTER";
      else printf '%s' "$MOCK_BEFORE"; fi
    }\n`;
    for (const [before, after, allowed, deployed] of [
      [env, env, true, true],
      [env.map(value => value.valueFrom ? { ...value, valueFrom: { secretKeyRef: { key: value.valueFrom.secretKeyRef.key, name: value.valueFrom.secretKeyRef.name } } } : value), env, true, true],
      [env.filter(value => value.name !== 'FREEPASS_SHEET_F04_ID'), env, false, false],
      [env.map(value => value.name === 'FREEPASS_SHEET_F04_ID' ? { ...value, value: '' } : value), env, false, false],
      [env.map(value => value.name === 'FREEPASS_SHEET_F04_ID' ? { ...value, value: 'different-binding' } : value), env, false, false],
      [env.map(value => value.name === 'EANCAR_ONE_API_KEY' ? { ...value, valueFrom: { secretKeyRef: { name: 'synthetic-one', key: '2' } } } : value), env, false, false],
      [[...env, { name: 'UNPLANNED_SECRET', valueFrom: { secretKeyRef: { name: 'extra', key: '1' } } }], env, false, false],
      [env, env.filter(value => value.name !== 'EXISTING_EXTRA'), false, true],
      [env, env.map(value => value.name === 'FREEPASS_SHEET_F04_ID' ? { ...value, value: 'changed' } : value), false, true],
      [env, env.map(value => value.name === 'FREEPASS_DATA_DRIVER' ? { ...value, value: 'memory' } : value), false, true],
    ] as const) {
    const result = spawnSync(bash, ['-s'], { input: mock + script, encoding: 'utf8', env: {
      ...process.env, USE_CONSUMER_SECRETS: 'true', FREEPASS_SHEET_F04_ID: 'synthetic-f04', MOCK_BEFORE: snapshot([...before]), MOCK_AFTER: snapshot([...after]), GITHUB_ENV: '/dev/null',
      CONSUMERS_SECRET_NAME: 'synthetic-consumers', CONSUMERS_SECRET_VERSION: '4',
      IANCAR_SECRET_NAME: 'synthetic-one', IANCAR_SECRET_VERSION: '1', SERVICE_NAME: 'synthetic-service',
      PROJECT_ID: 'freepasserp5', REGION: 'asia-northeast3', IMAGE_REF: 'synthetic-image',
      RUNTIME_SERVICE_ACCOUNT: 'synthetic-account', MAX_INSTANCES: '10', RUNTIME_CONCURRENCY: '8',
    } });
    expect(result.status === 0, result.stderr).toBe(allowed);
    expect(result.stdout.includes('DEPLOY_REACHED')).toBe(deployed);
    expect(result.stdout).not.toContain('synthetic-f04');
    expect(result.stdout).not.toContain('synthetic-extra');
    }
  });
  it('deploys privately and grants anonymous invoker only after approved preflight', () => {
    const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const gate = workflow.indexOf('- name: Validate public approval before deployment effects');
    expect(gate).toBeGreaterThan(0);
    for (const step of ['Authenticate deploy identity', 'Build immutable container', 'Deploy private read-only service']) {
      expect(workflow.indexOf('- name: ' + step)).toBeGreaterThan(gate);
    }
    const deployment = workflow.split('- name: Deploy private read-only service')[1]!.split('- name: Grant public invoker only when requested')[0]!;
    expect(deployment).toContain('--no-allow-unauthenticated');
    expect(deployment).not.toContain('--allow-unauthenticated');
    const grant = workflow.split('- name: Grant public invoker only when requested')[1]!.split('- name: Verify service readiness metadata')[0]!;
    expect(grant.indexOf('test "${PUBLIC_RUNTIME_APPROVAL_VALIDATED:-false}" = "true"')).toBeGreaterThan(0);
    expect(grant.indexOf('test "$plan_digest" = "$APPROVED_PLAN_DIGEST"')).toBeLessThan(grant.indexOf('gcloud run services add-iam-policy-binding'));
    expect(grant).toContain('--member=allUsers --role=roles/run.invoker');
  });

});
