import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyKakaoInfoCandidates, type KakaoInfoApplyResult } from '../application/apply-kakao-info-candidates.js';
import type { KakaoInfoCandidateInput } from '../domain/kakao-info-candidate.js';
import { stableDigest } from '../shared/stable-digest.js';
import { createKakaoInfoSourceDataAccessRuntime } from './data-access-runtime.js';

const USAGE = 'USAGE: node dist/src/jobs/apply-kakao-info-candidates.js <candidates.json> [--apply --digest <inputDigest>]';

/** 입력 파일은 후보 배열이거나 {candidates:[…]}. 기본은 시험 실행(쓰기 없음). 쓰기는 --apply + 환경변수 2개 + digest 일치. */
export async function runApplyKakaoInfoCandidates(args: string[], env: NodeJS.ProcessEnv): Promise<{ summary: unknown; result: KakaoInfoApplyResult }> {
  const files = args.filter(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--digest');
  const apply = args.includes('--apply');
  const digestIndex = args.indexOf('--digest');
  const digestArg = digestIndex >= 0 ? args[digestIndex + 1] : undefined;
  if (files.length !== 1 || (apply && !digestArg)) throw new Error(USAGE);
  const parsed = JSON.parse(await readFile(resolve(files[0]!), 'utf8')) as unknown;
  const inputs = (Array.isArray(parsed) ? parsed : (parsed as { candidates?: unknown }).candidates) as KakaoInfoCandidateInput[] | undefined;
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('KAKAO_INFO_INPUT_EMPTY');
  const inputDigest = stableDigest(inputs);
  const runtime = await createKakaoInfoSourceDataAccessRuntime();
  const now = new Date().toISOString();
  const options = { expectedDigest: apply ? digestArg! : inputDigest, now, writeApproved: apply, env };
  const result = apply
    ? await runtime.write(inputDigest, () => applyKakaoInfoCandidates(runtime.sourceStore, inputs, options))
    : await runtime.dryRun(inputDigest, () => applyKakaoInfoCandidates(runtime.sourceStore, inputs, options));
  return {
    result,
    summary: {
      mode: result.status,
      inputDigest,
      counts: result.counts,
      byVehicleResolution: result.receipts.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.vehicleResolution]: (acc[item.vehicleResolution] ?? 0) + 1 }), {}),
      byResult: result.receipts.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.result]: (acc[item.result] ?? 0) + 1 }), {}),
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
