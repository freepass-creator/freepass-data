/** 승인 사진(photo_original_refs) 바이트 읽기 — 우리 소유 드라이브 파일을 Data 서비스가 대신 서빙한다(대표 2026-10-14 «프리패스 거, KS오토플랜 거랑 같은 거»).
 * 안전: 호스트 고정(SSRF 없음), 파일 ID 형식 검사, 크기·형식·시그니처 검증, 등록된 sha256 과 바이트가 다르면 거절(사진이 바뀌면 탐지).
 * 전송 방식: tokenProvider 가 있으면 Drive API(files.get alt=media, 서비스 계정 보기 공유), 없으면 «링크가 있는 모든 사용자» 공개 다운로드. 기본 꺼짐은 호출 쪽 환경변수가 정한다. */
import { createHash } from 'node:crypto';
import { VEHICLE_PHOTO_MAX_BYTES, validateVehiclePhotoMedia } from '../domain/consumer-output-contract.js';
const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/;
export function createDriveApprovedPhotoReader(options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = Math.max(1000, Math.min(30_000, options.timeoutMs ?? 15_000));
    return async (ref) => {
        if (!FILE_ID.test(ref.driveFileId))
            throw new Error('VEHICLE_PHOTO_NOT_FOUND');
        const useApi = !!options.tokenProvider;
        const url = useApi
            ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(ref.driveFileId)}?alt=media&supportsAllDrives=true`
            : `https://drive.usercontent.google.com/download?id=${encodeURIComponent(ref.driveFileId)}&export=download`;
        const headers = { accept: 'image/*' };
        if (useApi)
            headers.authorization = `Bearer ${await options.tokenProvider()}`;
        const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
        if (res.status === 404 || res.status === 403)
            throw new Error('VEHICLE_PHOTO_NOT_FOUND');
        if (!res.ok)
            throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
        const declared = Number(res.headers.get('content-length') ?? NaN);
        if (Number.isFinite(declared) && declared > VEHICLE_PHOTO_MAX_BYTES)
            throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
        const bytes = Buffer.from(await res.arrayBuffer());
        const bad = validateVehiclePhotoMedia(ref.mediaType, bytes.length, bytes);
        if (bad)
            throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
        if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
            throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
        return { bytes, contentType: ref.mediaType };
    };
}
/** Cloud Run 서비스 계정이 «자기 자신»을 가장해 drive.readonly 토큰을 받는다(IAM Credentials generateAccessToken).
 * 필요: 서비스 계정에 자기 자신에 대한 roles/iam.serviceAccountTokenCreator, 드라이브 폴더 «보기» 공유. 토큰은 만료 1분 전까지 캐시한다. */
export function createCloudRunDriveTokenProvider(fetchImpl = fetch, now = Date.now) {
    let cached = null;
    const meta = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/';
    const metaHeaders = { 'Metadata-Flavor': 'Google' };
    return async () => {
        if (cached && now() < cached.expiresAt - 60_000)
            return cached.token;
        const emailRes = await fetchImpl(meta + 'email', { headers: metaHeaders, signal: AbortSignal.timeout(5000) });
        const email = (await emailRes.text()).trim();
        if (!emailRes.ok || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(email))
            throw new Error('VEHICLE_PHOTO_READER_UNAVAILABLE');
        const baseRes = await fetchImpl(meta + 'token', { headers: metaHeaders, signal: AbortSignal.timeout(5000) });
        const base = (await baseRes.json());
        if (!baseRes.ok || !base.access_token)
            throw new Error('VEHICLE_PHOTO_READER_UNAVAILABLE');
        const res = await fetchImpl(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateAccessToken`, {
            method: 'POST', headers: { authorization: `Bearer ${base.access_token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/drive.readonly'], lifetime: '900s' }), signal: AbortSignal.timeout(10_000)
        });
        const body = (await res.json());
        if (!res.ok || !body.accessToken)
            throw new Error('VEHICLE_PHOTO_READER_UNAVAILABLE');
        const exp = Date.parse(body.expireTime ?? '');
        cached = { token: body.accessToken, expiresAt: Number.isFinite(exp) ? exp : now() + 10 * 60_000 };
        return cached.token;
    };
}
/** FREEPASS_DATA_APPROVED_PHOTO_READER: 비어 있거나 «off» = 꺼짐(주입 없음), «drive-public» = 공개 링크 다운로드, «drive-api» = 서비스 계정 Drive API.
 * 모르는 값은 꺼짐(실패 폐쇄). */
export function approvedPhotoReaderFromEnv(env = process.env) {
    const mode = (env.FREEPASS_DATA_APPROVED_PHOTO_READER ?? '').trim();
    if (mode === 'drive-public')
        return createDriveApprovedPhotoReader();
    if (mode === 'drive-api')
        return createDriveApprovedPhotoReader({ tokenProvider: createCloudRunDriveTokenProvider() });
    return undefined;
}
