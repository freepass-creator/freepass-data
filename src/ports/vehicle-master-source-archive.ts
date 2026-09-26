import type { VehicleMasterWriteResult } from '../domain/vehicle-master.js';

export type VehicleMasterArchiveInput = {
  storagePath: string;
  bytes: Buffer;
  expectedSha256: string;
  contentType?: string | null;
  metadata?: Record<string, string>;
};

export interface VehicleMasterSourceArchive {
  archive(input: VehicleMasterArchiveInput): Promise<Exclude<VehicleMasterWriteResult, 'UPDATED'>>;
}
