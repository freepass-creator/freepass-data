import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { KakaoDriveArchive } from '../src/infra/kakao-drive-archive.js';
import { KakaoPhotoWriter, KakaoProductReader } from '../src/infra/kakao-live-ports.js';
import { stableDigest } from '../src/shared/stable-digest.js';
import type { KakaoPhotoPlan } from '../src/ports/kakao-archive.js';

const eventId = 'a'.repeat(64);
const bytes = Buffer.from('synthetic picture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const directory = `원문/카카오톡/FAKE/2026-10/${eventId}/`;
const request = { directory, name: sha256, bytes, mediaType: 'image/jpeg', appProperties: { eventId, sha256 } };
const owner = { type: 'user', role: 'owner', emailAddress: 'pyh@teamjpk.com' };
const FOLDER = 'application/vnd.google-apps.folder';
function fakeDrive() {
  const entries = new Map<string, any>();
  const permissions = new Map<string, any[]>();
  const add = (id: string, name: string, parents: string[], mimeType = FOLDER, appProperties?: unknown) => {
    entries.set(id, { id, name, parents, mimeType, trashed: false, owners: [{ emailAddress: owner.emailAddress }], appProperties });
  };
  add('synthetic-root', 'root', ['synthetic-my-drive']);
  add('synthetic-my-drive', 'My Drive', []);
  let creates = 0, uploads = 0, download = bytes, lost: 'none' | 'upload' | 'folder' | 'server' = 'none';
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.pathname === '/upload/drive/v3/files') {
      uploads++;
      if (lost === 'server') return json({}, 503);
      if (lost === 'upload') throw new Error('lost reply');
      const body = Buffer.from(init!.body as Uint8Array).toString();
      const meta = JSON.parse(body.split('\r\n\r\n')[1]!.split('\r\n--')[0]!);
      add(`file-${uploads}`, meta.name, meta.parents, 'image/jpeg', meta.appProperties);
      return json({ id: `file-${uploads}` });
    }
    if (url.pathname === '/drive/v3/files' && init?.method === 'POST') {
      creates++;
      if (lost === 'folder') throw new Error('lost folder reply');
      const meta = JSON.parse(init.body as string);
      add(`folder-${creates}`, meta.name, meta.parents);
      return json(entries.get(`folder-${creates}`));
    }
    if (url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q')!;
      let files = [...entries.values()];
      if (q.includes('appProperties')) files = files.filter(f => f.appProperties?.eventId === eventId && f.appProperties?.sha256 === sha256);
      else {
        const parent = /'([^']+)' in parents/.exec(q)![1];
        const name = /name = '([^']+)'/.exec(q)![1];
        files = files.filter(f => f.parents.includes(parent) && f.name === name);
      }
      return json({ files, incompleteSearch: false });
    }
    const id = /\/files\/([^/]+)/.exec(url.pathname)?.[1];
    if (url.pathname.endsWith('/permissions')) return json({ permissions: permissions.get(id!) ?? [owner] });
    if (url.searchParams.get('alt') === 'media') return new Response(download);
    if (id && entries.has(id)) return json(entries.get(id));
    throw new Error('Unexpected fake request');
  }) as unknown as typeof fetch;
  return { port: new KakaoDriveArchive('synthetic-root', async () => 'synthetic-token', transport), entries, permissions, add,
    transport, counts: () => ({ creates, uploads }), lose: (value: typeof lost) => { lost = value; },
    corrupt: () => { download = Buffer.from('different bytes'); } };
}

describe('Kakao Drive REST (no network)', () => {
  it('inspection is read-only, then creates three folders once and hashes the download', async () => {
    const f = fakeDrive();
    await f.port.inspectDestination(directory);
    expect(f.counts()).toEqual({ creates: 0, uploads: 0 });
    const file = await f.port.upload(request);
    expect((await f.port.verify(file.id)).sha256).toBe(sha256);
    expect(await f.port.find(request.appProperties)).toHaveLength(1);
    await f.port.upload(request);
    expect(f.counts()).toEqual({ creates: 3, uploads: 1 });
  });
  it('serializes concurrent uploads and does not create same-name folders twice', async () => {
    const f = fakeDrive();
    expect(await Promise.all([f.port.upload(request), f.port.upload(request)])).toEqual([{ id: 'file-1' }, { id: 'file-1' }]);
    expect(f.counts()).toEqual({ creates: 3, uploads: 1 });
  });
  it.each(['anyone', 'domain', 'group', 'user'])('denies an additional %s permission before sending bytes', async type => {
    const f = fakeDrive();
    f.permissions.set('synthetic-root', [owner, { type, role: 'reader', emailAddress: 'colleague@teamjpk.com' }]);
    await expect(f.port.upload(request)).rejects.toThrow('DRIVE_PRIVATE_ACCESS_REQUIRED');
    expect(f.counts()).toEqual({ creates: 0, uploads: 0 });
  });
  it('reads parent permissions and rejects inherited sharing and a different owner', async () => {
    const f = fakeDrive();
    f.permissions.set('synthetic-my-drive', [owner, { type: 'anyone', role: 'reader' }]);
    await expect(f.port.inspectDestination(directory)).rejects.toThrow('DRIVE_PRIVATE_ACCESS_REQUIRED');
    f.permissions.clear();
    f.entries.get('synthetic-root').owners = [{ emailAddress: 'other@teamjpk.com' }];
    await expect(f.port.inspectDestination(directory)).rejects.toThrow('DRIVE_PRIVATE_ACCESS_REQUIRED');
  });
  it('existing duplicate folders are a conflict, never arbitrarily selected', async () => {
    const f = fakeDrive();
    f.add('duplicate-a', 'FAKE', ['synthetic-root']); f.add('duplicate-b', 'FAKE', ['synthetic-root']);
    await expect(f.port.upload(request)).rejects.toThrow('DRIVE_ARCHIVE_CONFLICT');
    expect(f.counts().creates).toBe(0);
  });
  it('does not hide a permission on a later page', async () => {
    const f = fakeDrive();
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/synthetic-root/permissions')) return new Response(JSON.stringify(
        url.searchParams.has('pageToken') ? { permissions: [{ type: 'group', role: 'reader' }] }
          : { permissions: [owner], nextPageToken: 'second' }));
      return f.transport(input, init);
    };
    const port = new KakaoDriveArchive('synthetic-root', async () => 'synthetic-token', transport);
    await expect(port.inspectDestination(directory)).rejects.toThrow('DRIVE_PRIVATE_ACCESS_REQUIRED');
    expect(f.counts()).toEqual({ creates: 0, uploads: 0 });
  });
  it.each(['upload', 'server', 'folder'] as const)('%s uncertainty is UNKNOWN and cannot automatically POST again', async loss => {
    const f = fakeDrive(); f.lose(loss);
    await expect(f.port.upload(request)).rejects.toThrow('DRIVE_RESPONSE_UNKNOWN');
    const before = f.counts(); f.lose('none');
    await expect(f.port.upload(request)).rejects.toThrow('DRIVE_RESPONSE_UNKNOWN');
    expect(f.counts()).toEqual(before);
  });
  it('rejects corrupted downloaded bytes and files moved outside the root', async () => {
    const f = fakeDrive(); const file = await f.port.upload(request);
    f.corrupt();
    await expect(f.port.verify(file.id)).rejects.toThrow('DRIVE_READBACK_FAILED');
    f.entries.get(file.id).parents = ['synthetic-my-drive'];
    await expect(f.port.verify(file.id)).rejects.toThrow('DRIVE_READBACK_FAILED');
  });
});

