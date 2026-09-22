import { CENTRAL_FIREBASE_PROJECT_ID, resolveTargetProject } from '../infra/firebase-target.js';

export function assertDevelopmentApi(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' || (env.FREEPASS_DATA_DRIVER ?? 'memory') !== 'memory') {
    throw new Error('Development API is memory-only; use the authenticated consumer server for Firestore reads');
  }
}

export function assertConsumerRuntime(env: NodeJS.ProcessEnv = process.env): void {
  if (env.FREEPASS_DATA_DRIVER !== 'firestore' || resolveTargetProject(env) !== CENTRAL_FIREBASE_PROJECT_ID || env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('Consumer server requires explicit freepasserp5 Firestore; memory, other projects and emulators are prohibited');
  }
}
