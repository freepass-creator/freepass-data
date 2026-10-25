import { describe, expect, it } from 'vitest';
import { selectUnattendedPlugins } from '../src/runtime/source-cycle-runtime.js';
const plugins = ['RP031', 'RP012', 'RP023'].map(sourceId => ({ sourceId }));
describe('무인 회차 대상 선택', () => {
    it('--source 가 있으면 제외 목록과 상관없이 그 원천만(감시 실행기 RP031)', () => {
        expect(selectUnattendedPlugins(plugins, 'RP031', { SOURCE_CYCLE_ALL_RUN_EXCLUDE: 'RP031' }).map(p => p.sourceId)).toEqual(['RP031']);
    });
    it('전체 회차는 SOURCE_CYCLE_ALL_RUN_EXCLUDE 의 원천을 뺀다', () => {
        expect(selectUnattendedPlugins(plugins, undefined, { SOURCE_CYCLE_ALL_RUN_EXCLUDE: ' RP031 ,RP999' }).map(p => p.sourceId)).toEqual(['RP012', 'RP023']);
    });
    it('제외 목록이 없으면 전체(지금 동작)', () => {
        expect(selectUnattendedPlugins(plugins, undefined, {}).map(p => p.sourceId)).toEqual(['RP031', 'RP012', 'RP023']);
    });
});
