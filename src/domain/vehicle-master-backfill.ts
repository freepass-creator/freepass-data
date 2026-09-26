import type { VehicleMasterSourceDocument } from './vehicle-master.js';

export type VehicleMasterBackfillSourceKey =
  | 'MANUFACTURER'
  | 'CARNOON'
  | 'DANAWA'
  | 'CARISYOU'
  | 'WIKICAR';

export type VehicleMasterBackfillSourcePolicy = {
  key: VehicleMasterBackfillSourceKey;
  sourceType: VehicleMasterSourceDocument['sourceType'];
  sourceName: string;
  discoveryUrl: string | null;
  priority: number;
  currentCoverage: boolean;
  historicalCoverage: 'NONE' | 'RECENT' | 'DEEP';
  discoveryOnly: boolean;
  countsAsCanonicalCorroboration: boolean;
};

export const VEHICLE_MASTER_BACKFILL_SOURCES: readonly VehicleMasterBackfillSourcePolicy[] = [
  {
    key: 'MANUFACTURER',
    sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'Manufacturer official',
    discoveryUrl: null,
    priority: 100,
    currentCoverage: true,
    historicalCoverage: 'RECENT',
    discoveryOnly: false,
    countsAsCanonicalCorroboration: true,
  },
  {
    key: 'CARNOON',
    sourceType: 'CARNOON',
    sourceName: 'Carnoon',
    discoveryUrl: 'https://www.carnoon.co.kr/newcar/search',
    priority: 80,
    currentCoverage: true,
    historicalCoverage: 'RECENT',
    discoveryOnly: false,
    countsAsCanonicalCorroboration: true,
  },
  {
    key: 'DANAWA',
    sourceType: 'DANAWA',
    sourceName: 'Danawa Auto',
    discoveryUrl: 'https://auto.danawa.com/newcar/',
    priority: 75,
    currentCoverage: true,
    historicalCoverage: 'RECENT',
    discoveryOnly: false,
    countsAsCanonicalCorroboration: true,
  },
  {
    key: 'CARISYOU',
    sourceType: 'CARISYOU',
    sourceName: 'CarIsYou',
    discoveryUrl: 'https://www.carisyou.com/car/',
    priority: 70,
    currentCoverage: true,
    historicalCoverage: 'DEEP',
    discoveryOnly: false,
    countsAsCanonicalCorroboration: true,
  },
  {
    key: 'WIKICAR',
    sourceType: 'WIKICAR',
    sourceName: 'WikiCar discovery',
    discoveryUrl: null,
    priority: 30,
    currentCoverage: false,
    historicalCoverage: 'DEEP',
    discoveryOnly: true,
    countsAsCanonicalCorroboration: false,
  },
] as const;

export type VehicleMasterDiscoveredPage = {
  sourceKey: VehicleMasterBackfillSourceKey;
  sourceType: VehicleMasterSourceDocument['sourceType'];
  sourceName: string;
  sourceUrl: string;
  discoveredFromUrl: string;
  modelHint: string | null;
  latestModelYearHint: number | null;
  currentHint: boolean | null;
};

export type VehicleMasterBackfillCoverageStatus =
  | 'MISSING'
  | 'DISCOVERY_ONLY'
  | 'SINGLE_SOURCE'
  | 'CORROBORATED'
  | 'OFFICIAL';

export type VehicleMasterBackfillTask = VehicleMasterDiscoveredPage & {
  taskId: string;
  rank: number;
  coverageStatus: VehicleMasterBackfillCoverageStatus;
};

export function vehicleMasterBackfillPolicy(
  key: VehicleMasterBackfillSourceKey
): VehicleMasterBackfillSourcePolicy {
  const policy = VEHICLE_MASTER_BACKFILL_SOURCES.find((item) => item.key === key);
  if (!policy) throw new Error(`VEHICLE_MASTER_BACKFILL_SOURCE_UNKNOWN:${key}`);
  return policy;
}
