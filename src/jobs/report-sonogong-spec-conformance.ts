/** 손오공 규격 일치 점검 보고(읽기 전용, 쓰기 0): ERP5 상품 캡처(erp5-source-capture/1) 한 개 → 필드별 채움률·규격 위반·대표 사례(끝 4자리).
 *   npm run report:sonogong-conformance -- --capture <capture.json> [--json]
 * 18:00 회차 입구 매핑·제원 적용 뒤 같은 캡처 방식으로 다시 돌려 «전/후» 를 비교한다. 전체 번호·원문 값 전체는 출력하지 않는다. 종료 코드: 0 정상 · 2 설정 오류. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decodeErp5Value, type Erp5SourceCapture } from '../adapters/erp5-source-capture.js';
import { conformanceLines, sonogongSpecConformance } from '../application/sonogong-spec-conformance.js';

export function reportSonogongConformanceCli(argv: string[], log: (line: string) => void = console.log): number {
  const at = argv.indexOf('--capture');
  const path = at >= 0 ? argv[at + 1] : undefined;
  if (!path) { log('설정 오류: --capture <capture.json> 필요'); return 2; }
  let capture: Erp5SourceCapture;
  try { capture = JSON.parse(readFileSync(path, 'utf8')) as Erp5SourceCapture; } catch { log('설정 오류: 캡처 JSON 을 읽을 수 없음'); return 2; }
  const docs = capture?.collections?.products?.documents;
  if (capture?.version !== 'erp5-source-capture/1' || !Array.isArray(docs)) { log('설정 오류: erp5-source-capture/1 상품 목록 없음'); return 2; }
  const plain = docs.flatMap(doc => {
    const fields = (doc as { fields?: Record<string, unknown> }).fields ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) { try { out[key] = decodeErp5Value(value); } catch { /* 해석 못 하는 값은 비워 둔다 */ } }
    return [out];
  });
  const report = sonogongSpecConformance(plain);
  if (argv.includes('--json')) log(JSON.stringify(report));
  else for (const line of conformanceLines(report)) log(line);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(reportSonogongConformanceCli(process.argv.slice(2)));
