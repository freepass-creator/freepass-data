export type VehicleMasterFetchedSource = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  bytes: Buffer;
};

export interface VehicleMasterSourceFetcher {
  fetch(url: string): Promise<VehicleMasterFetchedSource>;
}
