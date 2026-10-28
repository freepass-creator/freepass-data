/** ERP5 상품 캡처(erp5-source-capture/1, 이미 저장된 파일) → 평문 필드 문서 배열(읽기 전용·순수). 네트워크·인증 없음.
 * 보고 잡이 라이브 Firebase 어댑터(erp5-source-capture)를 직접 import 하지 않도록 값 해석만 여기서 감싼다(check-data-access-boundary). */
import { decodeErp5Value, type Erp5SourceCapture } from './erp5-source-capture.js';

/** 캡처 형식이 아니면 null. 해석 못 하는 값은 비워 둔다(추정 금지). */
export function plainProductsFromErp5Capture(capture: unknown): Array<Record<string, unknown>> | null {
  const c = capture as Erp5SourceCapture | null | undefined;
  const docs = c?.collections?.products?.documents;
  if (c?.version !== 'erp5-source-capture/1' || !Array.isArray(docs)) return null;
  return docs.map(doc => {
    const fields = (doc as { fields?: Record<string, unknown> }).fields ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) { try { out[key] = decodeErp5Value(value); } catch { /* 비움 */ } }
    return out;
  });
}
