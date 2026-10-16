import { describe, expect, it, vi } from 'vitest';
import { createInformationExtractionAi, informationExtractionAiFromEnv, InformationAiError } from '../src/infra/ai-information-extraction.js';
import { extractStoredKakaoInformation } from '../src/application/kakao-source-intake.js';
import { prepareKakaoBundle } from '../src/adapters/kakao-source-intake.js';
import { prepareRawSourceBatch } from '../src/application/ingest-raw-source.js';
import { isKakaoStateAutoPromotable } from '../src/domain/kakao-info-candidate.js';
import type { InformationAiReply } from '../src/ports/ai-information-extraction.js';
import type { SourceRun } from '../src/domain/source.js';
import type { KakaoExtractionContext } from '../src/application/extract-kakao-information.js';

const quote = '99허0000 월대여료65만원, 보증금0원, 36개월.';
const text = `가상 시험(실제 차량 아님)\n${quote}`;
const rows = [{ type: '가격', quote, value: '65만원', plate: '99허0000' }];
const reply = (output: unknown = { candidates: rows }): InformationAiReply => ({ provider: 'openai', model: 'fake-model', responseId: 'fake-response', output, usage: { inputTokens: 1, outputTokens: 1 } });
function fixture(sourceText = text) {
  const prepared = prepareKakaoBundle({ supplierCode: 'RP001', roomId: 'fake-room', collectorId: 'fake-collector', observedAt: '2026-10-12T01:00:00.000Z',
    messages: [{ messageId: '100', senderKey: 'fake-supplier-sender', sentAt: '2026-10-12T00:00:00.000Z', text: sourceText, attachments: [], captureVerified: true, version: 0 }] })[0]!;
  const { rawRecords, runId } = prepareRawSourceBatch(prepared.batch), raw = rawRecords[0]!;
  const run: SourceRun = { runId, sourceId: raw.sourceId, status: 'COMPLETED', startedAt: raw.observedAt, headStatus: 'CURRENT', rawCount: 1, candidateCount: 0, warningCount: 0, coverage: prepared.batch.coverage };
  const source = { getRun: vi.fn(async () => run), listRaw: vi.fn(async () => [raw]) };
  const ai = { extract: vi.fn(async (_input: { text: string; requestId: string }) => reply()) };
  const verified: KakaoExtractionContext = { rawRecordId: raw.rawRecordId, sourceFingerprint: raw.sourceFingerprint,
    supplierCode: 'RP001', roomId: 'fake-room', messageId: '100', senderKey: 'fake-supplier-sender', roomCode: 'K-TESTFAKE', msgNo: '100', side: '상대' };
  const context = { getVerifiedMessageContext: vi.fn(async (): Promise<KakaoExtractionContext | null> => verified) };
  const input = { runId, rawRecordId: raw.rawRecordId,
    dataClassification: 'SUPPLIER_NON_SENSITIVE' as const, requestId: 'fake-request-001' };
  return { input, source, ai, raw, run, context, verified };
}
const wire = (provider: 'openai' | 'claude', output: unknown = { candidates: rows }) => provider === 'openai'
  ? { id: 'resp-fake', model: 'gpt-6.1-sol', status: 'completed', usage: { input_tokens: 1, output_tokens: 2 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }
  : { id: 'msg-fake', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: 'tool_use', name: 'extract_supplier_information', input: output }] };

