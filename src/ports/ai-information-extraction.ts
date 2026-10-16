/** Server-to-provider text extraction only. No Catalog/Source mutation capability. */
export type InformationAiProvider = 'openai' | 'claude';
export type InformationAiReply = {
  provider: InformationAiProvider;
  model: string;
  responseId: string;
  output: unknown;
  usage: { inputTokens: number | null; outputTokens: number | null };
};
export interface InformationExtractionAiPort {
  extract(input: { text: string; requestId: string }): Promise<InformationAiReply>;
}

export const INFORMATION_EXTRACTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates'],
  properties: { candidates: { type: 'array', maxItems: 12, items: {
    type: 'object', additionalProperties: false, required: ['type', 'quote', 'value', 'plate'],
    properties: {
      type: { type: 'string', enum: ['재고', '가격', '조건', '정책변경', '계약진행', '서류요구', '접수가능'] },
      quote: { type: 'string', description: 'Unique verbatim source excerpt, at most 80 Unicode characters.' },
      value: { type: 'string', description: 'Verbatim value within quote; preserve all stated units and qualifiers.' },
      plate: { type: ['string', 'null'], description: 'Only a literal plate within the same quote; otherwise null. Never infer.' },
    },
  } } },
} as const;
