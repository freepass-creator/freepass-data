import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** 이미 인증된 gws CLI(회사 계정 위임) 실행 파일 경로. 시트 읽기 전송이 쓰는 단일 탐색 규칙.
 * GWS_BIN 명시값 우선, Windows 는 gws.cmd 래퍼에서 gws.exe 를 추출, 그 외는 PATH 의 gws. 못 찾으면 null(던지지 않음). */
export function resolveGwsBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GWS_BIN) return env.GWS_BIN;
  if (process.platform !== 'win32') return 'gws';
  try {
    const where = (execFileSync('where', ['gws.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0] ?? '').trim();
    const exe = readFileSync(where, 'utf8').match(/"([^"]+gws\.exe)"/)?.[1];
    return exe && existsSync(exe) ? exe : null;
  } catch { return null; }
}
