import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import type { BusinessTarget } from '../domain/business-resource-registry.js';

type TargetConfig = {
  projectId: string;
  appName: string;
  databaseURL?: string;
  storageBucket?: string;
};

export const BUSINESS_FIREBASE_TARGETS: Record<BusinessTarget, TargetConfig> = {
  CORE: {
    projectId: 'freepasserp5',
    appName: 'freepass-data-business-core',
    storageBucket: 'freepasserp5.appspot.com',
  },
  SALES: {
    projectId: 'welrixtable',
    appName: 'freepass-data-business-sales',
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
    if (existing.options.projectId !== cfg.projectId) {
      throw new Error('BUSINESS_FIREBASE_APP_PROJECT_MISMATCH');
    }
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
 * Production identity rule:
 * one FreePass Data runtime service identity receives the required cross-project IAM.
 * No consumer-owned service-account JSON is accepted here.
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
