import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { albumFingerprint, DEFAULT_PHOTO_COPY_LIMITS, photoCopyCsv, runIancarPhotoCopy, type DriveFileInfo, type DriveVehicleFolder,
  type PhotoCopyDeps, type PhotoCopyLimits, type SourceVehicle } from '../src/application/iancar-photo-drive-copy.js';

const srcKey = (id: string) => createHash('sha256').update(`iancar-one-photo/1\n${id}`).digest('hex').slice(0, 16);
const limits = (over: Partial<PhotoCopyLimits> = {}): PhotoCopyLimits => ({ ...DEFAULT_PHOTO_COPY_LIMITS, intervalMs: 1000, ...over });
const veh = (n: number, label?: string): SourceVehicle => ({ vehicleId: `V${n}`, plate: `12가${String(1000 + n)}`, ...(label ? { label } : {}) });

function world(opts: { vehicles: SourceVehicle[]; photos?: Record<string, string[]>; folders?: Record<string, DriveVehicleFolder[]>;
  failDetail?: Record<string, string>; failDownload?: (vehicleId: string, photoId: string) => string | null }) {
  const calls = { detail: 0, download: 0, upload: 0, create: 0, fingerprint: 0 };
  const log: string[] = [];
  let clock = 1_000_000;
  const folders = new Map(Object.entries(opts.folders ?? {}).map(([k, v]) => [k, structuredClone(v)]));
  let seq = 0;
  const deps: PhotoCopyDeps = {
    now: () => clock,
    sleep: async ms => { log.push(`sleep:${ms}`); clock += ms; },
    source: {
      listVehicles: async () => opts.vehicles,
      photoIds: async v => {
        calls.detail++; log.push(`detail:${v.vehicleId}`);
        const failure = opts.failDetail?.[v.vehicleId]; if (failure) throw Object.assign(new Error(failure), { code: failure });
        return opts.photos?.[v.vehicleId] ?? [`${v.vehicleId}-a`, `${v.vehicleId}-b`];
      },
      download: async (v, id) => {
        calls.download++; log.push(`download:${id}`);
        const failure = opts.failDownload?.(v.vehicleId, id); if (failure) throw Object.assign(new Error(failure), { code: failure });
        return { bytes: Buffer.from(`orig-${id}`), contentType: 'image/jpeg' };
      },
    },
    compress: async input => ({ bytes: Buffer.from(`jpg-${input.bytes.toString()}`), contentType: 'image/jpeg' }),
    drive: {
      findVehicleFolders: async plate => folders.get(plate) ?? [],
      createVehicleFolder: async (plate, label) => {
        calls.create++;
        const f: DriveVehicleFolder = { folderId: `F${++seq}`, name: label ? `${plate} ${label}` : plate, fingerprint: null, files: [] };
        folders.set(plate, [f]); return f;
      },
      upload: async (folderId, name, bytes, key) => {
        calls.upload++; log.push(`upload:${name}`);
        const f = [...folders.values()].flat().find(x => x.folderId === folderId)!;
        const info: DriveFileInfo = { fileId: `X${++seq}`, name, sha256: createHash('sha256').update(bytes).digest('hex'), srcKey: key, image: true };
        f.files.push(info); return info;
      },
      setFingerprint: async (folderId, fp) => {
        calls.fingerprint++;
        [...folders.values()].flat().find(x => x.folderId === folderId)!.fingerprint = fp;
      },
    },
  };
  return { deps, calls, log, folders };
}

