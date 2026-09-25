import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import type { ProjectionStore } from '../ports/catalog-store.js';
import type { ProjectionProduct, ProjectionRelease } from '../domain/catalog.js';
import type { ProjectionReleaseManifest } from '../domain/projection-evidence.js';

export function projectionReader(db: Firestore): Pick<ProjectionStore, 'getActive' | 'getManifest'> {
  return {
    async getActive(projectionId: string): Promise<ProjectionRelease<ProjectionProduct> | null> {
      const pointer = await db.collection('projection_active').doc(projectionId).get();
      if (!pointer.exists) return null;
      const releaseId: unknown = pointer.get('releaseId');
      if (typeof releaseId !== 'string' || !/^rel_[a-zA-Z0-9-]+$/.test(releaseId)) throw new Error('Invalid release pointer');
      const release = await db.collection('projection_releases').doc(releaseId).get();
      if (!release.exists) return null;
      const value = release.data() as ProjectionRelease<ProjectionProduct>;
      if (value.releaseId !== releaseId) throw new Error('Release pointer identity mismatch');
      return value;
    },
    async getManifest(releaseId) {
      if (!/^rel_[a-zA-Z0-9-]+$/.test(releaseId)) throw new Error('Invalid release identity');
      const manifest = await db.collection('projection_release_manifests').doc(releaseId).get();
      return manifest.exists ? manifest.data() as ProjectionReleaseManifest : null;
    },
  };
}

export function createFirestoreProjectionReader() {
  return projectionReader(getFirestore(getTargetFirebaseApp()));
}
