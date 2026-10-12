import {
  depositEvidenceInputFromProduct,
  hasConflictingPaidDeposit,
  normalizeErp5CompatibilityInteger,
  parseDepositSourceRawAmount,
  parseErp5CompatibilityPriceKey,
  readIancarPublishedDeposit,
  resolveDepositWithRuleNote,
} from '../domain/deposit-evidence.js';
import { stableDigest } from '../shared/stable-digest.js';

type Rec = Record<string, unknown>;

export const ZERO_DEPOSIT_QUESTION_TEMPLATES = {
  ZERO_OR_MISSING_WITHOUT_WAIVER_EVIDENCE: {
    id: 'zero-or-missing-without-waiver-evidence',
    question: '0원/빈칸인데 무보증 근거 글자 없음 — 무보증이 맞는지',
  },
  POSITIVE_AMOUNT_WITH_RULE_REQUIRES_REVIEW: {
    id: 'positive-amount-with-rule-requires-review',
    question: '금액이 양수인데 규칙 메모와 달라 — 어느 쪽이 맞는지',
  },
  CONFLICTING_ZERO_DEPOSIT_EVIDENCE: {
    id: 'conflicting-zero-deposit-evidence',
    question: '0원 근거가 서로 충돌',
  },
  IANCAR_PUBLISHED_DEPOSIT_EVIDENCE_UNVERIFIED: {
    id: 'iancar-published-deposit-evidence-unverified',
    question: '공시 보증금 근거 미검증 — 현재 공시 금액 확인',
  },
  ZERO_DEPOSIT_FORBIDDEN_BY_PRODUCT_POLICY: {
    id: 'zero-deposit-forbidden-by-product-policy',
    question: '상품 정책상 무보증 불가인데 0원 — 금액 확인',
  },
  UNKNOWN_DEPOSIT_NEEDS_REVIEW: {
    id: 'unknown-deposit-needs-review',
    question: '보증금을 확정할 근거가 부족 — 금액/무보증 여부 확인',
  },
} as const;

export type ZeroDepositQuestionReason = keyof typeof ZERO_DEPOSIT_QUESTION_TEMPLATES;
export type ZeroDepositAuditClassification = ZeroDepositQuestionReason | 'RAW_AMOUNT_NOT_REFLECTED' | 'PRODUCT_DOC_MISSING';

export type ZeroDepositAuditInput = {
  products: Record<string, Rec>;
  /** 기본 true: listable 상품만 후보로 본다. */
  listableOnly?: boolean;
  expectedProductIds?: readonly string[];
  readAt?: string;
};

const zeroLike = (value: unknown) => value === 0 || value === '0' || value === undefined || value === null || value === '';

function rawAmountForTerm(product: Rec, termMonths: unknown) {
  const input = depositEvidenceInputFromProduct(product, null, { termMonths });
  return parseDepositSourceRawAmount(input.depositSourceRawAmount);
}

function questionReason(reason: string, sourceAmount: unknown): ZeroDepositQuestionReason | null {
  if (reason === 'ZERO_DEPOSIT_FORBIDDEN_BY_PRODUCT_POLICY') return 'ZERO_DEPOSIT_FORBIDDEN_BY_PRODUCT_POLICY';
  if (reason === 'CONFLICTING_ZERO_DEPOSIT_EVIDENCE') return 'CONFLICTING_ZERO_DEPOSIT_EVIDENCE';
  if (reason === 'IANCAR_PUBLISHED_DEPOSIT_EVIDENCE_UNVERIFIED') return 'IANCAR_PUBLISHED_DEPOSIT_EVIDENCE_UNVERIFIED';
  if (reason === 'SOURCE_RAW_AMOUNT' || reason.startsWith('SUPPLIER_RULE_NOTE:')) return null;
  if (reason === 'DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE' || reason === 'MISSING_DEPOSIT_AMOUNT') {
    return zeroLike(sourceAmount) ? 'ZERO_OR_MISSING_WITHOUT_WAIVER_EVIDENCE' : null;
  }
  if (reason === 'CONFLICT' || reason === 'TERM_NOT_COVERED_BY_RULE') return 'POSITIVE_AMOUNT_WITH_RULE_REQUIRES_REVIEW';
  return 'UNKNOWN_DEPOSIT_NEEDS_REVIEW';
}

