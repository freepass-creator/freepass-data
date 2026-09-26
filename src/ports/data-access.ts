import type { DataAccessEvent } from '../domain/data-access.js';

export interface DataAccessLogStore {
  appendDataAccessEvent(event: DataAccessEvent): Promise<void>;
}

export interface DataAccessEventReader {
  listRecentDataAccessEvents(limit: number): Promise<DataAccessEvent[]>;
}
