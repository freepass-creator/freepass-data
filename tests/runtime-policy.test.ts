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
    expect(dockerfile).toContain('CMD ["node", "dist/src/api/consumer-server.js"]');
    expect(dockerfile).not.toContain('CMD ["node", "dist/api/consumer-server.js"]');
  });
});
