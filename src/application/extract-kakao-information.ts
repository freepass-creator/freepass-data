import { createKakaoInfoCandidate, hasSensitiveKakaoExcerpt, isValidKakaoInfoPlate,
  type KakaoInfoCandidate, type KakaoInfoType } from '../domain/kakao-info-candidate.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import type { InformationExtractionAiPort } from '../ports/ai-information-extraction.js';
import { stableDigest } from '../shared/stable-digest.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const secret = /(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]{15,}|Bearer\s+[A-Za-z0-9_.-]{20,}|AIza[A-Za-z0-9_-]{20,})/;

/** Existing archived RAW -> paid AI extraction -> existing candidate contract.
 * No ingestion, Drive, Sheet or Canonical writes; no automatic acceptance or retry.
 */
export async function extractStoredKakaoInformation(input: {
  runId: string; rawRecordId: string; roomCode: string; msgNo: string;
  senderVerified: boolean; dataClassification: 'SUPPLIER_NON_SENSITIVE'; requestId: string;
}, ports: { source: Pick<SourceIngestionStore, 'getRun' | 'listRaw'>; ai: InformationExtractionAiPort }) {
  if (!input.senderVerified || input.dataClassification !== 'SUPPLIER_NON_SENSITIVE'
    || !/^K-[A-Za-z0-9]{3,12}$/.test(input.roomCode) || !/^\d{1,6}$/.test(input.msgNo)
    || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)) throw new Error('AI_SOURCE_BINDING_REQUIRED');
  const run = await ports.source.getRun(input.runId);
  if (!run || run.status !== 'COMPLETED') throw new Error('AI_SOURCE_RUN_NOT_COMPLETED');
  const records = (await ports.source.listRaw(input.runId)).filter(r => r.rawRecordId === input.rawRecordId);
  if (records.length !== 1) throw new Error('AI_RAW_RECORD_NOT_FOUND');
  const raw = records[0]!, original = raw.payload.original;
  if (raw.runId !== run.runId || raw.sourceId !== run.sourceId || !raw.sourceId.startsWith('kakao:')
    || raw.intakeLaneId !== 'PRODUCT_VEHICLE' || raw.payload.ruleVersion !== 'kakao-intake/1'
    || !object(original) || original.captureVerified !== true || stableDigest(original) !== raw.sourceFingerprint
    || typeof original.text !== 'string' || !original.text.trim() || original.text.length > 8_000
    || typeof original.sentAt !== 'string' || !Number.isFinite(Date.parse(original.sentAt))
    || typeof raw.payload.eventId !== 'string' || !/^[a-f0-9]{64}$/.test(raw.payload.eventId)
    || typeof raw.payload.supplierCode !== 'string') throw new Error('AI_RAW_EVIDENCE_INVALID');
  const text = original.text;
  if (hasSensitiveKakaoExcerpt(text) || secret.test(text)) throw new Error('AI_SENSITIVE_SOURCE_REJECTED');
  // Validate caller-controlled metadata with the existing authority before sending anything.
  const metadata = { supplierCode: raw.payload.supplierCode, roomCode: input.roomCode,
    source: { sentAt: new Date(original.sentAt).toISOString(), side: '상대', msgNo: input.msgNo, channel: 'KAKAO_RAW' as const } };
  const preflight = createKakaoInfoCandidate({ ...metadata, source: { ...metadata.source, excerpt: '원문 검토' },
    type: '조건', fields: { 항목: '원문', 요약: '원문 검토', 값: '원문 검토' },
    confidence: 0, needsSupplierConfirm: true, aiInvolved: true, status: 'CANDIDATE' });
  if (!preflight.ok) throw new Error('AI_SOURCE_METADATA_INVALID');
  const reply = await ports.ai.extract({ text, requestId: input.requestId });
  if (!object(reply.output) || Object.keys(reply.output).some(k => k !== 'candidates')
    || !Array.isArray(reply.output.candidates) || reply.output.candidates.length > 12) throw new Error('AI_CANDIDATE_OUTPUT_INVALID');
  const candidates: Array<{ candidate: KakaoInfoCandidate; evidence: { rawRecordId: string; start: number; end: number }; autoPromotable: false }> = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  for (const [index, row] of reply.output.candidates.entries()) {
    if (!object(row) || Object.keys(row).sort().join(',') !== 'plate,quote,type,value'
      || typeof row.type !== 'string' || typeof row.quote !== 'string' || typeof row.value !== 'string'
      || !row.quote.trim() || row.quote !== row.quote.trim() || Array.from(row.quote).length > 80
      || !row.value.trim() || row.value !== row.value.trim() || row.value.length > 200
      || !row.quote.includes(row.value) || !(row.plate === null || typeof row.plate === 'string')) {
      rejected.push({ index, reason: 'AI_FIELD_SHAPE_INVALID' }); continue;
    }
    const start = text.indexOf(row.quote);
    if (start < 0 || text.indexOf(row.quote, start + 1) !== -1) { rejected.push({ index, reason: 'AI_QUOTE_UNGROUNDED_OR_AMBIGUOUS' }); continue; }
    if (row.plate !== null && (!isValidKakaoInfoPlate(row.plate) || !row.quote.includes(row.plate))) { rejected.push({ index, reason: 'AI_PLATE_UNGROUNDED' }); continue; }
    const checked = createKakaoInfoCandidate({ ...metadata, source: { ...metadata.source, excerpt: row.quote },
      type: row.type as KakaoInfoType, fields: { 항목: '원문 정보', 요약: row.quote, 값: row.value },
      ...(row.plate ? { vehicle: { plateUnverified: row.plate } } : {}),
      confidence: 0, needsSupplierConfirm: true, aiInvolved: true, status: 'CANDIDATE' });
    if (!checked.ok) { rejected.push({ index, reason: checked.reason }); continue; }
    if (seen.has(checked.candidate.candidateId)) continue;
    seen.add(checked.candidate.candidateId);
    candidates.push({ candidate: checked.candidate, evidence: { rawRecordId: raw.rawRecordId, start, end: start + row.quote.length }, autoPromotable: false });
  }
  return { schemaVersion: 'freepass-data.ai-kakao-extraction/v1' as const, status: 'REVIEW_REQUIRED' as const,
    requestId: input.requestId, provider: reply.provider, model: reply.model, responseId: reply.responseId, usage: reply.usage,
    source: { runId: raw.runId, rawRecordId: raw.rawRecordId, sourceId: raw.sourceId,
      sourceRecordId: raw.sourceRecordId, sourceFingerprint: raw.sourceFingerprint, observedAt: raw.observedAt, textDigest: stableDigest(text) },
    candidates, rejected, requiresReview: true as const, writes: 0 as const, automaticRetryAllowed: false as const };
}
