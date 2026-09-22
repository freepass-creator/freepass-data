import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';

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
