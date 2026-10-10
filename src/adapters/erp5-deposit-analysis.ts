import { auditDepositEvidence } from '../domain/deposit-evidence.js';
import { decodeErp5Value, inspectErp5Capture, type Erp5SourceCapture } from './erp5-source-capture.js';

/** Selective decoding avoids excluding whole products because unrelated metadata is unsupported. */
export function analyzeErp5Deposits(capture: Erp5SourceCapture) {
  inspectErp5Capture(capture);
  const products: Record<string, Record<string, unknown>> = {};
  const decodeFailures: Array<{ productId: string; field: string }> = [];
  for (const document of capture.collections.products.documents) {
    const productId = String(document.name).split('/').at(-1)!;
    const fields = document.fields as Record<string, unknown> | undefined;
    const product: Record<string, unknown> = {};
    for (const key of ['provider_company_code', 'product_type', 'listable', 'deposit_note', 'deposit_free', 'deposit_free_confirmation', '원문', 'price']) {
      if (!fields || !Object.hasOwn(fields, key)) continue;
      try { product[key] = decodeErp5Value(fields[key]); }
      catch { decodeFailures.push({ productId, field: key }); }
    }
    products[productId] = product;
  }
  const audit = auditDepositEvidence(products);
  const bySupplier: Record<string, { products: number; paidTerms: number; unknownTerms: number; unknownProducts: number; visibleUnknownProducts: number }> = {};
  for (const supplierId of new Set(Object.values(products).map(row => String(row.provider_company_code ?? 'UNKNOWN')))) {
    const rows = audit.findings.filter(row => row.supplierId === supplierId);
    const unknown = rows.filter(row => row.state === 'UNKNOWN');
    bySupplier[supplierId] = { products: Object.values(products).filter(row => (row.provider_company_code ?? 'UNKNOWN') === supplierId).length,
      paidTerms: rows.length, unknownTerms: unknown.length, unknownProducts: new Set(unknown.map(row => row.productId)).size,
      visibleUnknownProducts: new Set(unknown.filter(row => row.listable).map(row => row.productId)).size };
  }
  const missingPriceProducts = Object.entries(products).filter(([, row]) => !row.price || typeof row.price !== 'object' || Array.isArray(row.price)).map(([id]) => id);
  return { schema: 'freepass-data.deposit-audit/v1', sourceDigest: capture.digest, readTime: capture.readTime,
    ...audit, bySupplier, decodeFailures, missingPriceProducts,
    decision: 'HOLD' as const, consumerCutoverVerified: false as const };
}