describe('이안카 사진 → 드라이브 복사(오케스트레이션)', () => {
  it('DRY_RUN writes nothing: no download, upload, folder creation or fingerprint; reports the plan', async () => {
    const w = world({ vehicles: [veh(1), veh(2)] });
    const r = await runIancarPhotoCopy(w.deps, 'DRY_RUN', limits());
    expect(w.calls).toEqual({ detail: 2, download: 0, upload: 0, create: 0, fingerprint: 0 });
    expect(r.counts.PLANNED_COPY).toBe(2);
    expect(r.completed).toEqual([]);
  });

  it('copies in order (representative first = 01.jpg), records the fingerprint last, and emits the registration CSV', async () => {
    const w = world({ vehicles: [veh(1, '쏘나타')], photos: { V1: ['rep', 'p2', 'p3'] } });
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits());
    expect(w.log.filter(l => l.startsWith('upload:'))).toEqual(['upload:01.jpg', 'upload:02.jpg', 'upload:03.jpg']);
    expect(w.log.filter(l => l.startsWith('download:'))).toEqual(['download:rep', 'download:p2', 'download:p3']);
    expect(r.counts.COPIED).toBe(1); expect(r.photosWritten).toBe(3);
    const folder = w.folders.get('12가1001')![0]!;
    expect(folder.name).toBe('12가1001 쏘나타');
    expect(folder.fingerprint).toBe(albumFingerprint(['rep', 'p2', 'p3']));
    expect(photoCopyCsv(r)).toBe(`번호,폴더\n12가1001,${folder.folderId}\n`);
  });

  it('skips a vehicle whose folder fingerprint and files already match: detail only, zero downloads', async () => {
    const ids = ['a', 'b'];
    const files: DriveFileInfo[] = ids.map((id, i) => ({ fileId: `f${i}`, name: `0${i + 1}.jpg`, sha256: 'x', srcKey: srcKey(id), image: true }));
    const w = world({ vehicles: [veh(1)], photos: { V1: ids }, folders: { '12가1001': [{ folderId: 'F0', name: '12가1001 쏘나타', fingerprint: albumFingerprint(ids), files }] } });
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits());
    expect(r.counts.SKIPPED_SAME).toBe(1);
    expect(w.calls.download + w.calls.upload + w.calls.create + w.calls.fingerprint).toBe(0);
  });

  it('never touches a folder that already holds photos this job did not upload (existing photo source of truth)', async () => {
    const w = world({ vehicles: [veh(1)], folders: { '12가1001': [{ folderId: 'F0', name: '12가1001 쏘나타', fingerprint: null,
      files: [{ fileId: 'f0', name: 'IMG_1.jpg', sha256: 'x', srcKey: null, image: true }] }] } });
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits());
    expect(r.counts.SKIPPED_EXISTING).toBe(1);
    expect(w.calls.download + w.calls.upload + w.calls.create).toBe(0);
  });

  it('holds when two same-number folders both contain photos (no writes, no deletions)', async () => {
    const withPhoto = (id: string, name: string): DriveVehicleFolder => ({ folderId: id, name, fingerprint: null, files: [{ fileId: id + 'f', name: '1.jpg', sha256: null, srcKey: null, image: true }] });
    const w = world({ vehicles: [veh(1)], folders: { '12가1001': [withPhoto('A', '12가1001 쏘나타'), withPhoto('B', '12가1001 쏘나타 DN8 디 엣지')] } });
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits());
    expect(r.counts.AMBIGUOUS_FOLDER).toBe(1);
    expect(w.calls.upload + w.calls.create).toBe(0);
  });

  it('reuses an existing empty number folder (with a model suffix) instead of creating a second one', async () => {
    const w = world({ vehicles: [veh(1, '쏘나타')], folders: { '12가1001': [{ folderId: 'E1', name: '12가1001 쏘나타 DN8', fingerprint: null, files: [] }] } });
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits());
    expect(r.counts.COPIED).toBe(1); expect(w.calls.create).toBe(0);
    expect(r.completed[0]!.folderId).toBe('E1');
  });

  it('resumes a partial copy: same-name same-source files are kept, only missing ones are downloaded; a different source at the same name needs replacement (held)', async () => {
    const partial: DriveFileInfo = { fileId: 'f0', name: '01.jpg', sha256: 'x', srcKey: srcKey('a'), image: true };
    const w = world({ vehicles: [veh(1), veh(2)], photos: { V1: ['a', 'b'], V2: ['c', 'd'] }, folders: {
      '12가1001': [{ folderId: 'P1', name: '12가1001', fingerprint: null, files: [partial] }],
      '12가1002': [{ folderId: 'P2', name: '12가1002', fingerprint: null, files: [{ ...partial, srcKey: srcKey('OLD') }] }] } });
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits());
    expect(r.rows.map(x => x.status)).toEqual(['COPIED', 'NEEDS_REPLACEMENT']);
    expect(w.log.filter(l => l.startsWith('download:'))).toEqual(['download:b']);
    expect(w.calls.upload).toBe(1);
  });

  it('pilot set is fixed: only N vehicles that have source photos count; vehicles without photos are normal «대상 없음»', async () => {
    const vehicles = [1, 2, 3, 4, 5].map(n => veh(n));
    const w = world({ vehicles, photos: { V1: [], V2: ['x'], V3: ['y'], V4: ['z'], V5: ['w'] } });
    const r = await runIancarPhotoCopy(w.deps, 'PILOT', limits({ pilotOnly: 2 }));
    expect(r.counts.NO_TARGET).toBe(1);
    expect(r.counts.COPIED).toBe(2);
    expect(r.stop).toBe('PILOT_SET_DONE');
    expect(r.rows.map(x => x.plate4)).toEqual(['1001', '1002', '1003']);
  });

  it('stops at once on 429 and never records a fingerprint for a failed vehicle; no retry', async () => {
    const w = world({ vehicles: [veh(1), veh(2)], failDownload: (v, id) => (v === 'V1' && id === 'V1-b' ? 'IANCAR_ONE_API_HTTP_429' : null) });
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits());
    expect(r.stop).toBe('RATE_LIMITED');
    expect(r.counts.FAILED).toBe(1);
    expect(w.calls.fingerprint).toBe(0);
    expect(w.log.filter(l => l === 'download:V1-b')).toHaveLength(1);     // 같은 사진을 다시 요청하지 않는다
    expect(w.log.some(l => l.startsWith('detail:V2'))).toBe(false);       // 다음 차량으로 넘어가지 않는다
  });

  it('stops after the configured consecutive failures and records only safe codes', async () => {
    const w = world({ vehicles: [1, 2, 3, 4, 5].map(n => veh(n)), failDetail: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`V${n}`, 'IANCAR_PHOTO_DETAIL_STALE'])) });
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits());
    expect(r.stop).toBe('CONSECUTIVE_FAILURES');
    expect(r.rows).toHaveLength(3);
    expect(r.rows.every(x => x.code === 'IANCAR_PHOTO_DETAIL_STALE')).toBe(true);
  });

  it('paces supplier calls by the interval and never sleeps before the first call', async () => {
    const w = world({ vehicles: [veh(1)], photos: { V1: ['a', 'b'] } });
    await runIancarPhotoCopy(w.deps, 'FULL', limits({ intervalMs: 1500 }));
    expect(w.log[0]).toBe('detail:V1');
    expect(w.log.filter(l => l.startsWith('sleep:')).every(l => Number(l.split(':')[1]) <= 1500)).toBe(true);
    expect(w.log.filter(l => l.startsWith('sleep:')).length).toBe(2);   // detail→photo1, photo1→photo2
  });

  it('respects the per-run photo limit between vehicles (never splits a vehicle, first vehicle always allowed)', async () => {
    const w = world({ vehicles: [veh(1), veh(2), veh(3)] });   // 차량당 2장
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits({ maxPhotos: 3 }));
    expect(r.stop).toBe('MAX_PHOTOS');
    expect(r.counts.COPIED).toBe(1);                              // 2장 + 2장 > 3 이므로 둘째 차량 전에 멈춤
    const tiny = await runIancarPhotoCopy(world({ vehicles: [veh(1)] }).deps, 'FULL', limits({ maxPhotos: 1 }));
    expect(tiny.counts.COPIED).toBe(1);
  });

  it('caps vehicles per run and the per-vehicle photos (≤10), leaving the rest for the next day', async () => {
    const many = { V1: Array.from({ length: 14 }, (_, i) => `p${i}`) };
    const w = world({ vehicles: [veh(1), veh(2), veh(3)], photos: many });
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits({ maxVehicles: 1 }));
    expect(r.stop).toBe('MAX_VEHICLES');
    expect(r.photosWritten).toBe(10);
  });

  it('reports only last-4 plate digits and never ids in the result rows', async () => {
    const w = world({ vehicles: [veh(1)] });
    const r = await runIancarPhotoCopy(w.deps, 'FULL', limits());
    const text = JSON.stringify({ rows: r.rows, counts: r.counts });
    expect(text).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
    expect(text).not.toContain('V1-a');
  });
});
