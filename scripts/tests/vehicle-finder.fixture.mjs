// Synthetic fixtures only. These are NOT manufacturer specifications or production master data.
const path = (...nodes) => nodes.map(([id, nodeType, label]) => ({ id, nodeType, label }));

export const fixture = () => ({
  schemaVersion: 'freepass.vehicle-finder.read/v2',
  observationId: 'synthetic-fixture-20260925',
  observedAt: '2026-09-25T09:00:00Z',
  coverage: 'PARTIAL',
  entries: [
    {
      id: 'fixture:make:a',
      nodeType: 'MAKE',
      label: '시험제조사',
      aliases: ['TEST-MAKE'],
      path: path(['fixture:make:a', 'MAKE', '시험제조사']),
      configurations: [],
    },
    {
      id: 'fixture:model:a',
      nodeType: 'MODEL',
      label: '시험차 A',
      aliases: ['TEST-A', '테스트에이'],
      path: path(
        ['fixture:make:a', 'MAKE', '시험제조사'],
        ['fixture:model:a', 'MODEL', '시험차 A'],
      ),
      configurations: [
        {
          id: 'fixture:config:hev5',
          evidenceId: 'fixture:evidence:1',
          terms: ['하이브리드', 'HEV', '5인승', '2024', '프리미엄'],
          facets: { fuel: 'HEV', seatCount: 5, modelYear: 2024, drivetrain: '2WD', trim: '프리미엄' },
        },
        {
          id: 'fixture:config:diesel7',
          evidenceId: 'fixture:evidence:2',
          terms: ['디젤', '7인승', '2023', '프리미엄'],
          facets: { fuel: 'DIESEL', seatCount: 7, modelYear: 2023, drivetrain: null, trim: '프리미엄' },
        },
      ],
    },
    {
      id: 'fixture:model:b',
      nodeType: 'MODEL',
      label: '시험차 B',
      aliases: ['TEST-B'],
      path: path(
        ['fixture:make:a', 'MAKE', '시험제조사'],
        ['fixture:model:b', 'MODEL', '시험차 B'],
      ),
      configurations: [],
    },
    {
      id: 'fixture:trim:c',
      nodeType: 'TRIM',
      label: '프레스티지',
      aliases: ['CODE-C'],
      path: path(
        ['fixture:make:kia', 'MAKE', '기아'],
        ['fixture:model:sorento', 'MODEL', '쏘렌토'],
        ['fixture:my:sorento:2027', 'MODEL_YEAR', '2027'],
        ['fixture:trim:c', 'TRIM', '프레스티지'],
      ),
      configurations: [
        {
          id: 'fixture:config:c',
          evidenceId: 'fixture:evidence:3',
          terms: ['가솔린', '5인승'],
          facets: { fuel: 'GASOLINE', seatCount: 5, modelYear: 2027, drivetrain: '2WD', trim: '프레스티지' },
        },
      ],
    },
    {
      id: 'fixture:trim:d',
      nodeType: 'TRIM',
      label: '프레스티지',
      aliases: ['CODE-D'],
      path: path(
        ['fixture:make:kia', 'MAKE', '기아'],
        ['fixture:model:sportage', 'MODEL', '스포티지'],
        ['fixture:my:sportage:2027', 'MODEL_YEAR', '2027'],
        ['fixture:trim:d', 'TRIM', '프레스티지'],
      ),
      configurations: [
        {
          id: 'fixture:config:d',
          evidenceId: 'fixture:evidence:4',
          terms: ['하이브리드', '5인승'],
          facets: { fuel: 'HEV', seatCount: 5, modelYear: 2027, drivetrain: '4WD', trim: '프레스티지' },
        },
      ],
    },
    {
      id: 'fixture:option:hidden',
      nodeType: 'OPTION',
      label: '테스트 옵션',
      aliases: [],
      path: path(
        ['fixture:make:kia', 'MAKE', '기아'],
        ['fixture:model:sorento', 'MODEL', '쏘렌토'],
        ['fixture:option:hidden', 'OPTION', '테스트 옵션'],
      ),
      configurations: [],
    },
  ],
});
