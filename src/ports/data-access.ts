import type { DataAccessEvent } from '../domain/data-access.js';

export interface DataAccessLogStore {
  appendDataAccessEvent(event: DataAccessEvent): Promise<void>;
}
