import type { DataAccessEvent } from '../domain/data-access.js';
import type { DataAccessLogStore } from '../ports/data-access.js';

const bucketPattern = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

export function gcsDataAccessLogStore(input: {
  bucket: string;
  accessToken: string;
  fetcher?: typeof fetch;
}): DataAccessLogStore {
  const bucket = input.bucket.trim();
  const accessToken = input.accessToken.trim();
  const fetcher = input.fetcher ?? fetch;

  if (!bucketPattern.test(bucket)) {
    throw new Error('INVALID_DATA_ACCESS_LOG_BUCKET');
  }
  if (!accessToken || /\s/.test(accessToken)) {
    throw new Error('MISSING_DATA_ACCESS_LOG_TOKEN');
  }

  return {
    async appendDataAccessEvent(event: DataAccessEvent) {
      const day = event.occurredAt.slice(0, 10).replaceAll('-', '/');
      if (!/^\d{4}\/\d{2}\/\d{2}$/.test(day)) {
        throw new Error('INVALID_DATA_ACCESS_EVENT_TIME');
      }
      const objectName = `access-events/${day}/${event.eventId}.json`;
      const url =
        `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
        `?uploadType=media&name=${encodeURIComponent(objectName)}&ifGenerationMatch=0`;
      const response = await fetcher(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(event)
      });
      if (!response.ok) {
        throw new Error(`DATA_ACCESS_LOG_HTTP_${response.status}`);
      }
    }
  };
}