function fakeProduct() {
  let data: Record<string, unknown> = { provider_company_code: 'FAKE', photo_link: '', unchanged: 'keep' };
  let revision = 1, corruptRead = false, conflict = false, writes = 0;
  const ref = { path: 'products/synthetic-product', get: async () => snapshot() };
  const snapshot = () => ({ id: 'synthetic-product', exists: true, ref, updateTime: new Timestamp(revision, 0),
    data: () => structuredClone(corruptRead && writes ? { ...data, photo_link: 'unexpected' } : data) });
  const db = { collection: () => ({ doc: () => ref, where: () => ({ get: async () => ({ docs: [snapshot()] }) }) }),
    runTransaction: async (fn: (tx: any) => Promise<void>) => {
      if (conflict) revision++;
      await fn({ get: async () => snapshot(), update: (_ref: unknown, patch: unknown) => { data = { ...data, ...patch as object }; revision++; writes++; } });
    } } as unknown as Firestore;
  const plan: KakaoPhotoPlan = { eventId, productId: 'synthetic-product', expectedDigest: stableDigest(data), field: 'photo_link',
    before: '', after: 'https://drive.google.com/file/d/synthetic-photo/view', archiveIds: ['synthetic-photo'], status: 'PLAN_ONLY', holds: [] };
  return { db, plan, conflict: () => { conflict = true; }, corrupt: () => { corruptRead = true; }, writes: () => writes };
}
describe('Kakao product read and isolated photo writer', () => {
  it('reads supplier products and a document without writes', async () => {
    const f = fakeProduct(); const reader = new KakaoProductReader(f.db);
    expect(await reader.readSupplier('FAKE')).toHaveLength(1);
    expect((await reader.read('synthetic-product'))?.data.photo_link).toBe('');
    expect(f.writes()).toBe(0);
  });
  it.each(['success', 'conflict', 'mismatch'] as const)('photo %s uses backup, CAS and readback', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'kakao-photo-test-'));
    try {
      const f = fakeProduct(), writer = new KakaoPhotoWriter(f.db, directory, 'approved');
      const approval = await writer.dryRun(f.plan);
      expect(f.writes()).toBe(0);
      if (mode === 'conflict') f.conflict();
      if (mode === 'mismatch') f.corrupt();
      if (mode === 'success') expect(await writer.apply(f.plan, approval)).toEqual({ verified: true });
      else await expect(writer.apply(f.plan, approval)).rejects.toThrow(mode === 'conflict' ? 'PHOTO_CAS_CONFLICT' : 'PHOTO_READBACK_MISMATCH');
      const files = await readdir(directory);
      expect(files.some(f => f.endsWith('-before.json'))).toBe(true);
      expect(files.some(f => f.endsWith('-after.json'))).toBe(mode !== 'conflict');
      expect(f.writes()).toBe(mode === 'conflict' ? 0 : 1);
      const backup = JSON.parse(await readFile(join(directory, files.find(f => f.endsWith('-before.json'))!), 'utf8'));
      expect(backup.before.values.unchanged.value).toBe('keep');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('source approval does not grant photo approval, and holds cannot be bypassed at the writer', async () => {
    const f = fakeProduct();
    const writer = new KakaoPhotoWriter(f.db, undefined, undefined);
    await expect(writer.apply(f.plan, { planDigest: 'fake' })).rejects.toThrow('PHOTO_APPLY_NOT_APPROVED');
    await expect(writer.dryRun({ ...f.plan, holds: ['ERP_PRIVATE_MEDIA_DISPLAY_UNVERIFIED'] })).rejects.toThrow('PHOTO_PLAN_HOLD');
    expect(f.writes()).toBe(0);
  });
});
