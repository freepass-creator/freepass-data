/** 이안카 사진 «일 1회» 연동(대표 2026-10-15 «이안카 사진은 별도로, 용량 줄여 우리 구글 드라이브로 가져오고 연동»):
 *   복사(원천 → 압축 → 공유 드라이브 번호 폴더) → 등록(photo_original_refs, 빈 칸만) 을 한 번에 돌린다. 이안카 원천에서 사진 말고는 아무것도 쓰지 않는다.
 *   npm run copy:iancar-photos:daily
 * 재고·대여료·보증금·정책 텍스트는 원천 엔진(이 잡이 아님)이 가져온다 — 이 잡은 사진 전용 별도 예약이다.
 * 환경: copy 잡과 같다(EANCAR_ONE_API_KEY, IANCAR_PHOTO_DRIVE_ROOT_ID, IANCAR_PHOTO_COPY_MODE=DRY_RUN|PILOT|FULL, IANCAR_PHOTO_COPY_APPROVED, FULL 은 IANCAR_PHOTO_FULL_APPROVED).
 *   등록은 IANCAR_PHOTO_REGISTER_APPLY=true 일 때만 적용하고, 아니면 등록 도구 DRY_RUN 결과만 낸다.
 * 종료 코드: 0 정상 · 1 복사 실패/중단 또는 등록 실패 · 2 설정 오류 · 3 미완(stale 건너뜀 남음). 번호는 끝 4자리만 출력한다. */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { iancarPhotoCopyCli } from './copy-iancar-photos-to-drive.js';
import type { PhotoCopyResult } from '../application/iancar-photo-drive-copy.js';
import { ensureWriterLease } from '../runtime/ensure-writer-lease.js';

export type DailyRunner = (command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => string;
export type DailyDeps = {
  copy: (argv: string[], env: NodeJS.ProcessEnv) => Promise<PhotoCopyResult>;
  run: DailyRunner;
  log: (line: string) => void;
};
export type RegisterCounts = { planned: number; matched: number; mismatch: number; writeFailed: number; skipped: number };
export type DailySummary = { mode: string; copyStop: string; counts: PhotoCopyResult['counts']; photosWritten: number; completed: number;
  register: { applied: boolean; summary: string[]; counts?: RegisterCounts } | null; exit: 0 | 1 | 3 };

const defaultDeps: DailyDeps = {
  copy: (argv, env) => iancarPhotoCopyCli(argv, env, () => undefined),
  run: (command, args, env, timeoutMs) => execFileSync(command, args, { env, encoding: 'utf8', maxBuffer: 16 << 20, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs, killSignal: 'SIGKILL' }),
  log: line => console.log(line),
};

/** 등록 도구 출력 전체를 읽어 줄별 판정과 건수를 낸다(전체 번호는 끝 4자리로 줄인다). 실패 판정은 «전체 출력» 기준이다 — 보고용으로 줄 수를 자르기 전에 센다(Codex #661 ⑶). */
export function parseRegisterOutput(text: string): { lines: string[]; counts: RegisterCounts } {
  const all = text.split(/\r?\n/).map(l => l.trim().replace(/\d{2,3}[가-힣]\s?(\d{4})/g, '$1')).filter(Boolean)
    .filter(l => /^\d{4}\s/.test(l) || /MATCH|MISMATCH|계획|이미 사진|문서 없음|쓰기 실패|등록 안 함/.test(l));
  const counts: RegisterCounts = { planned: 0, matched: 0, mismatch: 0, writeFailed: 0, skipped: 0 };
  for (const l of all) {
    if (/MISMATCH/.test(l)) counts.mismatch++;
    else if (/MATCH/.test(l)) counts.matched++;
    else if (/쓰기 실패/.test(l)) counts.writeFailed++;
    else if (/계획 \d+장/.test(l)) counts.planned++;
    else counts.skipped++;
  }
  return { lines: all, counts };
}
const REPORT_LINES = 100;

/** 같은 저장소에서 일 1회 잡이 겹쳐 돌지 않게 하는 파일 잠금(Codex #661 ⑴). 오래된 잠금(기본 180분)은 멈춘 실행의 잔재로 보고 넘겨받는다. */
function acquireDailyLock(dir: string, staleMs: number): () => void {
  const path = join(dir, 'iancar-photo-daily.lock');
  const take = () => { const fd = openSync(path, 'wx'); writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); closeSync(fd); };
  try { take(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let age = 0;
    try { age = Date.now() - statSync(path).mtimeMs; } catch { age = Number.POSITIVE_INFINITY; }
    if (age < staleMs) throw new Error('PHOTO_DAILY_ALREADY_RUNNING');
    try { unlinkSync(path); } catch { /* 다른 실행이 먼저 치웠을 수 있다 */ }
    try { take(); } catch { throw new Error('PHOTO_DAILY_ALREADY_RUNNING'); }
  }
  return () => { try { unlinkSync(path); } catch { /* 이미 없음 */ } };
}

const registerTimeoutMs = (env: NodeJS.ProcessEnv) => {
  const minutes = Number(env.IANCAR_PHOTO_REGISTER_TIMEOUT_MIN ?? 20);
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 180 ? Math.floor(minutes) * 60_000 : 20 * 60_000;
};

export async function runIancarPhotoDaily(env: NodeJS.ProcessEnv = process.env, deps: DailyDeps = defaultDeps): Promise<DailySummary> {
  const dir = resolve(env.SOURCE_CYCLE_PRIVATE_DIR || tmpdir());
  const staleMin = Number(env.IANCAR_PHOTO_DAILY_LOCK_STALE_MIN ?? 180);
  const release = acquireDailyLock(dir, (Number.isFinite(staleMin) && staleMin >= 10 ? staleMin : 180) * 60_000);
  // 실행별 고유 경로(타임스탬프·PID): 겹침이 잠금으로 막혀도 이전 실행의 CSV 와 섞이지 않는다.
  const csv = join(dir, `iancar-photo-register-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}.csv`);
  try { return await runLocked(env, deps, csv); }
  finally { release(); try { unlinkSync(csv); } catch { /* 만들어지지 않았거나 이미 없음 */ } }
}

async function runLocked(env: NodeJS.ProcessEnv, deps: DailyDeps, csv: string): Promise<DailySummary> {
  const mode = env.IANCAR_PHOTO_COPY_MODE ?? 'DRY_RUN';
  if (mode !== 'DRY_RUN') await ensureWriterLease(env, 'photo');
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
        ...(apply ? ['--apply'] : [])], env, registerTimeoutMs(env));
      const parsed = parseRegisterOutput(out);
      // 판정은 전체 출력 기준: 불일치·쓰기 실패가 하나라도 있거나, 완료 차량이 있는데 도구가 아무 결과도 내지 않았으면 실패(성공 코드로 가리지 않는다).
      registerFailed = parsed.counts.mismatch > 0 || parsed.counts.writeFailed > 0 || parsed.lines.length === 0;
      register = { applied: apply, summary: parsed.lines.length ? parsed.lines.slice(0, REPORT_LINES) : ['REGISTER_OUTPUT_EMPTY'], counts: parsed.counts };
    } catch (error) {
      registerFailed = true;
      const timedOut = (error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';   // 타임아웃(Codex #661 ⑵): 멈춘 도구는 강제 종료되어 실패로 끝난다
      register = { applied: apply, summary: [timedOut ? 'REGISTER_TOOL_TIMEOUT' : 'REGISTER_TOOL_FAILED'] };
    }
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
