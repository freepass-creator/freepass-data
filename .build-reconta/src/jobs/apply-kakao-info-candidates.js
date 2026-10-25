import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyKakaoInfoCandidates } from '../application/apply-kakao-info-candidates.js';
import { stableDigest } from '../shared/stable-digest.js';
import { createKakaoInfoSourceDataAccessRuntime } from './data-access-runtime.js';
const USAGE = 'USAGE: node dist/src/jobs/apply-kakao-info-candidates.js <candidates.json> [--apply --digest <inputDigest>]';
/** 입력 파일은 후보 배열이거나 {candidates:[…]}. 기본은 시험 실행(쓰기 없음). 쓰기는 --apply + 환경변수 2개 + digest 일치. */
export async function runApplyKakaoInfoCandidates(args, env) {
    const files = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--digest');
    const apply = args.includes('--apply');
    const digestIndex = args.indexOf('--digest');
    const digestArg = digestIndex >= 0 ? args[digestIndex + 1] : undefined;
    if (!files.length || (apply && !digestArg))
        throw new Error(USAGE);
    // 파일은 후보 배열이거나 {supplierCode?, candidates:[…]} — 파일 최상위 supplierCode 는 후보에 없을 때만 채운다.
    const inputs = [];
    for (const file of files) {
        const parsed = JSON.parse(await readFile(resolve(file), 'utf8'));
        const wrapper = Array.isArray(parsed) ? { candidates: parsed } : parsed;
        if (!Array.isArray(wrapper.candidates))
            throw new Error('KAKAO_INFO_INPUT_EMPTY');
        for (const candidate of wrapper.candidates) {
            inputs.push((candidate.supplierCode === undefined && wrapper.supplierCode !== undefined
                ? { supplierCode: wrapper.supplierCode, ...candidate } : candidate));
        }
    }
    if (!inputs.length)
        throw new Error('KAKAO_INFO_INPUT_EMPTY');
    const inputDigest = stableDigest(inputs);
    const runtime = await createKakaoInfoSourceDataAccessRuntime();
    const now = new Date().toISOString();
    const options = { expectedDigest: apply ? digestArg : inputDigest, now, writeApproved: apply, env };
    const result = apply
        ? await runtime.write(inputDigest, () => applyKakaoInfoCandidates(runtime.sourceStore, inputs, options))
        : await runtime.dryRun(inputDigest, () => applyKakaoInfoCandidates(runtime.sourceStore, inputs, options));
    return {
        result,
        summary: {
            mode: result.status,
            inputDigest,
            counts: result.counts,
            byVehicleResolution: result.receipts.reduce((acc, item) => ({ ...acc, [item.vehicleResolution]: (acc[item.vehicleResolution] ?? 0) + 1 }), {}),
            byResult: result.receipts.reduce((acc, item) => ({ ...acc, [item.result]: (acc[item.result] ?? 0) + 1 }), {}),
        },
    };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runApplyKakaoInfoCandidates(process.argv.slice(2), process.env)
        .then(({ summary }) => console.log(JSON.stringify(summary, null, 2)))
        .catch((error) => {
        console.error(error instanceof Error && /^[A-Z0-9_ :<>\[\]\-.\/]+$/i.test(error.message) ? error.message : 'KAKAO_INFO_APPLY_FAILED');
        process.exitCode = 1;
    });
}
