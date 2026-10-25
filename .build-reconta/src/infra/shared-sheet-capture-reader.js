import { execFileSync } from 'node:child_process';
import { GoogleAuth } from 'google-auth-library';
import { resolveGwsBin } from './gws-bin.js';
/** 시트 읽기 전송의 «단일» 판정(원천 엔진 런타임과 이 읽기 모듈이 함께 쓴다): SHEETS_TRANSPORT=gws 일 때만 gws CLI, 그 밖(adc·미설정)은 ADC 토큰.
 * 전에는 런타임은 «adc 가 아니면 gws», 이 모듈은 «gws 일 때만 gws» 라 미설정이면 한 F05 읽기 안에서 두 전송이 섞였다. 기본값을 ADC 로 둔 이유:
 * 이 모듈을 쓰는 Actions 작업(shared-sheet-daily)은 SHEETS_TRANSPORT 없이 ADC 로 돈다. 무인 원천 회차는 사전점검이 명시 설정을 요구한다. */
export const resolveSheetsTransport = (env = process.env) => env.SHEETS_TRANSPORT?.trim() === 'gws' ? 'gws' : 'adc';
/** Sheets read-only token. An explicit sheets credential file (ERP4 manual step) wins over ADC. No key is created here. */
async function sheetsAccessToken() {
    try {
        const keyFile = process.env.GOOGLE_SHEETS_APPLICATION_CREDENTIALS;
        // Same delegation as data-owned-refresh: the sheet owner (GOOGLE_SHEETS_SUBJECT) is impersonated read-only.
        const subject = process.env.GOOGLE_SHEETS_SUBJECT?.trim();
        // Domain-wide delegation only grants the scope already authorized for that client (the existing refresh uses
        // «spreadsheets»); without delegation the narrower read-only scope is requested. This reader only issues GETs.
        const delegated = Boolean(keyFile && subject);
        const auth = new GoogleAuth({ ...(keyFile ? { keyFile } : {}), ...(keyFile && subject ? { clientOptions: { subject } } : {}),
            scopes: [delegated ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly'] });
        const token = await auth.getAccessToken();
        if (!token)
            throw new Error('missing token');
        return token;
    }
    catch {
        throw new Error('SHEETS_AUTH_UNAVAILABLE');
    }
}
const sheetsUrl = (spreadsheetId, suffix = '') => {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId))
        throw new Error('SHARED_SHEET_ID_INVALID');
    return new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${suffix}`);
};
/** 운영 PC 전용 읽기 전송: SHEETS_TRANSPORT=gws 이면 이미 인증된 gws CLI(회사 계정 위임)로 읽는다. 비밀은 건드리지 않는다. */
function sheetsViaGws(url, env) {
    const m = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(\/values:batchGet)?$/);
    if (!m)
        throw new Error('SHEETS_URL_UNSUPPORTED');
    const params = { spreadsheetId: decodeURIComponent(m[1]) };
    const ranges = [];
    for (const [k, v] of url.searchParams) {
        if (k === 'ranges')
            ranges.push(v);
        else
            params[k] = v === 'true' ? true : v;
    }
    if (ranges.length)
        params.ranges = ranges;
    const args = m[2] ? ['sheets', 'spreadsheets', 'values', 'batchGet'] : ['sheets', 'spreadsheets', 'get'];
    const bin = resolveGwsBin(env);
    if (!bin)
        throw new Error('SHEETS_TRANSPORT_UNAVAILABLE');
    let out;
    try {
        out = execFileSync(bin, [...args, '--params', JSON.stringify(params)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch (e) {
        // gws 실패는 «Command failed» 한 줄뿐이라 원인을 알 수 없었다(2026-10-13 RP017 READ_FAILED). 표준 오류에서 상태만 뽑아 코드로 남기고 본문은 남기지 않는다.
        const err = e;
        const text = String(err.stderr ?? '');
        // gws 는 API 오류 본문을 stdout JSON 으로 낸다(error.code). 코드 숫자만 남기고 메시지·값은 남기지 않는다.
        const apiCode = /"code"\s*:\s*(\d{3})/.exec(String(err.stdout ?? ''))?.[1];
        if (apiCode)
            throw new Error(`SHARED_SHEET_API_${apiCode}`);
        if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM')
            throw new Error('SHARED_SHEET_GWS_TIMEOUT');
        const http = /\b(429|401|403|5\d\d)\b/.exec(text)?.[1];
        if (http)
            throw new Error(`SHARED_SHEET_HTTP_${http}`);
        throw new Error(`SHARED_SHEET_GWS_EXIT_${typeof err.status === 'number' ? err.status : 'UNKNOWN'}`);
    }
    try {
        return JSON.parse(out.slice(out.indexOf('{')));
    }
    catch {
        throw new Error('SHARED_SHEET_RESPONSE_INVALID');
    }
}
async function sheetsGet(url, ports) {
    const env = ports.env ?? process.env;
    if (resolveSheetsTransport(env) === 'gws' && !ports.fetcher && !ports.accessToken)
        return sheetsViaGws(url, env);
    const token = await (ports.accessToken ?? sheetsAccessToken)();
    if (!token || /\s/.test(token))
        throw new Error('SHEETS_AUTH_UNAVAILABLE');
    let response;
    try {
        response = await (ports.fetcher ?? fetch)(url, { method: 'GET', redirect: 'error',
            headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    }
    catch {
        throw new Error('SHARED_SHEET_READ_UNKNOWN');
    }
    if (!response.ok)
        throw new Error(`SHARED_SHEET_HTTP_${response.status}`);
    try {
        return await response.json();
    }
    catch {
        throw new Error('SHARED_SHEET_RESPONSE_INVALID');
    }
}
/** 원천 엔진용 읽기 한 번(spreadsheets.get 또는 values:batchGet). SHEETS_TRANSPORT=gws 면 gws, 아니면 ADC 읽기 전용 토큰
 * (온라인 실행기: WIF 서비스 계정 + 시트 «보기» 공유). sheets.googleapis.com 의 GET 만 허용한다. */
export async function readSheetsUrl(url, ports = {}) {
    if (url.protocol !== 'https:' || url.hostname !== 'sheets.googleapis.com' || !/^\/v4\/spreadsheets\/[^/:]+(\/values:batchGet)?$/.test(url.pathname)) {
        throw new Error('SHEETS_URL_UNSUPPORTED');
    }
    return sheetsGet(url, ports);
}
/** spreadsheets.get limited to the given metadata fields (grid sizes), no cell data. */
export async function readSheetsMetadata(spreadsheetId, fields, ports = {}) {
    const url = sheetsUrl(spreadsheetId);
    url.searchParams.set('fields', fields);
    return sheetsGet(url, ports);
}
/** spreadsheets.get over the given ranges with a grid-data field mask (e.g. one column's display text + links). GET only, no values API. */
export async function readSheetsGridFields(spreadsheetId, ranges, fields, ports = {}) {
    if (!ranges.length || !fields.includes('rowData'))
        throw new Error('SHEETS_GRID_REQUEST_INVALID');
    const url = sheetsUrl(spreadsheetId);
    for (const r of ranges)
        url.searchParams.append('ranges', r);
    url.searchParams.set('includeGridData', 'true');
    url.searchParams.set('fields', fields);
    return sheetsGet(url, ports);
}
/** One bearer-authorized values.batchGet over the given ranges. Returns the raw response; conversion lives in adapters.
 * render 'SERIAL' reads the real cell values (dates as serial numbers) — used only to keep the year of date cells whose
 * display format hides it (입고일자 mm-dd). */
export async function readSheetsBatchGet(spreadsheetId, ranges, ports = {}, render = 'FORMATTED') {
    const url = sheetsUrl(spreadsheetId, '/values:batchGet');
    for (const r of ranges)
        url.searchParams.append('ranges', r);
    url.searchParams.set('valueRenderOption', render === 'SERIAL' ? 'UNFORMATTED_VALUE' : render === 'FORMULA' ? 'FORMULA' : 'FORMATTED_VALUE');
    if (render === 'SERIAL')
        url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');
    url.searchParams.set('majorDimension', 'ROWS');
    return sheetsGet(url, ports);
}
