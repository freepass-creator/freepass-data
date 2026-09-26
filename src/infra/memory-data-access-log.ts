import type { DataAccessEvent } from '../domain/data-access.js';
import type { DataAccessLogStore } from '../ports/data-access.js';

export class MemoryDataAccessLogStore implements DataAccessLogStore {
  readonly events: DataAccessEvent[] = [];

  async appendDataAccessEvent(event: DataAccessEvent) {
    this.events.push(structuredClone(event));
  }
}
