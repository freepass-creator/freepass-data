// Synthetic fixtures only. These are NOT manufacturer specifications or production master data.
export const fixture = () => ({
  schemaVersion: 'freepass.vehicle-finder.read/v1', observationId: 'synthetic-fixture-20260925',
  observedAt: '2026-09-25T09:00:00Z', coverage: 'PARTIAL', entries: [
    { id: 'fixture:model:a', level: 'MODEL', label: '시험차 A', aliases: ['TEST-A', '테스트에이'], configurations: [
      { id: 'fixture:config:hev5', evidenceId: 'fixture:evidence:1', terms: ['하이브리드', 'HEV', '5인승', '2024', '프리미엄'], facets: { fuel: 'HEV', seatCount: 5, modelYear: 2024, trim: '프리미엄' } },
      { id: 'fixture:config:diesel7', evidenceId: 'fixture:evidence:2', terms: ['디젤', '7인승', '2023', '프리미엄'], facets: { fuel: 'DIESEL', seatCount: 7, modelYear: 2023, trim: '프리미엄' } },
    ] },
    { id: 'fixture:model:b', level: 'MODEL', label: '시험차 B', aliases: ['TEST-B'], configurations: [] },
    { id: 'fixture:trim:c', level: 'TRIM', label: '시험차 C 노블레스', aliases: ['노블레스', 'CODE-C'], configurations: [
      { id: 'fixture:config:c', evidenceId: 'fixture:evidence:3', terms: ['가솔린', '5인승'], facets: { fuel: 'GASOLINE', seatCount: 5, modelYear: null, trim: '노블레스' } },
    ] },
  ],
});
