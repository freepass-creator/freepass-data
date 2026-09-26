import type {
  VehicleMasterFetchedSource,
  VehicleMasterSourceFetcher,
} from '../ports/vehicle-master-source-fetcher.js';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

function normalizeAllowedHosts(raw: string | undefined): string[] {
  return [...new Set(
    String(raw ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )].sort();
}

function assertAllowedUrl(url: URL, allowedHosts: readonly string[]) {
  if (url.protocol !== 'https:') {
    throw new Error('VEHICLE_MASTER_SOURCE_HTTPS_REQUIRED');
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some(
    (entry) => host === entry || host.endsWith(`.${entry}`)
  );
  if (!allowed) {
    throw new Error(`VEHICLE_MASTER_SOURCE_HOST_NOT_ALLOWED:${host}`);
  }
}

export class HttpVehicleMasterSourceFetcher implements VehicleMasterSourceFetcher {
  constructor(
    private readonly allowedHosts: readonly string[],
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    if (!allowedHosts.length) {
      throw new Error('VEHICLE_MASTER_SOURCE_HOSTS_REQUIRED');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('VEHICLE_MASTER_SOURCE_MAX_BYTES_INVALID');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('VEHICLE_MASTER_SOURCE_TIMEOUT_INVALID');
    }
  }

  async fetch(url: string): Promise<VehicleMasterFetchedSource> {
    const requested = new URL(url);
    assertAllowedUrl(requested, this.allowedHosts);

    let current = requested;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'FreePassDataVehicleMaster/1.0',
          'Accept': 'text/html,application/pdf,application/json,text/plain;q=0.9,*/*;q=0.5',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`VEHICLE_MASTER_SOURCE_REDIRECT_WITHOUT_LOCATION:${response.status}`);
        }
        if (redirectCount === MAX_REDIRECTS) {
          throw new Error('VEHICLE_MASTER_SOURCE_TOO_MANY_REDIRECTS');
        }
        const next = new URL(location, current);
        assertAllowedUrl(next, this.allowedHosts);
        current = next;
        continue;
      }

      if (!response.ok) {
        throw new Error(`VEHICLE_MASTER_SOURCE_HTTP_ERROR:${response.status}`);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const length = Number(contentLength);
        if (Number.isFinite(length) && length > this.maxBytes) {
          throw new Error('VEHICLE_MASTER_SOURCE_TOO_LARGE');
        }
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > this.maxBytes) {
        throw new Error('VEHICLE_MASTER_SOURCE_TOO_LARGE');
      }

      return {
        requestedUrl: requested.toString(),
        finalUrl: current.toString(),
        status: response.status,
        contentType: response.headers.get('content-type'),
        bytes,
      };
    }

    throw new Error('VEHICLE_MASTER_SOURCE_FETCH_UNREACHABLE');
  }
}

export function createHttpVehicleMasterSourceFetcher(
  env: NodeJS.ProcessEnv = process.env
) {
  return new HttpVehicleMasterSourceFetcher(
    normalizeAllowedHosts(env.VEHICLE_MASTER_SOURCE_HOSTS),
    env.VEHICLE_MASTER_SOURCE_MAX_BYTES
      ? Number(env.VEHICLE_MASTER_SOURCE_MAX_BYTES)
      : DEFAULT_MAX_BYTES,
    env.VEHICLE_MASTER_SOURCE_TIMEOUT_MS
      ? Number(env.VEHICLE_MASTER_SOURCE_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS
  );
}
