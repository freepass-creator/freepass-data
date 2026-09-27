import type {
  IssuedQuoteV2,
  QuoteReadReceipt,
  QuoteWriteReceipt,
  ShareEnvelopeReadReceipt,
  ShareEnvelopeV1,
  ShareEnvelopeWriteReceipt,
} from '../domain/estimate-artifacts.js';

export type EstimateArtifactStore = {
  putIssuedQuote(quote: IssuedQuoteV2, idempotencyKey: string): Promise<QuoteWriteReceipt>;
  getIssuedQuote(quoteId: string, quoteVersion?: number | null): Promise<QuoteReadReceipt>;
  putShareEnvelope(envelope: ShareEnvelopeV1, idempotencyKey: string): Promise<ShareEnvelopeWriteReceipt>;
  getShareEnvelope(envelopeId: string, envelopeVersion?: number | null): Promise<ShareEnvelopeReadReceipt>;
};
