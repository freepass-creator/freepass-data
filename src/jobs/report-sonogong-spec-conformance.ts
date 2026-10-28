/** 손오공 규격 일치 점검 보고(읽기 전용, 쓰기 0): ERP5 상품 캡처(erp5-source-capture/1) 한 개 → 필드별 채움률·규격 위반·대표 사례(끝 4자리).
 *   npm run report:sonogong-conformance -- (--capture <erp5-source-capture.json> | --products-json <문서 덤프.json>) [--json]
 * 문서 덤프(--products-json)는 export:identity-snapshot 과 같은 평문 형식 [{ id, data: { 칸: 값 } }] 이다(운영 읽기 전용 조회 결과).
 * 18:00 회차 입구 매핑·제원 적용 뒤 같은 캡처 방식으로 다시 돌려 «전/후» 를 비교한다. 전체 번호·원문 값 전체는 출력하지 않는다. 종료 코드: 0 정상 · 2 설정 오류. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { plainProductsFromErp5Capture } from '../adapters/erp5-capture-plain.js';
import { conformanceLines, sonogongSpecConformance } from '../application/sonogong-spec-conformance.js';

export function reportSonogongConformanceCli(argv: string[], log: (line: string) => void = console.log): number {
  const at = argv.indexOf('--capture'), dumpAt = argv.indexOf('--products-json');
  const path = at >= 0 ? argv[at + 1] : undefined, dumpPath = dumpAt >= 0 ? argv[dumpAt + 1] : undefined;
  if (!path === !dumpPath) { log('설정 오류: --capture <capture.json> 또는 --products-json <덤프.json> 중 하나만 필요'); return 2; }
  let plain: Array<Record<string, unknown>>;
  if (dumpPath) {
    let dump: unknown;
    try { dump = JSON.parse(readFileSync(dumpPath, 'utf8')); } catch { log('설정 오류: 문서 덤프 JSON 을 읽을 수 없음'); return 2; }
    if (!Array.isArray(dump)) { log('설정 오류: 문서 덤프는 배열이어야 함'); return 2; }
    plain = dump.flatMap(item => {
      const data = item && typeof item === 'object' && 'data' in item ? (item as { data: unknown }).data : item;
      return data && typeof data === 'object' && !Array.isArray(data) ? [data as Record<string, unknown>] : [];
    });
  } else {
    let capture: unknown;
    try { capture = JSON.parse(readFileSync(path!, 'utf8')); } catch { log('설정 오류: 캡처 JSON 을 읽을 수 없음'); return 2; }
    const decoded = plainProductsFromErp5Capture(capture);
    if (!decoded) { log('설정 오류: erp5-source-capture/1 상품 목록 없음'); return 2; }
    plain = decoded;
  }
  const report = sonogongSpecConformance(plain);
  if (argv.includes('--json')) log(JSON.stringify(report));
  else for (const line of conformanceLines(report)) log(line);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(reportSonogongConformanceCli(process.argv.slice(2)));
