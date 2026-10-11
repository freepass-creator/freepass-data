import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { orderedJsonDigest } from '../src/shared/stable-digest.js';

const state = vi.hoisted(() => ({ plan: {} as any, count: 2, changedBytes: false,
  readFile: vi.fn(), getVehicle: vi.fn(), getPhoto: vi.fn(), publish: vi.fn(), config: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: state.readFile, stat: async () => ({ size: 1000 }) }));
vi.mock('../src/jobs/data-access-runtime.js', () => ({ runIancarPhotoPublication: state.publish }));
vi.mock('../src/adapters/iancar-one-api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/adapters/iancar-one-api.js')>()),
  iancarOneApiConfigFromEnv: state.config,
  createIancarOneApiClient: () => ({ getVehicle: state.getVehicle, getPhoto: state.getPhoto }),
  iancarOnePhotoIds: (detail: any) => detail.photos.map((photo: any) => photo.photo_id),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const digest = 'a'.repeat(64);
let output: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('SYNTHETIC_CLI_EXIT'); });
  process.exitCode = undefined;
  vi.stubEnv('IANCAR_PHOTO_REVIEW_APPROVED', 'true');
  const observedAt = new Date(Date.now() - 1_200_000).toISOString();
  const ids = ['synthetic-photo-a', 'synthetic-photo-b'];
  const row = { productId: 'synthetic-product', vehicleId: 'synthetic-vehicle', plate: 'synthetic-plate', count: 2, observedAt };
  const binding = orderedJsonDigest(['RP031', row.productId, row.vehicleId, row.plate]);
  const set = orderedJsonDigest(['ONE_PHOTO_SET/1', binding, ids, ids]);
  const photoSha256 = createHash('sha256').update(Buffer.from([255, 216, 255, 1])).digest('hex');
  state.plan = { records: [{ ...row, review: { upstreamPhotoIds: ids, servingPhotoIds: ids,
    refs: ids.map((id, i) => ({ sourceKind: 'IANCAR_ONE', sourceApiVersion: 'iancar-one-api/1', sourceBindingDigest: binding,
      photoSetDigest: set, sourcePhotoIdDigest: orderedJsonDigest(id), sourceOrdinal: i, servingIndex: i,
      mediaType: 'image/jpeg', photoSha256, sourceObservedAt: observedAt, vehiclePhotoVerifiedBy: 'synthetic-reviewer',
      vehiclePhotoVerificationMethod: 'ONE 차량사진 전용 확인; 범위=synthetic fixed set; 방법=synthetic fixture; 근거=synthetic private evidence',
      vehiclePhotoVerifiedAt: observedAt })) } }] };
  state.count = 2; state.changedBytes = false;
  state.readFile.mockImplementation(async () => JSON.stringify(state.plan));
  state.config.mockReturnValue({ apiKey: 'synthetic-credential-never-output' });
  state.getVehicle.mockImplementation(async () => ({ photos: ids.slice(0, state.count).map(photo_id => ({ photo_id })) }));
  state.getPhoto.mockImplementation(async () => new Response(Buffer.from([255, 216, 255, state.changedBytes ? 2 : 1]),
    { headers: { 'content-type': 'image/jpeg' } }));
  state.publish.mockResolvedValue({ status: 'SYNTHETIC_RESULT', count: 1, planDigest: digest, writeExecuted: false });
});
afterEach(() => { process.argv = originalArgv; process.exitCode = originalExitCode; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function run(args: string[]) {
  process.argv = ['node', 'synthetic-entry', ...args];
  await expect(import('../src/jobs/collect-iancar-one-api.js')).rejects.toThrow('SYNTHETIC_CLI_EXIT');
}
const options = ['--reviewed-plan=synthetic-private-plan', `--expected-digest=${digest}`];

it.each(['--sync', '--photos', '--apply-raw', '--restore-photos=other', '--unknown'])('refuses mixed option %s before reads', async option => {
  await run([...options, option]);
  expect(state.readFile).not.toHaveBeenCalled(); expect(state.publish).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
it.each(['multiple', 'unknown', 'unreviewed'])('rejects %s plan before source I/O', async condition => {
  if (condition === 'multiple') state.plan.records.push(state.plan.records[0]);
  if (condition === 'unknown') state.plan.records[0].credential = 'synthetic-secret';
  if (condition === 'unreviewed') state.plan.records[0].review.refs[0].vehiclePhotoVerifiedBy = '';
  await run([...options, '--apply']);
  expect(state.getVehicle).not.toHaveBeenCalled(); expect(state.publish).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
it('requires separate explicit apply authorization', async () => {
  vi.stubEnv('IANCAR_PHOTO_REVIEW_APPROVED', 'false');
  await run([...options, '--apply']);
  expect(state.readFile).not.toHaveBeenCalled(); expect(state.publish).not.toHaveBeenCalled();
});
it('dry-run reads one selected plan without supplier collection or apply', async () => {
  state.plan.records[0].observedAt = new Date().toISOString();
  await run(options);
  expect(state.config).not.toHaveBeenCalled(); expect(state.getVehicle).not.toHaveBeenCalled();
  expect(state.publish).toHaveBeenCalledWith(expect.objectContaining({ verificationOnly: true, apply: false, expectedPlanDigest: digest }));
  expect(state.publish.mock.calls[0]![0].records).toHaveLength(1);
});
it('PLAN discovery returns a normal dry-run receipt and can refresh an old capture only after real source checks', async () => {
  await run(['--reviewed-plan=synthetic-private-plan', '--expected-digest=PLAN']);
  expect(process.exitCode).not.toBe(1);
  expect(state.getVehicle).toHaveBeenCalledTimes(2); expect(state.getPhoto).toHaveBeenCalledTimes(2);
  expect(state.publish.mock.calls[0]![0].apply).toBe(false);
  expect(state.publish.mock.calls[0]![0]).not.toHaveProperty('expectedPlanDigest');
  expect(JSON.parse(output.mock.calls[0]![0] as string).planDigest).toBe(digest);
});
it('PLAN discovery can never authorize apply', async () => {
  await run(['--reviewed-plan=synthetic-private-plan', '--expected-digest=PLAN', '--apply']);
  expect(state.readFile).not.toHaveBeenCalled(); expect(state.publish).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
it('rechecks all raw bytes and both source snapshots while preserving human timestamps', async () => {
  const actualReviewTime = state.plan.records[0].review.refs[0].vehiclePhotoVerifiedAt;
  const earlierCapture = state.plan.records[0].observedAt;
  await run([...options, '--apply']);
  expect(process.exitCode).not.toBe(1);
  expect(state.getVehicle).toHaveBeenCalledTimes(2); expect(state.getPhoto).toHaveBeenCalledTimes(2);
  const input = state.publish.mock.calls[0]![0];
  expect(input.verificationOnly).toBe(true); expect(input.apply).toBe(true);
  expect(input.records[0].observedAt).not.toBe(earlierCapture);
  expect(input.records[0].review.refs[0].vehiclePhotoVerifiedAt).toBe(actualReviewTime);
});
it.each(['set', 'bytes', 'final-set'])('source %s change refuses publication and timestamp renewal', async condition => {
  const capture = state.plan.records[0].observedAt;
  if (condition === 'set') state.count = 1;
  if (condition === 'bytes') state.changedBytes = true;
  if (condition === 'final-set') state.getVehicle.mockResolvedValueOnce({ photos: state.plan.records[0].review.servingPhotoIds.map((photo_id: string) => ({ photo_id })) })
    .mockResolvedValueOnce({ photos: [] });
  await run([...options, '--apply']);
  expect(state.publish).not.toHaveBeenCalled(); expect(state.plan.records[0].observedAt).toBe(capture);
  expect(process.exitCode).toBe(1);
  expect(JSON.stringify([...output.mock.calls, ...errors.mock.calls])).not.toContain('synthetic-credential-never-output');
  expect(JSON.stringify(errors.mock.calls)).not.toContain('synthetic-photo');
});
