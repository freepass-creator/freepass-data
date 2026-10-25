import { describe, expect, it } from 'vitest';
import { OPTIONS_REWRITE_CAP } from '../src/application/source-cycle.js';
describe('options rewrite cap', () => {
    it('keeps the default cap at 100 (override only via SOURCE_CYCLE_API_OPTIONS_CAP, max 400)', () => {
        expect(OPTIONS_REWRITE_CAP).toBe(100);
    });
});
