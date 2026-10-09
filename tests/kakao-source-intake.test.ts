import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareKakaoBundle, bytesSha256, type KakaoBundle } from '../src/adapters/kakao-source-intake.js';
import { planKakaoIntake, ingestKakaoBundle, assertPrivateDrive, applyKakaoPhotoPlan } from '../src/application/kakao-source-intake.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
import { FirestoreSourceStore } from '../src/infra/source-firestore-store.js';
import { prepareRawSourceBatch } from '../src/application/ingest-raw-source.js';
import { canAssertSourceAbsence } from '../src/domain/source.js';
import type { KakaoDriveArchivePort, DriveArchiveFile, DriveArchiveRequest } from '../src/ports/kakao-archive.js';
import { runKakaoSourceCli } from '../src/jobs/ingest-kakao-source.js';
import type { Firestore } from 'firebase-admin/firestore';

const now = () => new Date().toISOString();
function bundle(pc = 'PC-A'): KakaoBundle {
  return { supplierCode: 'FAKE_SUPPLIER', roomId: 'fake-room', collectorId: pc, observedAt: '2026-10-09T09:00:00Z',
    messages: [{ messageId: 'fake-message-1', sentAt: '2026-10-09T08:00:00Z', text: '오늘 매물 FAKE-VEHICLE-A 사진',
      attachments: [{ bytesBase64: Buffer.from('fake photograph bytes').toString('base64'), mediaType: 'image/jpeg', role: 'VEHICLE_PHOTO' }],
      captureVerified: true, version: 0, vehicle: { supplierVehicleId: 'FAKE-VEHICLE-A', evidenceText: 'FAKE-VEHICLE-A' } }] };
}
const products = [{ id: 'fake-product', data: { provider_company_code: 'FAKE_SUPPLIER',
  fake_existing_vehicle_id: 'FAKE-VEHICLE-A', photo_link: '' }, supplierVehicleIdField: 'fake_existing_vehicle_id' }];
const permissions = [{ type: 'domain' as const, domain: 'example.invalid', role: 'reader', allowFileDiscovery: false }];
class FakeDrive implements KakaoDriveArchivePort {
  files = new Map<string, DriveArchiveFile>(); uploads = 0; loseNextReply = false; publicDestination = false;
  async inspectDestination() { return { permissions: this.publicDestination
    ? [{ type: 'anyone' as const, role: 'reader' }] : permissions, permissionsComplete: true, ancestorPermissionsChecked: true }; }
  async find(properties: DriveArchiveRequest['appProperties']) {
    return [...this.files.values()].filter(f => f.appProperties.eventId === properties.eventId && f.sha256 === properties.sha256);
  }
  async upload(input: DriveArchiveRequest) {
    const id = `fake-file-${++this.uploads}`;
    this.files.set(id, { id, directory: input.directory, sha256: bytesSha256(input.bytes),
      appProperties: input.appProperties, permissionsComplete: true, ancestorPermissionsChecked: true, permissions });
    if (this.loseNextReply) { this.loseNextReply = false; throw new Error('simulated reply loss'); }
    return { id };
  }
  async verify(id: string) { return structuredClone(this.files.get(id)!); }
}
function setup(store = new MemorySourceStore()) {
  const drive = new FakeDrive();
  const ports = { store, drive, organizationDomain: 'example.invalid', products };
  const ingest = (input: KakaoBundle) => ingestKakaoBundle(input, ports, { apply: true, approval: 'approved', now: now() });
  return { store, drive, ports, ingest };
}