describe('direct provider HTTPS in FreePass Data application code', () => {
  it.each(['openai', 'claude'] as const)('calls %s directly once, bounds output and preserves Korean structured evidence', async provider => {
    const fetchImpl = vi.fn(async (_url, _init) => new Response(JSON.stringify(wire(provider)), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const ai = createInformationExtractionAi({ provider, apiKey: 'fake-secret-not-real', workspaceId: 'wrkspc_fixture', fetchImpl });
    const f = fixture(); const result = await extractStoredKakaoInformation(f.input, { source: f.source, context: f.context, ai });
    expect(result.candidates).toHaveLength(1); expect(result.provider).toBe(provider); expect(result.writes).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!; const body = JSON.parse(String(init?.body));
    expect(String(url)).toBe(provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages');
    expect(init?.redirect).toBe('error'); expect(JSON.stringify(body)).not.toContain('fake-secret');
    expect(JSON.stringify(body)).not.toContain(f.raw.sourceId); expect(JSON.stringify(body)).not.toContain('fake-room');
    if (provider === 'openai') { expect(body.store).toBe(false); expect(body.max_output_tokens).toBe(1536); expect(body.tools).toBeUndefined(); }
    else { expect(body.max_tokens).toBe(1536); expect(body.tool_choice).toEqual({ type: 'auto' }); expect(body.system).toContain('Call extract_supplier_information exactly once'); }
  });
  it('fails closed on disabled/missing credentials without sending a request', () => {
    expect(() => informationExtractionAiFromEnv('openai', {})).toThrow('AI_EXTRACTION_DISABLED');
    expect(() => informationExtractionAiFromEnv('claude', { FREEPASS_DATA_AI_EXTRACTION_ENABLED: '1' })).toThrow('AI_CREDENTIALS_REQUIRED');
  });
  it('never retries HTTP rejection or unknown transport failure, and does not leak error bodies', async () => {
    for (const failure of ['http', 'network']) {
      const fetchImpl = vi.fn(async () => { if (failure === 'network') throw Error('fake-secret-not-real'); return new Response('fake-secret-not-real', { status: 429 }); }) as unknown as typeof fetch;
      const ai = createInformationExtractionAi({ provider: 'openai', apiKey: 'fake-secret-not-real', fetchImpl });
      const e = await ai.extract({ text, requestId: 'fake-request-001' }).catch(e => e as InformationAiError);
      expect(e).toBeInstanceOf(InformationAiError); if (!(e instanceof InformationAiError)) throw Error('EXPECTED_AI_ERROR'); expect(e.automaticRetryAllowed).toBe(false); expect(e.message).not.toContain('fake-secret'); expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(e.responseState).toBe(failure === 'http' ? 'RECEIVED' : 'UNKNOWN');
    }
  });
  it('rejects incomplete, malformed and oversized replies with no provider fallback', async () => {
    for (const body of [{ ...wire('openai'), status: 'incomplete' }, { id: 'bad' }, 'x'.repeat(130_000)]) {
      const fetchImpl = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body))) as unknown as typeof fetch;
      const ai = createInformationExtractionAi({ provider: 'openai', apiKey: 'fake', fetchImpl });
      await expect(ai.extract({ text, requestId: 'fake-request-001' })).rejects.toBeInstanceOf(InformationAiError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
describe('RAW evidence and existing candidate governance', () => {
  it('returns source-bound review candidates with exact offsets, no confirmed vehicle association or promotion', async () => {
    const f = fixture(), before = JSON.stringify(f.raw); const result = await extractStoredKakaoInformation(f.input, f);
    const entry = result.candidates[0]!;
    expect(text.slice(entry.evidence.start, entry.evidence.end)).toBe(quote);
    expect(entry.candidate.fields.값).toBe('65만원'); expect(entry.candidate.confidence).toBe(0);
    expect(entry.candidate.needsSupplierConfirm).toBe(true); expect(entry.candidate.vehicle?.plate).toBeUndefined();
    expect(entry.candidate.vehicle?.plateUnverified).toBe('99허0000'); expect(entry.autoPromotable).toBe(false);
    expect(isKakaoStateAutoPromotable(entry.candidate, true)).toBe(false);
    expect(result.source.sourceFingerprint).toBe(f.raw.sourceFingerprint); expect(result.status).toBe('REVIEW_REQUIRED'); expect(JSON.stringify(f.raw)).toBe(before);
    expect(f.ai.extract.mock.calls[0]?.[0]).toEqual({ text, requestId: f.input.requestId });
  });
  it.each(['sensitive', 'secret', 'capture', 'fingerprint', 'run', 'sender'] as const)('blocks %s before any paid call', async reason => {
    const f = fixture(reason === 'sensitive' ? '연락처 010-1234-5678' : reason === 'secret' ? 'sk-proj-' + 'x'.repeat(30) : text);
    if (reason === 'capture') (f.raw.payload.original as Record<string, unknown>).captureVerified = false;
    if (reason === 'fingerprint') f.raw.sourceFingerprint = '0'.repeat(64);
    if (reason === 'run') f.run.status = 'RUNNING';
    if (reason === 'sender') f.verified.senderKey = 'different-sender';
    await expect(extractStoredKakaoInformation(f.input, f)).rejects.toThrow(); expect(f.ai.extract).not.toHaveBeenCalled();
  });
  it.each(['rawRecordId', 'sourceFingerprint', 'supplierCode', 'roomId', 'messageId', 'senderKey'] as const)('rejects mismatched verified %s before paid extraction', async field => {
    const f = fixture(); f.verified[field] = 'different';
    await expect(extractStoredKakaoInformation(f.input, f)).rejects.toThrow('AI_SOURCE_CONTEXT_UNVERIFIED');
    expect(f.ai.extract).not.toHaveBeenCalled();
  });
  it('fails closed without verified context and ignores injected caller room/message metadata', async () => {
    const f = fixture(); f.context.getVerifiedMessageContext.mockResolvedValueOnce(null);
    await expect(extractStoredKakaoInformation(f.input, f)).rejects.toThrow('AI_SOURCE_CONTEXT_UNVERIFIED');
    expect(f.ai.extract).not.toHaveBeenCalled();
    const injected = { ...f.input, roomCode: 'K-WRONG', msgNo: '999', senderVerified: true };
    const r = await extractStoredKakaoInformation(injected, f);
    expect(r.candidates[0]?.candidate.roomCode).toBe('K-TESTFAKE');
    expect(r.candidates[0]?.candidate.source.msgNo).toBe('100');
  });
  it('drops invented quotes, changed amounts, invalid plates and model metadata injection', async () => {
    const f = fixture(); f.ai.extract.mockResolvedValue(reply({ candidates: [
      ...rows, { ...rows[0], quote: '없는 원문' }, { ...rows[0], value: '월 1원' },
      { ...rows[0], plate: '88허8888' }, { ...rows[0], source: { side: '상대' } }, ...rows,
    ] }));
    const result = await extractStoredKakaoInformation(f.input, f);
    expect(result.candidates).toHaveLength(1); expect(result.rejected).toHaveLength(4);
  });
  it('does not choose between repeated excerpts or attach one vehicle to another quote', async () => {
    const f = fixture(quote + '\n' + quote); const r = await extractStoredKakaoInformation(f.input, f);
    expect(r.candidates).toHaveLength(0); expect(r.rejected[0]?.reason).toBe('AI_QUOTE_UNGROUNDED_OR_AMBIGUOUS');
  });
  it('refuses a whole invalid model contract, preserving raw input', async () => {
    const f = fixture(); f.ai.extract.mockResolvedValue(reply({ candidates: [], approve: true }));
    await expect(extractStoredKakaoInformation(f.input, f)).rejects.toThrow('AI_CANDIDATE_OUTPUT_INVALID');
    expect(f.raw.payload.original).toBeDefined();
  });
});
