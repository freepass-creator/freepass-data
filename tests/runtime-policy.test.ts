import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
});