describe('Kakao RAW intake and private photo branch', () => {
  it('two PCs yield one event, two RAW observations, one upload per event/hash', async () => {
    const { store, drive, ingest } = setup();
    await Promise.all([ingest(bundle()), ingest(bundle('PC-B'))]);
    const event = await store.getEvent(prepareKakaoBundle(bundle())[0]!.eventId!);
    expect(event?.observations).toHaveLength(2);
    expect(new Set(event?.observations.map(x => x.rawRef)).size).toBe(2);
    expect(drive.uploads).toBe(2); // original JSON plus photograph
    expect(event?.state).toBe('ARCHIVED');
    expect(event?.firstRawRef).toBe(event?.latestRawRef);
  });
  it('restarts reconcile an uploaded response loss without re-uploading', async () => {
    const { store, drive, ingest } = setup();
    // Lose the photograph reply after both original and photograph have arrived.
    const upload = drive.upload.bind(drive);
    drive.upload = async request => { if (drive.uploads === 1) drive.loseNextReply = true; return upload(request); };
    expect((await ingest(bundle()))[0]?.status).toBe('UNKNOWN');
    expect((await ingest(bundle()))[0]?.status).toBe('ARCHIVED');
    expect(drive.uploads).toBe(2);
    expect((await store.getEvent(prepareKakaoBundle(bundle())[0]!.eventId!))?.observations).toHaveLength(1);
  });
  it('incomplete upload stays UNKNOWN after restart even if its lease expires', async () => {
    const { drive, ingest } = setup(); drive.loseNextReply = true;
    await ingest(bundle());
    expect((await ingest(bundle()))[0]?.status).toBe('UNKNOWN');
    expect(drive.uploads).toBe(1);
  });
  it('lost claim reply triggers a read and never an upload', async () => {
    class LostReplyStore extends MemorySourceStore {
      override async claimEvent(input: Parameters<MemorySourceStore['claimEvent']>[0]): Promise<never> {
        await super.claimEvent(input); throw new Error('reply lost');
      }
    }
    const { drive, ingest, store } = setup(new LostReplyStore());
    const read = vi.spyOn(store, 'getEvent');
    expect((await ingest(bundle()))[0]?.status).toBe('UNKNOWN');
    expect(read).toHaveBeenCalledOnce(); expect(drive.uploads).toBe(0);
  });
  it('same sentence and same file resent are distinct message events', async () => {
    const { drive, ingest } = setup();
    const b = bundle(); b.messages.push({ ...structuredClone(b.messages[0]!), messageId: 'fake-message-2' });
    const planned = planKakaoIntake(b, products);
    expect(planned[0]?.eventId).not.toBe(planned[1]?.eventId);
    expect(planned[0]?.attachmentHashes).toEqual(planned[1]?.attachmentHashes);
    await ingest(b); expect(drive.uploads).toBe(4);
  });
  it('uses shared sender/time/sequence fallback, never text plus minute', () => {
    const a = bundle(); delete a.messages[0]!.messageId;
    expect(planKakaoIntake(a)[0]?.issues).toContain('IDENTITY_UNRESOLVED');
    Object.assign(a.messages[0]!, { senderKey: 'fake-sender', sequence: '1', sequenceScope: 'ROOM' });
    const first = planKakaoIntake(a)[0]!.eventId;
    a.collectorId = 'PC-B'; a.observedAt = '2026-10-09T09:10:00Z';
    expect(planKakaoIntake(a)[0]!.eventId).toBe(first);
    a.messages[0]!.sequence = '2'; expect(planKakaoIntake(a)[0]!.eventId).not.toBe(first);
  });
  it('preserves unresolved observations as RAW and holds Drive/products', async () => {
    const { drive, store, ingest } = setup(); const b = bundle(); delete b.messages[0]!.messageId;
    expect((await ingest(b))[0]?.issues).toContain('IDENTITY_UNRESOLVED');
    const batch = prepareKakaoBundle(b)[0]!.batch;
    expect(await store.listRaw(prepareRawSourceBatch(batch).runId)).toHaveLength(1);
    expect(drive.uploads).toBe(0);
  });
  it('PARTIAL lists never retire unseen vehicles and notices never imply stock zero', async () => {
    const { store, ingest } = setup(); const b = bundle();
    await ingest(b);
    const run = await store.getRun(prepareRawSourceBatch(prepareKakaoBundle(b)[0]!.batch).runId);
    expect(canAssertSourceAbsence(run!)).toBe(false);
    b.messages[0]!.text = '2차 없습니다';
    expect(planKakaoIntake(b)[0]).toMatchObject({ classification: 'STATUS_NOTICE_CANDIDATE', deletionCount: 0, stockZeroAsserted: false });
  });
  it('matches a photo only by supplier plus explicit raw identity, preserves existing link', () => {
    expect(planKakaoIntake(bundle(), products)[0]?.photo.plan?.productId).toBe('fake-product');
    expect(planKakaoIntake(bundle(), [products[0]!, products[0]!])[0]?.photo.plan).toBeNull();
    expect(planKakaoIntake(bundle(), [{ ...products[0]!, data: { ...products[0]!.data, provider_company_code: 'OTHER' } }])[0]?.photo.plan).toBeNull();
    expect(planKakaoIntake(bundle(), [{ ...products[0]!, data: { ...products[0]!.data, photo_link: 'existing' } }])[0]?.photo.plan).toBeNull();
    const b = bundle(); b.messages[0]!.vehicle!.evidenceText = 'invented';
    expect(planKakaoIntake(b, products)[0]?.photo.plan).toBeNull();
    b.messages[0]!.vehicle!.evidenceText = 'FAKE-VEHICLE-A'; b.messages[0]!.sheetConflict = true;
    expect(planKakaoIntake(b, products)[0]?.photo.holds).toContain('CONFLICT');
  });
  it('private verified photo links exclude the original conversation/document file', async () => {
    const { ingest } = setup(); const result = (await ingest(bundle()))[0]!;
    expect('photo' in result && result.photo?.plan?.archiveIds).toEqual(['fake-file-2']);
    expect('photo' in result && result.photo?.plan?.after).toBe('https://drive.google.com/file/d/fake-file-2/view');
  });
  it('rejects public and external/incomplete permissions before uploading', async () => {
    const { drive, ingest } = setup(); drive.publicDestination = true;
    await ingest(bundle()); expect(drive.uploads).toBe(0);
    expect(() => assertPrivateDrive({ permissions: [{ type: 'anyone', role: 'reader' }], permissionsComplete: true,
      ancestorPermissionsChecked: true }, 'example.invalid')).toThrow('DRIVE_PRIVATE');
    expect(() => assertPrivateDrive({ permissions, permissionsComplete: false,
      ancestorPermissionsChecked: true }, 'example.invalid')).toThrow('DRIVE_PRIVATE');
    expect(() => assertPrivateDrive({ permissions, permissionsComplete: true,
      ancestorPermissionsChecked: true }, 'other.invalid')).toThrow('DRIVE_PRIVATE');
  });
  it('freezes firstRawRef and only advances latestRawRef for verified higher versions', async () => {
    const { store, ingest } = setup(); const b = bundle(); await ingest(b);
    const id = prepareKakaoBundle(b)[0]!.eventId!; const first = (await store.getEvent(id))!;
    b.messages[0]!.text += ' corrected'; b.messages[0]!.version = 1; b.messages[0]!.captureVerified = false;
    await ingest(b); expect((await store.getEvent(id))?.latestRawRef).toBe(first.latestRawRef);
    b.messages[0]!.captureVerified = true; await ingest(b);
    expect((await store.getEvent(id))?.firstRawRef).toBe(first.firstRawRef);
    expect((await store.getEvent(id))?.latestRawRef).not.toBe(first.latestRawRef);
    expect((await store.getEvent(id))?.state).toBe('UNKNOWN');
  });
  it('CLI dry run writes zero; apply needs both flag, environment and injected live ports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kakao-fake-'));
    try {
      const path = join(dir, 'fake.json'); await writeFile(path, JSON.stringify({ bundle: bundle(), products }), 'utf8');
      const { ports } = setup(); const upload = vi.spyOn(ports.drive, 'upload'); const claim = vi.spyOn(ports.store, 'claimEvent');
      expect(await runKakaoSourceCli([path], {}, ports)).toMatchObject({ mode: 'DRY_RUN', writes: 0 });
      expect(upload).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
      const compiled = spawnSync(process.execPath, ['dist/src/jobs/ingest-kakao-source.js', path], { encoding: 'utf8' });
      expect(compiled.status, compiled.stderr).toBe(0);
      expect(JSON.parse(compiled.stdout)).toMatchObject({ mode: 'DRY_RUN', writes: 0 });
      await expect(runKakaoSourceCli([path, '--apply'], {}, ports)).rejects.toThrow('KAKAO_APPLY_NOT_APPROVED');
      await expect(runKakaoSourceCli([path, '--apply'], { FREEPASS_KAKAO_SOURCE_APPLY: 'approved' })).rejects.toThrow('HOLD_KAKAO_LIVE_PORTS');
    } finally {
      if (!dir.startsWith(join(tmpdir(), 'kakao-fake-'))) throw new Error('UNSAFE_TEST_CLEANUP');
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('photo apply refuses unresolved display/approval and requires dry-run digest', async () => {
    const plan = planKakaoIntake(bundle(), products)[0]!.photo.plan!;
    const port = { dryRun: vi.fn(async () => ({ planDigest: 'digest', ready: true })), apply: vi.fn(async () => ({ verified: true })) };
    await expect(applyKakaoPhotoPlan(plan, port, { apply: true, approval: 'approved', expectedPlanDigest: 'digest' })).rejects.toThrow('PHOTO_PLAN_HOLD');
    const reviewed = { ...plan, holds: [], after: 'https://drive.google.com/file/d/fake-file/view', archiveIds: ['fake-file'] };
    await expect(applyKakaoPhotoPlan(reviewed, port, { apply: true, approval: undefined, expectedPlanDigest: 'digest' })).rejects.toThrow('PHOTO_APPLY_NOT_APPROVED');
    await expect(applyKakaoPhotoPlan(reviewed, port, { apply: true, approval: 'approved', expectedPlanDigest: 'stale' })).rejects.toThrow('PHOTO_APPLY_NOT_APPROVED');
    expect(await applyKakaoPhotoPlan(reviewed, port, { apply: true, approval: 'approved', expectedPlanDigest: 'digest' })).toEqual({ verified: true });
    expect(port.apply).toHaveBeenCalledOnce();
    await expect(applyKakaoPhotoPlan({ ...reviewed, after: 'https://example.invalid/public' }, port,
      { apply: true, approval: 'approved', expectedPlanDigest: 'digest' })).rejects.toThrow('PHOTO_PLAN_INVALID');
    port.apply.mockResolvedValueOnce({ verified: false });
    await expect(applyKakaoPhotoPlan(reviewed, port,
      { apply: true, approval: 'approved', expectedPlanDigest: 'digest' })).rejects.toThrow('PHOTO_APPLY_READBACK_UNVERIFIED');
  });
  it('verified local table extraction keeps cells, hash, extractor version and lineage in existing stores', async () => {
    const { store, ingest } = setup(); const b = bundle();
    const bytes = Buffer.from('label,value\nfake,unknown');
    b.messages[0]!.attachments = [{ bytesBase64: bytes.toString('base64'), mediaType: 'text/csv', role: 'DOCUMENT' }];
    b.messages[0]!.tables = [{ attachmentSha256: bytesSha256(bytes), extractorVersion: 'fake-reader/1',
      verified: true, sheet: 'fake-table', startRow: 1, rows: [['label', 'value'], ['fake', 'unknown']] }];
    expect(planKakaoIntake(b)[0]?.tableEvidenceCellCount).toBe(4);
    await ingest(b); const runId = prepareRawSourceBatch(prepareKakaoBundle(b)[0]!.batch).runId;
    expect((await store.getRun(runId))?.lineageCount).toBe(4);
    expect(await store.listLineage(runId)).toHaveLength(4);
    await ingest(b);
    expect(await store.listLineage(runId)).toHaveLength(4);
    expect(await store.listCandidates(runId)).toEqual([]);
    b.messages[0]!.tables[0]!.attachmentSha256 = 'a'.repeat(64);
    expect(() => planKakaoIntake(b)).toThrow('INVALID_KAKAO_TABLE');
  });
  it('document/photograph ambiguity never creates a product link', () => {
    const b = bundle(); b.messages[0]!.attachments.push({ ...b.messages[0]!.attachments[0]!, role: 'DOCUMENT' });
    expect(planKakaoIntake(b, products)[0]?.photo.holds).toContain('ATTACHMENT_ROLE_CONFLICT');
    expect(planKakaoIntake(b, products)[0]?.photo.plan).toBeNull();
  });
});