export function buildZeroDepositCandidateAudit(input: ZeroDepositAuditInput) {
  const readAt = input.readAt ?? new Date().toISOString();
  const details: Array<{
    productId: string;
    termKey: string | null;
    supplierId: string | null;
    classification: ZeroDepositAuditClassification;
    reasonCode: string;
    questionTemplateId: string | null;
    question: string | null;
    priceDeposit: unknown;
    rawDepositAmount: number | null;
  }> = [];
  const products = input.products;
  for (const productId of input.expectedProductIds ?? []) {
    if (!Object.hasOwn(products, productId)) details.push({
      productId,
      termKey: null,
      supplierId: null,
      classification: 'PRODUCT_DOC_MISSING',
      reasonCode: 'PRODUCT_DOC_MISSING',
      questionTemplateId: null,
      question: null,
      priceDeposit: null,
      rawDepositAmount: null,
    });
  }
  for (const [productId, product] of Object.entries(products)) {
    // 질문은 판매 중 차량에만 의미가 있다(비판매 상품은 후보에서 제외, 건수만 보고).
    if (input.listableOnly !== false && product.listable !== true) continue;
    const price = product.price;
    if (!price || typeof price !== 'object' || Array.isArray(price)) continue;
    const hasPositivePaidDeposit = hasConflictingPaidDeposit(price);
    for (const [termKey, rowValue] of Object.entries(price as Record<string, unknown>)) {
      if (!rowValue || typeof rowValue !== 'object' || Array.isArray(rowValue)) continue;
      const row = rowValue as Rec;
      if (!normalizeErp5CompatibilityInteger(row.rent)) continue;
      const parsed = parseErp5CompatibilityPriceKey(termKey);
      const rawDepositAmount = rawAmountForTerm(product, parsed?.months);
      const evidence = product.provider_company_code === 'RP031'
        ? readIancarPublishedDeposit(product, termKey, readAt)
        : resolveDepositWithRuleNote(depositEvidenceInputFromProduct(product, row.deposit, {
          termMonths: parsed?.months,
          monthlyRent: normalizeErp5CompatibilityInteger(row.rent),
          hasPositivePaidDeposit,
        }));
      if (rawDepositAmount !== undefined && zeroLike(row.deposit) && evidence.state === 'KNOWN' && evidence.reason === 'SOURCE_RAW_AMOUNT') {
        details.push({
          productId,
          termKey,
          supplierId: typeof product.provider_company_code === 'string' ? product.provider_company_code : null,
          classification: 'RAW_AMOUNT_NOT_REFLECTED',
          reasonCode: 'RAW_AMOUNT_NOT_REFLECTED',
          questionTemplateId: null,
          question: null,
          priceDeposit: row.deposit ?? null,
          rawDepositAmount,
        });
        continue;
      }
      const classification = evidence.state === 'UNKNOWN' ? questionReason(evidence.reason, row.deposit) : null;
      if (!classification) continue;
      const template = ZERO_DEPOSIT_QUESTION_TEMPLATES[classification];
      details.push({
        productId,
        termKey,
        supplierId: typeof product.provider_company_code === 'string' ? product.provider_company_code : null,
        classification,
        reasonCode: evidence.reason,
        questionTemplateId: template.id,
        question: template.question,
        priceDeposit: row.deposit ?? null,
        rawDepositAmount: rawDepositAmount ?? null,
      });
    }
  }
  const countsByReason: Record<string, number> = {};
  const questionTemplateIdsByReason: Record<string, string> = {};
  for (const row of details) {
    countsByReason[row.reasonCode] = (countsByReason[row.reasonCode] ?? 0) + 1;
    if (row.questionTemplateId) questionTemplateIdsByReason[row.reasonCode] = row.questionTemplateId;
  }
  const report = {
    schema: 'freepass-data.zero-deposit-candidate-audit/v1',
    readAt,
    productCount: Object.keys(products).length,
    candidateCount: details.filter(row => row.questionTemplateId).length,
    countsByReason,
    questionTemplateIdsByReason,
    writeAuthorized: false as const,
    details,
  };
  return {
    report,
    publicSummary: {
      schema: report.schema,
      readAt,
      productCount: report.productCount,
      candidateCount: report.candidateCount,
      countsByReason,
      questionTemplateIdsByReason,
      reportDigest: stableDigest(report),
    },
  };
}
