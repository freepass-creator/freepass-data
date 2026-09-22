import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertTargetApp, resolveTargetProject, getTargetFirebaseApp, CENTRAL_FIREBASE_APP_NAME } from '../src/infra/firebase-target.js';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { createRuntimeStores } from '../src/bootstrap.js';

afterEach(() => vi.unstubAllEnvs());

describe('central Firebase binding', () => {
  it('requires an explicit project even when ADC could supply a default', () => {
    expect(() => resolveTargetProject({ GOOGLE_CLOUD_PROJECT: 'freepasserp5' })).toThrow('explicitly');
  });
  it('binds production only to the user-confirmed project', () => {
    expect(resolveTargetProject({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'freepasserp5' })).toBe('freepasserp5');
    expect(() => resolveTargetProject({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'freepasserp3' })).toThrow('freepasserp5');
  });
  it('does not permit an emulator to masquerade as production', () => {
    expect(() => resolveTargetProject({ NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'freepasserp5', FIRESTORE_EMULATOR_HOST: 'localhost:8080' })).toThrow('emulator');
  });
  it('rejects reuse of a named app from another project', () => {
    expect(() => assertTargetApp({ name: 'freepass-data-target', options: { projectId: 'freepasserp3' } }, 'freepasserp5')).toThrow('different project');
    expect(() => assertTargetApp({ name: 'freepass-data-target', options: { projectId: 'freepasserp5' } }, 'freepasserp5')).not.toThrow();
  });
  it('fails before seeding a production process with demo data', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FREEPASS_DATA_DRIVER', 'memory');
    await expect(createRuntimeStores()).rejects.toThrow('demo data is prohibited');
  });
  it('ignores an unrelated default app and verifies the real named app on reuse', async () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', 'freepasserp5');
    const unrelated = initializeApp({ projectId: 'other-project' });
    const target = getTargetFirebaseApp();
    try {
      expect(target.name).toBe(CENTRAL_FIREBASE_APP_NAME);
      expect(target.options.projectId).toBe('freepasserp5');
      expect(getTargetFirebaseApp()).toBe(target);
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('FIREBASE_PROJECT_ID', 'other-project');
      expect(() => getTargetFirebaseApp()).toThrow('different project');
    } finally {
      await deleteApp(target);
      await deleteApp(unrelated);
    }
  });
});
