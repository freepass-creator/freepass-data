import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertConsumerRuntime, assertDevelopmentApi } from '../src/api/runtime-policy.js';

describe('API runtime boundary', () => {
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
    expect(workflow).toContain('/v1/consumers/erp-com/catalog-compat');
    expect(workflow).toContain('.schema == "freepass-data.catalog-compat/v1"');
    expect(workflow).toContain('READ_RUNTIME_READBACK_OK=true');
  });
  it('the production container starts the compiled consumer entrypoint', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(dockerfile).toContain('CMD ["node", "dist/src/api/consumer-server.js"]');
    expect(dockerfile).not.toContain('CMD ["node", "dist/api/consumer-server.js"]');
  });
});