describe('Firestore event receipt transaction adapter (fake transport)', () => {
  it('uses one create and revision CAS, retaining both observations', async () => {
    const rows = new Map<string, unknown>(); let creates = 0; let tail = Promise.resolve();
    const ref = (name: string) => ({ id: name });
    const db = { collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
      runTransaction: (fn: (tx: unknown) => Promise<unknown>) => {
        const pending = tail.then(() => fn({ get: async (r: { id: string }) => ({ exists: rows.has(r.id), data: () => structuredClone(rows.get(r.id)) }),
          create: (r: { id: string }, v: unknown) => { if (rows.has(r.id)) throw new Error('ALREADY_EXISTS'); creates++; rows.set(r.id, structuredClone(v)); },
          update: (r: { id: string }, v: unknown) => { rows.set(r.id, structuredClone(v)); } }));
        tail = pending.then(() => undefined, () => undefined); return pending;
      } };
    const store = new FirestoreSourceStore(db as unknown as Firestore);
    const input = { eventId: 'a'.repeat(64), sourceId: 'fake-source', owner: 'owner-a', now: now(),
      leaseUntil: new Date(Date.now() + 300_000).toISOString(), observation: { observationId: 'obs-a', rawRef: 'raw-a',
        fingerprint: 'b'.repeat(64), version: 0, verified: true } };
    const [a, b] = await Promise.all([store.claimEvent(input), store.claimEvent({ ...input, owner: 'owner-b',
      observation: { ...input.observation, observationId: 'obs-b', rawRef: 'raw-b' } })]);
    expect([a.acquired, b.acquired]).toEqual([true, false]); expect(creates).toBe(1);
    expect(b.receipt.observations).toHaveLength(2);
    await expect(store.finishEvent(input.eventId, { revision: a.receipt.revision, state: 'ARCHIVED', archiveRefs: [] })).rejects.toThrow('REVISION_CONFLICT');
    expect((await store.finishEvent(input.eventId, { revision: b.receipt.revision, state: 'ARCHIVED', archiveRefs: ['fake'] })).revision).toBe(3);
  });
});
