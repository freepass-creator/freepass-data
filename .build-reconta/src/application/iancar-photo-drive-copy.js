/** 이안카 사진 → 우리 드라이브 압축 사본 복사(오케스트레이션, 순수: 모든 입출력은 주입된 포트). 설계: docs/IANCAR-PHOTO-DRIVE-DESIGN-20261014.md.
 * 규칙: 직렬·간격·상한, 지문이 같으면 건너뜀, 압축본만 저장, 실패 재시도 0(그 차량은 변경 없이 다음 날), 429 는 즉시 종료, 삭제 없음.
 * 키·사진 URL·원문은 이 모듈에 들어오지 않는다(포트가 바이트와 코드만 준다). 결과의 번호는 끝 4자리 표시용 필드(plate4)와 비공개 CSV 용 전체 번호(plate)를 분리한다. */
import { createHash } from 'node:crypto';
export const DEFAULT_PHOTO_COPY_LIMITS = {
    maxVehicles: 40, maxPhotos: 400, maxPerVehicle: 10, timeBudgetMs: 40 * 60_000, intervalMs: 1500, maxConsecutiveFailures: 3, maxConsecutiveStale: 10, pilotOnly: 10,
};
const tail4 = (plate) => plate.replace(/\D/g, '').slice(-4) || '----';
const fileName = (index) => `${String(index + 1).padStart(2, '0')}.jpg`;
const srcKeyOf = (photoId) => createHash('sha256').update(`iancar-one-photo/1\n${photoId}`).digest('hex').slice(0, 16);
/** 앨범 지문(완료 표식): 공급사 사진 id 는 회차마다 회전(24시간 참조)하므로 id 목록으로 계산하지 않는다 — 사진 수만 담는다.
 * «같은 폴더가 끝까지 복사됐고 파일 무결성(copySha256 = 드라이브 체크섬)이 맞고 장수가 같다» 가 SAME 판정이고, 지문은 완료 시각 표식으로 쓴다. */
