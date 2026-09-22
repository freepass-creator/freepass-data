import { createHash } from 'node:crypto';

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

export function stableDigest(value) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function normalizePriceTerms(terms) {
  if (!Array.isArray(terms)) return terms;
  return [...terms]
    .map((term) => stableValue(term))
    .sort((a, b) => String(a?.termKey ?? '').localeCompare(String(b?.termKey ?? '')));
}

function normalizeOffers(offers) {
  if (!Array.isArray(offers)) return offers;
  return [...offers]
    .map((offer) => ({
      ...stableValue(offer),
      priceTerms: normalizePriceTerms(offer?.priceTerms)
    }))
    .sort((a, b) => String(a?.offerId ?? '').localeCompare(String(b?.offerId ?? '')));
}

export function normalizeProduct(product) {
  return {
    ...stableValue(product),
    offers: normalizeOffers(product?.offers)
  };
}

export function extractCatalogPayload(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : null;

  if (!rows) {
    throw new Error('Catalog response must be an array or an object with a data array');
  }

  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      throw new Error('Catalog rows must be objects');
    }
    if (typeof row.productId !== 'string' || !row.productId) {
      throw new Error('Every catalog row must have a non-empty productId');
    }
    if (ids.has(row.productId)) {
      throw new Error(`Duplicate productId: ${row.productId}`);
    }
    ids.add(row.productId);
  }

  return rows;
}

function productDigestMap(rows) {
  return new Map(
    rows.map((row) => [row.productId, stableDigest(normalizeProduct(row))])
  );
}

function sequenceDigest(rows) {
  return stableDigest(rows.map((row) => row.productId));
}

function semanticCatalogDigest(rows) {
  return stableDigest(
    [...rows]
      .map(normalizeProduct)
      .sort((a, b) => a.productId.localeCompare(b.productId))
  );
}

export function compareCatalogs(leftPayload, rightPayload) {
  const leftRows = extractCatalogPayload(leftPayload);
  const rightRows = extractCatalogPayload(rightPayload);
  const leftMap = productDigestMap(leftRows);
  const rightMap = productDigestMap(rightRows);

  const missingOnRight = [...leftMap.keys()]
    .filter((id) => !rightMap.has(id))
    .sort();
  const missingOnLeft = [...rightMap.keys()]
    .filter((id) => !leftMap.has(id))
    .sort();
  const mismatched = [...leftMap.keys()]
    .filter((id) => rightMap.has(id) && leftMap.get(id) !== rightMap.get(id))
    .sort();

  const leftSequenceDigest = sequenceDigest(leftRows);
  const rightSequenceDigest = sequenceDigest(rightRows);
  const orderMatches = leftSequenceDigest === rightSequenceDigest;

  const contentMatches =
    missingOnRight.length === 0 &&
    missingOnLeft.length === 0 &&
    mismatched.length === 0;

  return {
    contentMatches,
    orderMatches,
    counts: {
      left: leftRows.length,
      right: rightRows.length,
      missingOnRight: missingOnRight.length,
      missingOnLeft: missingOnLeft.length,
      mismatched: mismatched.length
    },
    ids: {
      missingOnRight,
      missingOnLeft,
      mismatched
    },
    digests: {
      leftSemantic: semanticCatalogDigest(leftRows),
      rightSemantic: semanticCatalogDigest(rightRows),
      leftSequence: leftSequenceDigest,
      rightSequence: rightSequenceDigest
    }
  };
}
