/** 이안카 사진 «일 1회» 연동(대표 2026-10-15 «이안카 사진은 별도로, 용량 줄여 우리 구글 드라이브로 가져오고 연동»):
 *   복사(원천 → 압축 → 공유 드라이브 번호 폴더) → 등록(photo_original_refs, 빈 칸만) 을 한 번에 돌린다. 이안카 원천에서 사진 말고는 아무것도 쓰지 않는다.
 *   npm run copy:iancar-photos:daily
 * 재고·대여료·보증금·정책 텍스트는 원천 엔진(이 잡이 아님)이 가져온다 — 이 잡은 사진 전용 별도 예약이다.
 * 환경: copy 잡과 같다(EANCAR_ONE_API_KEY, IANCAR_PHOTO_DRIVE_ROOT_ID, IANCAR_PHOTO_COPY_MODE=DRY_RUN|PILOT|FULL, IANCAR_PHOTO_COPY_APPROVED, FULL 은 IANCAR_PHOTO_FULL_APPROVED).
 *   등록은 IANCAR_PHOTO_REGISTER_APPLY=true 일 때만 적용하고, 아니면 등록 도구 DRY_RUN 결과만 낸다.
 * 종료 코드: 0 정상 · 1 복사 실패/중단 또는 등록 실패 · 2 설정 오류 · 3 미완(stale 건너뜀 남음). 번호는 끝 4자리만 출력한다. */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { iancarPhotoCopyCli } from './copy-iancar-photos-to-drive.js';
import type { PhotoCopyResult } from '../application/iancar-photo-drive-copy.js';

export type DailyRunner = (command: string, args: string[], env: NodeJS.ProcessEnv) => string;
export type DailyDeps = {
  copy: (argv: string[], env: NodeJS.ProcessEnv) => Promise<PhotoCopyResult>;
  run: DailyRunner;
  log: (line: string) => void;
};
export type DailySummary = { mode: string; copyStop: string; counts: PhotoCopyResult['counts']; photosWritten: number; completed: number;
  register: { applied: boolean; summary: string[] } | null; exit: 0 | 1 | 3 };

const defaultDeps: DailyDeps = {
  copy: (argv, env) => iancarPhotoCopyCli(argv, env, () => undefined),
  run: (command, args, env) => execFileSync(command, args, { env, encoding: 'utf8', maxBuffer: 16 << 20, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  log: line => console.log(line),
};

/** 등록 도구 출력에서 번호 끝 4자리와 결과만 남긴다(전체 번호는 도구가 이미 끝 4자리만 출력). */
const safeLines = (text: string) => text.split(/\r?\n/).map(l => l.trim().replace(/\d{2,3}[가-힣]\s?(\d{4})/g, '$1')).filter(Boolean)
  .filter(l => /^\d{4}\s/.test(l) || /MATCH|MISMATCH|계획|이미 사진|문서 없음|쓰기 실패/.test(l)).slice(0, 200);

export async function runIancarPhotoDaily(env: NodeJS.ProcessEnv = process.env, deps: DailyDeps = defaultDeps): Promise<DailySummary> {
  const mode = env.IANCAR_PHOTO_COPY_MODE ?? 'DRY_RUN';
  const csv = resolve(join(env.SOURCE_CYCLE_PRIVATE_DIR || tmpdir(), 'iancar-photo-register.csv'));
  const result = await deps.copy(['--mode', mode, '--out', csv], env);
  const base = { mode, copyStop: result.stop, counts: result.counts, photosWritten: result.photosWritten, completed: result.completed.length };
  const copyFailed = ['RATE_LIMITED', 'CONSECUTIVE_FAILURES', 'SOURCE_STALE'].includes(result.stop) || result.counts.FAILED > 0;
  // DRY_RUN 은 아무것도 복사하지 않으므로 등록하지 않는다. 완료된 차량이 없으면 등록할 것도 없다.
  let register: DailySummary['register'] = null;
  let registerFailed = false;
  if (mode !== 'DRY_RUN' && result.completed.length) {
    const apply = env.IANCAR_PHOTO_REGISTER_APPLY === 'true';
    try {
      const out = deps.run(process.execPath, [resolve('scripts/ops/register-approved-photos.mjs'), csv, '--method', 'IANCAR_COMPRESSED_COPY', '--max', '10',
        ...(apply ? ['--apply'] : [])], env);
      const lines = safeLines(out);
      registerFailed = lines.some(l => /MISMATCH|쓰기 실패/.test(l));
      register = { applied: apply, summary: lines };
    } catch { registerFailed = true; register = { applied: apply, summary: ['REGISTER_TOOL_FAILED'] }; }
  }
  const exit: 0 | 1 | 3 = copyFailed || registerFailed ? 1 : result.counts.SKIPPED_STALE > 0 ? 3 : 0;
  const summary: DailySummary = { ...base, register, exit };
  deps.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runIancarPhotoDaily().then(s => { process.exitCode = s.exit; }).catch(error => {
    console.error(error instanceof Error && /^[A-Z0-9_]{3,64}$/.test(error.message) ? error.message : 'PHOTO_DAILY_ERROR');
    process.exitCode = 2;
  });
}
