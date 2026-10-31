/** Current production identity tables; deliberately separate from the future node graph. */
export type OperationalMasterDocument = {
  id: string;
  data: Record<string, unknown>;
  updateTime: { seconds: number; nanoseconds: number } | null;
};
export type OperationalEstimateSourceSnapshot = {
  contract: 'estimate-operational-source-snapshot/v1';
  source: 'freepasserp5/vehicle_master+vehicle_trim_master+new_car_trim';
  complete: true;
  readAt: string;
  inputDigest: string;
  masters: OperationalMasterDocument[];
  trims: OperationalMasterDocument[];
  newCarTrims: OperationalMasterDocument[];
};
