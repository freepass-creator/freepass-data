/** All live transport is injected; importing the intake never obtains credentials. */
export type DriveArchiveRequest = {
  directory: string; name: string; bytes: Uint8Array; mediaType: string;
  appProperties: { eventId: string; sha256: string };
};
export type DriveArchiveFile = {
  id: string; directory: string; sha256: string;
  appProperties: { eventId: string; sha256: string };
  permissionsComplete: boolean; ancestorPermissionsChecked: boolean;
  permissions: Array<{ type: 'anyone' | 'domain' | 'user' | 'group'; role: string;
    domain?: string; emailAddress?: string; allowFileDiscovery?: boolean }>;
};
export interface KakaoDriveArchivePort {
  /** Check destination and inherited ACLs before transmitting any source bytes. */
  inspectDestination(directory: string): Promise<Pick<DriveArchiveFile, 'permissions' | 'permissionsComplete' | 'ancestorPermissionsChecked'>>;
  find(properties: DriveArchiveRequest['appProperties']): Promise<DriveArchiveFile[]>;
  upload(input: DriveArchiveRequest): Promise<{ id: string }>;
  /** Must download/hash original bytes and inspect actual/inherited permissions. */
  verify(id: string): Promise<DriveArchiveFile>;
}
export type KakaoProductSnapshot = {
  id: string; data: Record<string, unknown>;
  /** Provider-specific mapping to a field already present in this product. */
  supplierVehicleIdField?: string;
};
export type KakaoPhotoPlan = {
  eventId: string; productId: string; expectedDigest: string; field: 'photo_link';
  before: unknown; after: string; archiveIds: string[];
  status: 'PLAN_ONLY'; holds: string[];
};
export interface KakaoPhotoWriterPort {
  /** Separately approved, digest/revision-fenced blank-fill writer; never used by source ingestion. */
  dryRun(plan: KakaoPhotoPlan): Promise<{ planDigest: string; ready: boolean }>;
  apply(plan: KakaoPhotoPlan, approval: { planDigest: string }): Promise<{ verified: boolean }>;
}
export interface KakaoProductReadPort {
  readSupplier(supplierCode: string): Promise<KakaoProductSnapshot[]>;
  read(id: string): Promise<KakaoProductSnapshot | null>;
}

export type KakaoQueueReceipt = {
  inputDigest: string; status: 'DRY_RUN' | 'ACK_ELIGIBLE' | 'HOLD' | 'UNKNOWN';
  deleteAllowed: boolean; issues: string[];
};
/** No delete/send operation: AI-OPS owns cleanup after authenticated, digest-bound acknowledgement. */
export interface KakaoQueueReadPort<T> {
  list(): Promise<Array<{ key: string; inputDigest: string }>>;
  read(key: string): Promise<T>;
}
