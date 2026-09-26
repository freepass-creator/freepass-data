import type { EstimateMasterCanonicalBuild } from './estimate-master-canonical.js';

export type EstimateMasterReadinessStatus = 'READY' | 'DEGRADED' | 'BLOCKED';

export type EstimateMasterReadiness = {
  contractVersion: 'estimate-master-readiness-v1';
  schemaVersion: '1.0.0';
  status: EstimateMasterReadinessStatus;
  generatedAt: string;
  projectionId: 'estimate-newcar-master';
  activeReleaseAuthorized: false;
  publicationImplemented: false;
  counts: {
    total: number;
    active: number;
    hold: number;
  };
  activeRate: number;
  inputDigest: string;
  blockers: string[];
  holdReasons: Array<{ reason: string; count: number }>;
};

export function assessEstimateMasterReadiness(
  build: Pick<EstimateMasterCanonicalBuild, 'summary'>,
  generatedAt = new Date().toISOString()
): EstimateMasterReadiness {
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('ESTIMATE_MASTER_READINESS_INVALID:generatedAt');
  }
  const { total, active, hold, activeRate, holdReasons, inputDigest } = build.summary;
  if (![total, active, hold].every(Number.isSafeInteger) ||
      total < 0 || active < 0 || hold < 0 || active + hold !== total ||
      typeof activeRate !== 'number' || activeRate < 0 || activeRate > 1 ||
      !/^[a-f0-9]{64}$/i.test(inputDigest)) {
    throw new Error('ESTIMATE_MASTER_READINESS_INVALID:summary');
  }

  let status: EstimateMasterReadinessStatus;
  const blockers: string[] = [];
  if (total === 0) {
    status = 'BLOCKED';
    blockers.push('CANONICAL_TRIMS_NOT_AVAILABLE');
  } else if (active === 0) {
    status = 'BLOCKED';
    blockers.push('NO_ACTIVE_ESTIMATE_MASTER_RECORDS');
  } else if (hold > 0) {
    status = 'DEGRADED';
    blockers.push('PARTIAL_ESTIMATE_MASTER_HOLD');
  } else {
    status = 'READY';
  }

  for (const item of holdReasons) {
    if (item.count > 0 && !blockers.includes(item.reason)) blockers.push(item.reason);
  }

  return Object.freeze({
    contractVersion: 'estimate-master-readiness-v1',
    schemaVersion: '1.0.0',
    status,
    generatedAt,
    projectionId: 'estimate-newcar-master',
    activeReleaseAuthorized: false,
    publicationImplemented: false,
    counts: Object.freeze({ total, active, hold }),
    activeRate,
    inputDigest: inputDigest.toLowerCase(),
    blockers: Object.freeze(blockers) as unknown as string[],
    holdReasons: Object.freeze(holdReasons.map((item) => Object.freeze({ ...item }))) as unknown as Array<{ reason: string; count: number }>,
  });
}
