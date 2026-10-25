import { createHash } from 'node:crypto';
import { resolveErp5InventoryStatus } from '../domain/erp5-inventory-status.js';
import { toInternalFeeLookup } from '../domain/internal-fee-lookup-contract.js';
import { buildKakaoCatalogReferenceProduct } from './kakao-catalog-reference.js';
import { auditVehicleNameReferenceParity } from './vehicle-master-reference-parity.js';
const metric = (id, name, numerator, denominator, readAt, basis, note) => ({
    id,
    name,
    numerator,
    denominator,
    ratio: denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6)),
    readAt,
    basis,
    note,
});
const text = (value) => typeof value === 'string' ? value.trim() : '';
const isNonEmpty = (value) => text(value).length > 0;
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const productId = (id, product) => text(product._key) || id;
const isDeleted = (product) => product._deleted === true || !!product.deletedAt || !!product.publication_withdrawal;
const isListableProduct = (product) => product.listable === true && !isDeleted(product);
const isHttp = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());
function termMonthsFrom(termKey, row) {
    const explicit = row.termMonths ?? row.months ?? row.periodMonths ?? row.term_months;
    if (typeof explicit === 'number' && Number.isSafeInteger(explicit) && explicit > 0)
        return explicit;
    if (typeof explicit === 'string') {
        const parsed = Number.parseInt(explicit.trim(), 10);
        if (Number.isSafeInteger(parsed) && parsed > 0)
            return parsed;
    }
    const parsed = Number.parseInt(termKey, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function priceRows(product) {
    if (!product.price || typeof product.price !== 'object' || Array.isArray(product.price))
        return [];
    return Object.entries(product.price)
        .filter(([, row]) => row && typeof row === 'object' && !Array.isArray(row) && positive(row.rent))
        .map(([termKey, row]) => ({ termKey, termMonths: termMonthsFrom(termKey, row), monthlyRent: row.rent, row }));
}
const vehicleHash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
function legacyProductNameRows(products) {
    return products.map(([id, product]) => ({
        id: productId(id, product),
        plateNumber: productId(id, product),
        maker: text(product.maker),
        model: text(product.model),
        subModel: text(product.sub_model),
    }));
}
function hasApprovedPhoto(product, isPublicIancarPhotoProduct) {
    if (isPublicIancarPhotoProduct(product))
        return true;
    if (isHttp(product.photo_link))
        return true;
    return Array.isArray(product.image_urls) && product.image_urls.some(isHttp);
}
function statusConsistent(product) {
    const resolved = resolveErp5InventoryStatus(product.vehicle_status);
    if (!resolved.known)
        return false;
    if (text(product.status_kind) && text(product.status_kind) !== resolved.statusKind)
        return false;
    if (product.listable !== undefined && product.listable !== resolved.listable)
        return false;
    const status = text(product.status);
    return !status || status === resolved.status || status === resolved.statusKind;
}
function isOfferEffectiveAt(offer, readAt) {
    const readTime = Date.parse(readAt);
    if (offer.status !== 'ACTIVE' || !Number.isFinite(readTime))
        return false;
    if (offer.validFrom) {
        const validFrom = Date.parse(offer.validFrom);
        if (!Number.isFinite(validFrom) || validFrom > readTime)
            return false;
    }
    if (offer.validUntil) {
        const validUntil = Date.parse(offer.validUntil);
        if (!Number.isFinite(validUntil) || validUntil < readTime)
            return false;
    }
    return true;
}
function matchingCurrentOfferTerm(offers, row, readAt) {
    const matches = offers
        .filter((offer) => isOfferEffectiveAt(offer, readAt))
        .map((offer) => ({
        offer,
        term: offer.priceTerms.find((term) => term.termKey === row.termKey &&
            (row.termMonths == null || term.termMonths === row.termMonths) &&
            term.monthlyRent.amount === row.monthlyRent &&
            term.monthlyRent.currency === 'KRW'),
    }))
        .filter((match) => !!match.term);
    return matches.length === 1 ? matches[0] : null;
}
function projectedTermConfirmed(term) {
    if (!term)
        return false;
    const confirmed = (fee) => (fee.state === 'CALCULATED' || fee.state === 'KNOWN') &&
        fee.amount != null &&
        !fee.reasonCode;
    return confirmed(term.supplierBillingFee) && confirmed(term.channelPayoutFee);
}
function engineFeeProjectionByProduct(input) {
    if (input.engineFeeProjectionByProduct)
        return input.engineFeeProjectionByProduct;
    const policies = input.legacyPolicies ?? {};
    return Object.fromEntries(Object.entries(input.legacyProducts).map(([id, product]) => {
        const projected = buildKakaoCatalogReferenceProduct(id, product, {}, policies, input.readAt);
        const terms = projected?.offers[0]?.priceTerms.map((term) => ({
            termKey: term.termKey.replace(/^source:/, ''),
            supplierBillingFee: term.supplierBillingFee,
            channelPayoutFee: term.channelPayoutFee,
        })) ?? [];
        return [productId(id, product), terms];
    }));
}
export function buildTrustScorecard(input, helpers) {
    const legacyListable = Object.entries(input.legacyProducts).filter(([, product]) => isListableProduct(product));
    const parity = auditVehicleNameReferenceParity({
        referenceRows: input.vehicleReferenceRows,
        masterRows: input.legacyVehicleMasterRows,
        productRows: legacyProductNameRows(legacyListable),
    });
    const parityFailures = new Set(parity.issues.filter((issue) => issue.entityKind === 'PRODUCT').map((issue) => issue.entityId));
    const vehicleNamePass = new Map();
    for (const [id, product] of legacyListable) {
        const completeSpecs = ['maker', 'model', 'sub_model', 'trim_name', 'fuel_type', 'engine_cc'].every((key) => isNonEmpty(product[key]));
        vehicleNamePass.set(productId(id, product), completeSpecs && !parityFailures.has(productId(id, product)));
    }
    const depositPass = new Map();
    let depositNumerator = 0, depositDenominator = 0;
    for (const [id, product] of legacyListable) {
        const withEvidence = helpers.withCompatibilityDepositEvidence(product, input.readAt);
        const rows = priceRows(withEvidence);
        const allKnown = rows.length > 0 && rows.every(({ row }) => row.depositState === 'KNOWN' || row.depositState === 'ZERO');
        depositPass.set(productId(id, product), allKnown);
        for (const { row } of rows) {
            depositDenominator += 1;
            if (row.depositState === 'KNOWN' || row.depositState === 'ZERO')
                depositNumerator += 1;
        }
    }
    const productById = new Map(input.canonical.products.map((product) => [product.id, product]));
    const modelsById = new Map(input.canonical.vehicleModels.map((model) => [model.id, model]));
    const assetsById = new Map(input.canonical.vehicleAssets.map((asset) => [asset.id, asset]));
    const offerByProductId = new Map();
    for (const offer of input.canonical.offers)
        offerByProductId.set(offer.productId, [...(offerByProductId.get(offer.productId) ?? []), offer]);
    let economicsNumerator = 0, economicsDenominator = 0, rentConfirmed = 0, catalogOfferNumerator = 0;
    const economicsPass = new Map();
    const projectedFeeTermsByProduct = engineFeeProjectionByProduct(input);
    const canonicalLegacyId = (product) => product.id;
    for (const [id, legacy] of legacyListable) {
        const rows = priceRows(legacy);
        let all = rows.length > 0;
        for (const row of rows) {
            economicsDenominator += 1;
            if (positive(row.row.rent))
                rentConfirmed += 1;
        }
        const canonicalProduct = productById.get(productId(id, legacy));
        const offers = canonicalProduct?.status === 'ACTIVE' ? offerByProductId.get(canonicalLegacyId(canonicalProduct)) ?? [] : [];
        const projectedTerms = new Map((projectedFeeTermsByProduct[productId(id, legacy)] ?? []).map((term) => [term.termKey, term]));
        for (const row of rows) {
            if (projectedTermConfirmed(projectedTerms.get(row.termKey))) {
                economicsNumerator += 1;
            }
            else {
                all = false;
            }
            const match = matchingCurrentOfferTerm(offers, row, input.readAt);
            const term = match ? toInternalFeeLookup(match.offer.id, [match.term], match.offer.internalEconomicsTerms).terms[0] : null;
            if (term?.supplierBillingFee.status === 'CONFIRMED' && term.channelPayoutFee.status === 'CONFIRMED') {
                catalogOfferNumerator += 1;
            }
        }
        economicsPass.set(productId(id, legacy), all);
    }
    const photoPass = new Map();
    for (const [id, product] of legacyListable)
        photoPass.set(productId(id, product), hasApprovedPhoto(product, helpers.isPublicIancarPhotoProduct));
    const freshnessRows = input.sourceFreshness.map((source) => {
        const observed = source.observedAt ?? source.acceptedAt ?? null;
        const ageSeconds = observed && Number.isFinite(Date.parse(observed)) ? Math.max(0, Math.floor((Date.parse(input.readAt) - Date.parse(observed)) / 1000)) : null;
        const pass = source.expectedFreshnessSeconds != null && ageSeconds != null && ageSeconds <= source.expectedFreshnessSeconds * 2;
        return { sourceId: source.sourceId, ageSeconds, expectedFreshnessSeconds: source.expectedFreshnessSeconds, pass, basis: 'DIRECT', note: observed ? 'source_heads observedAt/acceptedAt 기준' : 'head timestamp unavailable' };
    });
    const statusPassCount = legacyListable.filter(([, product]) => statusConsistent(product)).length;
    const vehiclePasses = legacyListable.map(([id, product]) => {
        const pid = productId(id, product);
        const row = {
            hash: vehicleHash(pid),
            vehicleName: vehicleNamePass.get(pid) === true,
            deposit: depositPass.get(pid) === true,
            economics: economicsPass.get(pid) === true,
            photo: photoPass.get(pid) === true,
        };
        return { ...row, all: row.vehicleName && row.deposit && row.economics && row.photo };
    }).sort((a, b) => a.hash.localeCompare(b.hash));
    const onlyBlockers = ['vehicleName', 'deposit', 'economics', 'photo'].map((key) => ({
        item: key,
        count: vehiclePasses.filter((row) => !row[key]
            && ['vehicleName', 'deposit', 'economics', 'photo'].every((other) => other === key || row[other])).length,
    }));
    const metrics = [
        metric('vehicle-name-spec-confirmed', '차종·제원 정리율', [...vehicleNamePass.values()].filter(Boolean).length, legacyListable.length, input.readAt, 'DIRECT', 'vehicle_master/vehicle_trim_master 이름 대조 재사용'),
        metric('deposit-confirmed', '보증금 확정율', depositNumerator, depositDenominator, input.readAt, 'DIRECT', 'withCompatibilityDepositEvidence 재사용'),
        metric('period-rent-fee-confirmed', '기간별 대여료·수수료 확정율', economicsNumerator, economicsDenominator, input.readAt, 'DIRECT', `engineProjection supplierBillingFee+channelPayoutFee confirmed; rentRows ${rentConfirmed}/${economicsDenominator}; catalogOfferConfirmed ${catalogOfferNumerator}/${economicsDenominator}`),
        metric('photo-present', '사진 보유율', [...photoPass.values()].filter(Boolean).length, legacyListable.length, input.readAt, 'PROXY', 'ERP5 화면 실제 노출은 오프라인 검증 불가'),
        metric('source-freshness', '신선도', freshnessRows.filter((row) => row.pass).length, freshnessRows.length, input.readAt, 'DIRECT', 'sources expectedFreshnessSeconds 대비 source_heads observedAt/acceptedAt 2배 이내'),
        metric('status-consistency', '상태 정확도', statusPassCount, legacyListable.length, input.readAt, 'PROXY', '원천 대조는 박제 도구 확장 필요'),
    ];
    const summary = metric('all-core', '판매 중 차 중 ①②③④ 모두 맞는 차 비율', vehiclePasses.filter((row) => row.all).length, vehiclePasses.length, input.readAt, 'DIRECT', '차 단위: 보증금·수수료는 모든 가격행 통과 필요');
    const reportNoDigest = { schema: 'freepass-data.trust-scorecard/v1', readAt: input.readAt, summary, metrics, freshnessSources: freshnessRows, bottlenecks: onlyBlockers, vehiclePasses };
    const digest = createHash('sha256').update(JSON.stringify(reportNoDigest)).digest('hex');
    const report = { ...reportNoDigest, digest };
    const publicMetric = ({ id, name, ratio, basis, readAt }) => ({ id, name, ratio, basis, readAt });
    return { report, publicSummary: { schema: 'freepass-data.trust-scorecard-summary/v1', readAt: input.readAt, summary: publicMetric(summary), metrics: metrics.map(publicMetric), digest } };
}
