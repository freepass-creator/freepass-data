import type { DataAccessEvent } from '../domain/data-access.js';
import type { DataAccessEventReader, DataAccessLogStore } from '../ports/data-access.js';

export class MemoryDataAccessLogStore implements DataAccessLogStore, DataAccessEventReader {
  readonly events: DataAccessEvent[] = [];

  async appendDataAccessEvent(event: DataAccessEvent) {
    this.events.push(structuredClone(event));
  }

  async listRecentDataAccessEvents(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
      throw new Error('INVALID_DATA_ACCESS_EVENT_LIMIT');
    }
    return structuredClone(
      [...this.events]
        .sort((a, b) =>
          Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
          b.eventId.localeCompare(a.eventId)
        )
        .slice(0, limit)
    );
  }
}
