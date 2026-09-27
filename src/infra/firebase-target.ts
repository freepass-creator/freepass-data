import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import type { BusinessTarget } from '../domain/business-resource-registry.js';

// User-confirmed operational project, 2026-09-21. Never infer this from ADC.
export const CENTRAL_FIREBASE_PROJECT_ID = 'freepasserp5';
export const CENTRAL_FIREBASE_APP_NAME = 'freepass-data-target';

export function resolveTargetProject(env: NodeJS.ProcessEnv = process.env): string {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID must explicitly identify the target project');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('Invalid Firebase project ID');
  if (env.NODE_ENV === 'production' && projectId !== CENTRAL_FIREBASE_PROJECT_ID) {
    throw new Error('Production FreePass Data must target freepasserp5');
  }
  if (env.NODE_ENV === 'production' && env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('Production FreePass Data must not use a Firestore emulator');
  }
  return projectId;
}

export function assertTargetApp(app: Pick<App, 'name' | 'options'>, projectId: string): void {
  if (app.options.projectId !== projectId) {
    throw new Error(`Firebase app ${app.name} is bound to a different project`);
  }
}

export function getTargetFirebaseApp(): App {
  const projectId = resolveTargetProject();
  const existing = getApps().find((app) => app.name === CENTRAL_FIREBASE_APP_NAME);
  if (existing) {
    assertTargetApp(existing, projectId);
    return existing;
  }
  return initializeApp({ credential: applicationDefault(), projectId }, CENTRAL_FIREBASE_APP_NAME);
}


type BusinessTargetConfig = {
  projectId: string;
  appName: string;
  databaseURL?: string;
  storageBucket?: string;
};

export const BUSINESS_FIREBASE_TARGETS: Record<BusinessTarget, BusinessTargetConfig> = {
  CORE: {
    projectId: 'freepasserp5',
    appName: 'freepass-data-business-core',
    storageBucket: 'freepasserp5.appspot.com',
  },
  SALES: {
    projectId: 'welrixtable',
    appName: 'freepass-data-business-sales',
    storageBucket: 'welrixtable.firebasestorage.app',
  },
  LEGACY: {
    projectId: 'freepasserp3',
    appName: 'freepass-data-business-legacy',
    databaseURL: 'https://freepasserp3-default-rtdb.asia-southeast1.firebasedatabase.app',
    storageBucket: 'freepasserp3.firebasestorage.app',
  },
};

export function getBusinessFirebaseApp(target: BusinessTarget): App {
  const cfg = BUSINESS_FIREBASE_TARGETS[target];
  if (!cfg) throw new Error('UNKNOWN_BUSINESS_FIREBASE_TARGET');
  const existing = getApps().find((app) => app.name === cfg.appName);
  if (existing) {
    assertTargetApp(existing, cfg.projectId);
    return existing;
  }
  return initializeApp({
    credential: applicationDefault(),
    projectId: cfg.projectId,
    ...(cfg.databaseURL ? { databaseURL: cfg.databaseURL } : {}),
    ...(cfg.storageBucket ? { storageBucket: cfg.storageBucket } : {}),
  }, cfg.appName);
}

/**
 * FreePass Data owns the Firebase workload identity. Consumer-owned service account
 * JSON must never be smuggled into this runtime as a compatibility shortcut.
 */
export function assertBusinessRuntimeCredentialPolicy(env: NodeJS.ProcessEnv = process.env): void {
  const forbidden = [
    'ERP5_FIREBASE_SERVICE_ACCOUNT_JSON',
    'AUTH_FIREBASE_SERVICE_ACCOUNT_JSON',
    'SALES_FIREBASE_SERVICE_ACCOUNT_JSON',
    'ESTIMATE_FIREBASE_SERVICE_ACCOUNT_JSON',
  ].filter((key) => Boolean(env[key]?.trim()));
  if (forbidden.length) {
    throw new Error('CONSUMER_FIREBASE_SERVICE_ACCOUNT_FORBIDDEN_IN_DATA_RUNTIME');
  }
}
