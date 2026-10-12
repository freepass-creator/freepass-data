import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, probeOnce } from '../scripts/iancar-one-freshness.mjs';

const m = (at, syncedAt, stale = false) => ({ at, syncedAt, stale });
test('갱신 간격과 신선 비율', () => {
  const s = summarize([
    m('2026-10-12T01:05:00Z', '2026-10-12T01:02:00Z'),
    m('2026-10-12T01:30:00Z', '2026-10-12T01:02:00Z'),
    m('2026-10-12T02:05:00Z', '2026-10-12T02:02:00Z'),
    m('2026-10-12T03:05:00Z', '2026-10-12T03:02:00Z')
  ]);
  assert.equal(s.samples, 4); assert.equal(s.freshRatio, 0.75); assert.deepEqual(s.intervalsMin, [60]); assert.equal(s.observedChanges, 2);
});
test('빈 입력', () => assert.deepEqual(summarize([]), { samples: 0 }));
test('probeOnce 는 모양이 다르면 거부, 열쇠는 헤더로만', async () => {
  let seen;
  const ok = await probeOnce('K', async (u, o) => { seen = o.headers.Authorization; return { ok: true, json: async () => ({ synced_at: '2026-10-12T00:00:00Z', stale: false }) }; }, () => new Date('2026-10-12T00:01:00Z'));
  assert.equal(seen, 'Bearer K'); assert.equal(ok.stale, false);
  await assert.rejects(probeOnce('K', async () => ({ ok: true, json: async () => ({}) })), /SHAPE/);
  await assert.rejects(probeOnce('K', async () => ({ ok: false, status: 401 })), /HTTP_401/);
});