export const albumFingerprint = (ids) => createHash('sha256').update(JSON.stringify(['iancar-photo-set/2', ids.length])).digest('hex').slice(0, 16);
const safeCode = (e) => {
    const raw = e && typeof e === 'object' ? (e.code ?? e.message) : '';
    return typeof raw === 'string' && /^[A-Z0-9_]{3,64}$/.test(raw) ? raw : 'UNKNOWN_ERROR';
};
/** 원천(ONE) 429 와 드라이브 429/쿼터는 둘 다 «즉시 종료». */
const isRateLimited = (code) => code === 'IANCAR_ONE_API_HTTP_429' || code === 'DRIVE_RATE_LIMITED';
/** 이 잡이 올린 파일이 «완료»인지: 원본 표식 + 올릴 때의 로컬 sha256 표식이 드라이브가 계산한 체크섬과 같아야 한다(이전 체크섬 불일치·부분 파일은 완료로 인정하지 않는다). */
const isComplete = (f, photoId) => f.srcKey === srcKeyOf(photoId) && !!f.sha256 && f.copySha256 === f.sha256;
/** 차량 표식: 번호 해시(번호 자체는 파일 속성에 남기지 않는다). 올린 파일에 붙이고 SAME 판정에서 검증한다. */
export const plateKeyOf = (plate) => createHash('sha256').update(`iancar-photo-plate/1\n${plate.normalize('NFKC').replace(/\s+/g, '')}`).digest('hex').slice(0, 16);
/** 파일 무결성: 올릴 때 남긴 로컬 sha256 표식이 드라이브 체크섬과 같다(id·원본 표식과 무관 — id 회전에 영향받지 않음). */
const intact = (f) => !!f.sha256 && f.copySha256 === f.sha256;
/** 다른 차량의 파일이 아니다: 차량 표식이 없으면(옛 파일럿 파일) 폴더가 «이름 첫 토큰 = 번호»로 이미 고른 것이라 허용, 있으면 이 차량의 해시와 같아야 한다. */
const ownedBy = (f, plateKey) => f.plateKey === undefined || f.plateKey === null || f.plateKey === plateKey;
const emptyCounts = () => ({ COPIED: 0, PLANNED_COPY: 0, SKIPPED_SAME: 0, SKIPPED_EXISTING: 0, SKIPPED_STALE: 0, NO_TARGET: 0, NEEDS_REPLACEMENT: 0, AMBIGUOUS_FOLDER: 0, FAILED: 0, NOT_ATTEMPTED: 0 });
const isStale = (code) => code === 'IANCAR_PHOTO_DETAIL_STALE';
/** 한 회차 실행. DRY_RUN = 상세·드라이브 읽기만(다운로드·업로드·폴더 생성·지문 기록 0). */
export async function runIancarPhotoCopy(deps, mode, limits = DEFAULT_PHOTO_COPY_LIMITS) {
    const startedAt = deps.now();
    const result = { mode, stop: 'COMPLETED', vehicles: 0, rows: [], counts: emptyCounts(), photosWritten: 0, bytesWritten: 0, completed: [] };
    const write = mode !== 'DRY_RUN';
    const vehicles = (await deps.source.listVehicles()).slice().sort((a, b) => a.plate.localeCompare(b.plate, 'ko') || a.vehicleId.localeCompare(b.vehicleId));
    result.vehicles = vehicles.length;
    let lastCall = 0, consecutiveFailures = 0, consecutiveStale = 0, attempts = 0, withPhotos = 0;
    const pace = async () => {
        if (lastCall) {
            const wait = lastCall + limits.intervalMs - deps.now();
            if (wait > 0)
                await deps.sleep(wait);
        }
        lastCall = deps.now();
    };
    const finish = (stop) => { result.stop = stop; return result; };
    // 연속 실패 카운터는 «차량 한 대를 끝까지 처리했는가»로만 센다: 상세 조회가 성공해도 다운로드·드라이브 쓰기 실패는 누적된다(Codex 지적 ①).
    const record = (plate, status, photos = 0, written = 0, code) => {
        result.rows.push({ plate4: tail4(plate), status, photos, written, ...(code ? { code } : {}) });
        result.counts[status]++;
        // stale 건너뜀은 실패도 성공도 아니다: 실패 카운터는 그대로 두고 stale 연속만 센다(정상 차량이 나오면 둘 다 0).
        if (status === 'SKIPPED_STALE') {
            consecutiveStale++;
            return;
        }
        consecutiveStale = 0;
        consecutiveFailures = status === 'FAILED' ? consecutiveFailures + 1 : 0;
    };
    for (const vehicle of vehicles) {
        if (deps.now() - startedAt >= limits.timeBudgetMs)
            return finish('TIME_BUDGET');
        if (mode === 'PILOT' && withPhotos >= limits.pilotOnly)
            return finish('PILOT_SET_DONE');
        if (write && attempts >= limits.maxVehicles)
            return finish('MAX_VEHICLES');
        let ids;
        let detailsVersion = null;
        try {
            await pace();
            const got = await deps.source.photoIds(vehicle);
            ids = Array.isArray(got) ? got : got.ids;
            detailsVersion = Array.isArray(got) ? null : (got.version ?? null);
        }
        catch (error) {
            const code = safeCode(error);
            if (isStale(code)) {
                // 상세가 stale 로 표시된 차량: 창이 지나면 자연 해소되므로 이 차량만 건너뛰고 계속한다(실패로 세지 않음). 연속 stale 이 많으면 상류 정지.
                record(vehicle.plate, 'SKIPPED_STALE', 0, 0, code);
                if (consecutiveStale >= limits.maxConsecutiveStale)
                    return finish('SOURCE_STALE');
                continue;
            }
            record(vehicle.plate, 'FAILED', 0, 0, code);
            if (isRateLimited(code))
                return finish('RATE_LIMITED');
            if (consecutiveFailures >= limits.maxConsecutiveFailures)
                return finish('CONSECUTIVE_FAILURES');
            continue;
        }
        if (!ids.length) {
            record(vehicle.plate, 'NO_TARGET');
            continue;
        } // 원천에 사진이 없는 차: «대상 없음», 정상
        withPhotos++;
        const selected = ids.slice(0, Math.max(1, limits.maxPerVehicle));
        const fingerprint = albumFingerprint(selected);
        const plateKey = plateKeyOf(vehicle.plate);
        try {
            // 기존 구조 재사용(번호 기준 매칭): «<번호>» 또는 «<번호> <차종>» 폴더. 사진이 든 폴더가 둘 이상이면 사람 정리 전까지 쓰기 0.
            const candidates = await deps.drive.findVehicleFolders(vehicle.plate);
            const withImages = candidates.filter(c => c.files.some(f => f.image));
            if (withImages.length > 1) {
                record(vehicle.plate, 'AMBIGUOUS_FOLDER', selected.length, 0, 'DRIVE_FOLDER_DUPLICATE');
                continue;
            }
            let folder = withImages[0]
                ?? [...candidates].sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name, 'ko'))[0] ?? null;
            // 이 잡이 올리지 않은 사진이 이미 있으면(기존 사진 정본) 건드리지 않는다. 이 잡의 부분 복사(srcKey 있음)는 이어서 채운다.
            if (folder && folder.files.some(f => f.image && f.srcKey === null)) {
                record(vehicle.plate, 'SKIPPED_EXISTING', selected.length);
                continue;
            }
            if (!folder && write)
                folder = await deps.drive.createVehicleFolder(vehicle.plate, vehicle.label);
            const byName = new Map((folder?.files ?? []).map(f => [f.name, f]));
            const folderFiles = folder?.files ?? [];
            const missing = [];
            let conflict = false;
            if (folder?.fingerprint) {
                // 끝까지 복사가 끝난 폴더(완료 표식 있음): 공급사 사진 id 는 회차마다 회전하므로 id·원본 표식은 비교하지 않는다.
                // 같음 = 01..N 이름이 모두 있고(장수 = 이번 원천 장수) 모든 파일의 무결성(copySha256 = 드라이브 체크섬)이 맞는 것. 장수가 다르거나 무결성이 깨졌으면 교체 보류.
                // 또한 모든 파일이 «이 차량의 것»이어야 한다(차량 표식 검증 — 다른 차량의 정상 파일이 같은 이름·장수로 들어와도 SAME 이 아니다).
                const sameShape = folderFiles.length === selected.length
                    && selected.every((_, index) => { const f = byName.get(fileName(index)); return !!f && intact(f) && ownedBy(f, plateKey); });
                if (!sameShape) {
                    record(vehicle.plate, 'NEEDS_REPLACEMENT', selected.length);
                    continue;
                }
                // 이미 복사된 차량도 등록 대상 목록에 넣는다(앞 회차의 등록이 실패·미실행이었을 수 있다 — 등록 도구는 refs 가 있으면 건너뛴다).
                result.completed.push({ plate: vehicle.plate, folderId: folder.folderId, files: selected.length });
                // 상세 갱신 시각이 완료 때와 다르면 «바뀐 차량» 신호로만 알린다(교체·쓰기 아님: 가격·옵션 갱신으로도 바뀌므로 보류 사유로 쓰지 않는다).
                const versionChanged = !!detailsVersion && !!folder.detailsVersion && folder.detailsVersion !== detailsVersion;
                record(vehicle.plate, 'SKIPPED_SAME', selected.length, 0, versionChanged ? 'DETAILS_UPDATED_AT_CHANGED' : undefined);
                continue;
            }
            // 아직 끝나지 않은 폴더(비어 있음·부분 복사): 이어서 채운다. 이미 있는 파일은 «같은 원본 표식 + 무결성»일 때만 인정하고 아니면 교체 보류.
            selected.forEach((id, index) => {
                const existing = byName.get(fileName(index));
                if (!existing)
                    missing.push(index);
                else if (!isComplete(existing, id) || !ownedBy(existing, plateKey))
                    conflict = true; // 같은 이름인데 원본이 다르거나 완료 표식이 없거나 다른 차량 표식인 파일 → 교체 보류(삭제·덮어쓰기 없음)
            });
            if (conflict || folderFiles.length > selected.length) {
                record(vehicle.plate, 'NEEDS_REPLACEMENT', selected.length);
                continue; // 교체는 별도 승인 경로: 쓰기·삭제 없음
            }
            if (!write) {
                record(vehicle.plate, 'PLANNED_COPY', selected.length, 0);
                continue;
            }
            // 한 차량을 쪼개지 않는다: 이번 회차 사진 상한을 넘기면(첫 차량 제외) 여기서 종료.
            if (result.photosWritten > 0 && result.photosWritten + missing.length > limits.maxPhotos)
                return finish('MAX_PHOTOS');
            attempts++;
            let written = 0;
            for (const index of missing) {
                const id = selected[index];
                await pace();
                const original = await deps.source.download(vehicle, id);
                const compressed = await deps.compress(original);
                await deps.drive.upload(folder.folderId, fileName(index), compressed.bytes, srcKeyOf(id), plateKey);
                written++;
                result.photosWritten++;
                result.bytesWritten += compressed.bytes.length;
            }
            await deps.drive.setFingerprint(folder.folderId, fingerprint, new Date(deps.now()).toISOString(), detailsVersion);
            result.completed.push({ plate: vehicle.plate, folderId: folder.folderId, files: selected.length });
            record(vehicle.plate, 'COPIED', selected.length, written);
        }
        catch (error) {
            const code = safeCode(error);
            record(vehicle.plate, 'FAILED', selected.length, 0, code); // 부분 업로드는 지문이 없어 다음 회차가 이어서 채운다(완료 표식이 있는 같은 이름·같은 원본만 건너뜀)
            if (isRateLimited(code))
                return finish('RATE_LIMITED');
            if (consecutiveFailures >= limits.maxConsecutiveFailures)
                return finish('CONSECUTIVE_FAILURES');
        }
    }
    return finish('COMPLETED');
}
/** 등록 도구 입력 CSV(헤더 «번호,폴더»). 전체 번호가 들어가므로 비공개 디렉터리에만 쓴다. */
export const photoCopyCsv = (result) => ['번호,폴더', ...result.completed.map(c => `${c.plate},${c.folderId}`)].join('\n') + '\n';
