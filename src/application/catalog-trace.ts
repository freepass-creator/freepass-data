import type { CatalogStore, ProjectionStore } from '../ports/catalog-store.js';
import type { CatalogEntityType, EntityRevisionRecord } from '../domain/history.js';

type TraceStatus = 'OK' | 'HOLD' | 'LOCAL_ONLY';

export type CatalogTraceRow = {
  stage: 'SOURCE' | 'RAW' | 'NORMALIZED' | 'CANONICAL' | 'PROJECTION' | 'RELEASE' | 'CONSUMER';
  status: TraceStatus;
  title: string;
  summary: string;
  evidence: string;
  details?: unknown;
};

export type CatalogProductTrace = {
  productId: string;
  generatedAt: string;
  rows: CatalogTraceRow[];
  fieldFlows: Array<{
    field: string;
    label: string;
    origin: 'SOURCE_LINEAGE' | 'REVISION_HISTORY';
    raw: { fieldPath: string; value: unknown } | null;
    adapter: {
      transformId: string;
      transformVersion: string;
      normalizedFieldPath: string | null;
      normalizedValue: unknown;
      mode: 'SOURCE' | 'COMMAND_CHANGED' | 'REVISION_CARRIED' | 'NO_SOURCE';
      decision: string;
    };
    canonical: {
      entityType: CatalogEntityType;
      entityId: string;
      revision: number;
      fieldPath: string;
      value: unknown;
    };
    projection: { fieldPath: string; value: unknown };
    consumer: { name: string; location: string; value: unknown };
  }>;
  counts: {
    sources: number;
    rawRecords: number;
    candidates: number;
    canonicalEntities: number;
    projectionFields: number;
    releases: number;
    connectedConsumers: number;
  };
};

const entityKey = (entityType: CatalogEntityType, entityId: string) =>
  `${entityType}:${entityId}`;

const fieldLabel = (fieldPath: string) => {
  const labels: Array<[RegExp, string]> = [
    [/monthlyRent\.amount$/, '월 대여료'],
    [/deposit\.amount$/, '보증금'],
    [/mileageLimitKmPerYear$/, '연간 주행거리 한도'],
    [/odometerKm$/, '현재 주행거리'],
    [/plateNumber$/, '차량번호'],
    [/assetStatus$/, '차량 상태'],
    [/commercialType$/, '상품 유형'],
    [/supplierId$/, '공급사'],
    [/displayName$/, '표시 상품명'],
    [/generation$/, '세대'],
    [/trim$/, '트림'],
    [/maker$/, '제조사'],
    [/model$/, '모델'],
    [/fuel$/, '연료'],
    [/drive$/, '구동방식'],
    [/seats$/, '승차 인원'],
    [/termMonths$/, '계약 개월'],
    [/depositState$/, '보증금 상태']
  ];
  return labels.find(([pattern]) => pattern.test(fieldPath))?.[1]
    ?? fieldPath.split('.').at(-1)
    ?? fieldPath;
};

const isUsefulField = (fieldPath: string) =>
  !/(^|\.)(id|revision|vehicleModelId|vehicleAssetId|termKey|currency)$/.test(fieldPath);

const fieldPriority = (label: string) => {
  const preferred = [
    '월 대여료', '보증금', '보증금 상태', '연간 주행거리 한도', '현재 주행거리',
    '차량번호', '차량 상태', '상품 유형', '공급사', '표시 상품명', '제조사', '모델'
  ];
  const index = preferred.indexOf(label);
  return index === -1 ? preferred.length : index;
};

export async function buildCatalogProductTrace(
  catalog: CatalogStore,
  projections: ProjectionStore,
  productId: string,
  now = new Date().toISOString()
): Promise<CatalogProductTrace | null> {
  const product = await catalog.getProduct(productId);
  if (!product) return null;

  const [model, asset, offers] = await Promise.all([
    catalog.getVehicleModel(product.vehicleModelId),
    product.vehicleAssetId ? catalog.getVehicleAsset(product.vehicleAssetId) : Promise.resolve(null),
    catalog.listOffers()
  ]);
  const productOffers = offers.filter((offer) => offer.productId === product.id);
  const entities = [
    model && { entityType: 'vehicle_model' as const, entityId: model.id, revision: model.revision },
    asset && { entityType: 'vehicle_asset' as const, entityId: asset.id, revision: asset.revision },
    { entityType: 'product' as const, entityId: product.id, revision: product.revision },
    ...productOffers.map((offer) => ({
      entityType: 'offer' as const,
      entityId: offer.id,
      revision: offer.revision
    }))
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));
  const entityKeys = new Set(entities.map((item) => entityKey(item.entityType, item.entityId)));

  const histories = (await Promise.all(
    entities.map((item) => catalog.listEntityHistory(item.entityType, item.entityId))
  )).flat();
  const [allRawLineage, allCanonicalLineage] = await Promise.all([
    catalog.listLineageByStage('RAW_TO_NORMALIZED'),
    catalog.listLineageByStage('NORMALIZED_TO_CANONICAL')
  ]);
  const sourceLineage = allCanonicalLineage.filter((item) =>
    item.canonical && entityKeys.has(entityKey(
      item.canonical.entityType as CatalogEntityType,
      item.canonical.entityId
    ))
  );

  const bindingIds = [...new Set(
    histories.map((item) => item.sourceBindingId).filter((id): id is string => Boolean(id))
  )];
  const bindings = (await Promise.all(bindingIds.map((id) => catalog.getSourceBinding(id))))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const sourceRefs = new Map<string, { sourceId: string; runId: string; sourceRecordId: string }>();
  for (const binding of bindings) {
    sourceRefs.set(`${binding.sourceId}:${binding.sourceRunId}:${binding.sourceRecordId}`, {
      sourceId: binding.sourceId,
      runId: binding.sourceRunId,
      sourceRecordId: binding.sourceRecordId
    });
  }
  for (const item of sourceLineage) {
    sourceRefs.set(`${item.sourceId}:${item.runId}:${item.sourceRecordId}`, {
      sourceId: item.sourceId,
      runId: item.runId,
      sourceRecordId: item.sourceRecordId
    });
  }

  const sourceContexts = await Promise.all([...sourceRefs.values()].map(async (ref) => {
    const [definition, run, head, rawRecords, candidates] = await Promise.all([
      catalog.getSourceDefinition(ref.sourceId),
      catalog.getSourceRun(ref.runId),
      catalog.getSourceHead(ref.sourceId),
      catalog.listRawRecordsByRun(ref.runId),
      catalog.listCandidatesByRun(ref.runId)
    ]);
    const raw = rawRecords.find((item) =>
      item.sourceId === ref.sourceId &&
      item.sourceRecordId === ref.sourceRecordId
    ) ?? null;
    const candidate = candidates.find((item) =>
      item.sourceId === ref.sourceId &&
      item.sourceRecordId === ref.sourceRecordId
    ) ?? null;
    const rawLineage = allRawLineage.filter((item) =>
      item.sourceId === ref.sourceId &&
      item.runId === ref.runId &&
      item.sourceRecordId === ref.sourceRecordId
    );
    return { ref, definition, run, head, raw, candidate, rawLineage };
  }));

  const active = await projections.getActive('erp-public');
  const [manifest, projectionLineage] = active
    ? await Promise.all([
        projections.getManifest(active.releaseId),
        projections.listProjectionLineage(active.releaseId)
      ])
    : [null, []];
  const relevantProjectionLineage = projectionLineage.filter((item) =>
    entityKeys.has(entityKey(item.canonical.entityType, item.canonical.entityId))
  );
  const rawLineageById = new Map(allRawLineage.map((item) => [item.lineageRecordId, item]));
  const sourceLineageForField = (projectionItem: (typeof relevantProjectionLineage)[number]) =>
    sourceLineage
      .filter((item) =>
        item.canonical?.entityType === projectionItem.canonical.entityType &&
        item.canonical.entityId === projectionItem.canonical.entityId &&
        item.canonical.fieldPath === projectionItem.canonical.fieldPath &&
        item.canonical.revision <= projectionItem.canonical.revision
      )
      .sort((left, right) => (right.canonical?.revision ?? 0) - (left.canonical?.revision ?? 0))[0]
      ?? null;
  const fieldFlows = relevantProjectionLineage
    .filter((item) => isUsefulField(item.canonical.fieldPath))
    .map((item) => {
      const sourceEvidence = item.parentLineageRecordId
        ? sourceLineage.find((candidate) => candidate.lineageRecordId === item.parentLineageRecordId)
          ?? sourceLineageForField(item)
        : sourceLineageForField(item);
      const rawEvidence = sourceEvidence?.parentLineageRecordId
        ? rawLineageById.get(sourceEvidence.parentLineageRecordId) ?? null
        : null;
      const manualChange = item.evidenceOrigin === 'REVISION_HISTORY';
      const sourceMatchesCurrent = sourceEvidence?.canonical
        ? JSON.stringify(sourceEvidence.canonical.value) === JSON.stringify(item.canonical.value)
        : false;
      const mode = !sourceEvidence
        ? 'NO_SOURCE' as const
        : !manualChange
          ? 'SOURCE' as const
          : sourceMatchesCurrent
            ? 'REVISION_CARRIED' as const
            : 'COMMAND_CHANGED' as const;
      return {
        field: item.projection.fieldPath,
        label: fieldLabel(item.canonical.fieldPath),
        origin: item.evidenceOrigin,
        raw: rawEvidence
          ? { fieldPath: rawEvidence.source.fieldPath, value: rawEvidence.source.value }
          : null,
        adapter: {
          transformId: sourceEvidence?.transformId ?? 'canonical-revision-command',
          transformVersion: sourceEvidence?.transformVersion ?? 'revision-history',
          normalizedFieldPath: sourceEvidence?.normalized?.fieldPath ?? null,
          normalizedValue: sourceEvidence?.normalized?.value ?? null,
          mode,
          decision: mode === 'COMMAND_CHANGED'
            ? `원천 기준값을 보존하고 명령으로 r${item.canonical.revision} 값 변경`
            : mode === 'REVISION_CARRIED'
              ? `엔티티는 r${item.canonical.revision}로 변경됐지만 이 필드값은 원천값 유지`
              : mode === 'NO_SOURCE'
                ? `원천 연결 없이 명령/이력으로 r${item.canonical.revision} 값 생성`
                : '어댑터 정제값을 현재 Canonical에 반영'
        },
        canonical: structuredClone(item.canonical),
        projection: structuredClone(item.projection),
        consumer: {
          name: '로컬 ERP Public API',
          location: 'GET /v1/views/erp-public/products',
          value: structuredClone(item.projection.value)
        }
      };
    })
    .sort((left, right) =>
      fieldPriority(left.label) - fieldPriority(right.label) ||
      left.field.localeCompare(right.field)
    );
  const currentHistory = histories.filter((record) =>
    entities.some((entity) =>
      entity.entityType === record.entityType &&
      entity.entityId === record.entityId &&
      entity.revision === record.revision
    )
  );
  const latestOffer = productOffers[0];
  const latestTerm = latestOffer?.priceTerms[0];
  const rows: CatalogTraceRow[] = [];

  for (const context of sourceContexts) {
    const sourceOk = context.definition && context.run?.status === 'COMPLETED';
    rows.push({
      stage: 'SOURCE',
      status: sourceOk ? 'OK' : 'HOLD',
      title: context.definition?.displayName ?? context.ref.sourceId,
      summary: `${context.definition?.kind ?? 'UNKNOWN'} · ${context.run?.coverage.mode ?? 'UNKNOWN'} / ${context.run?.coverage.completeness ?? 'UNKNOWN'}`,
      evidence: `sourceId ${context.ref.sourceId} · run ${context.ref.runId}`,
      details: { definition: context.definition, run: context.run, head: context.head }
    });
    rows.push({
      stage: 'RAW',
      status: context.raw ? 'OK' : 'HOLD',
      title: context.raw?.sourceRecordId ?? context.ref.sourceRecordId,
      summary: context.raw
        ? `원문 보존 · ${Object.keys(context.raw.payload).length}개 최상위 필드`
        : '원문을 찾지 못했습니다.',
      evidence: context.raw
        ? `fingerprint ${context.raw.sourceFingerprint} · ${context.raw.observedAt}`
        : `run ${context.ref.runId} · source record ${context.ref.sourceRecordId}`,
      details: context.raw?.payload
    });
    rows.push({
      stage: 'NORMALIZED',
      status: context.candidate?.status === 'VALID' ? 'OK' : 'HOLD',
      title: context.candidate?.candidateId ?? `${context.ref.runId}:${context.ref.sourceRecordId}`,
      summary: context.candidate
        ? `${context.candidate.status} · 가격조건 ${context.candidate.candidate.priceTerms.length}개 · 이슈 ${context.candidate.candidate.issues.length}개`
        : '정제 후보를 찾지 못했습니다.',
      evidence: `RAW→정제 ${context.rawLineage.length}개 필드 연결`,
      details: context.candidate?.candidate
    });
  }

  rows.push({
    stage: 'CANONICAL',
    status: currentHistory.length === entities.length ? 'OK' : 'HOLD',
    title: `${product.displayName} · ${product.id}`,
    summary: `모델 r${model?.revision ?? '—'} · 실차 r${asset?.revision ?? '—'} · 상품 r${product.revision} · 오퍼 r${latestOffer?.revision ?? '—'}${latestTerm ? ` · 월 ${latestTerm.monthlyRent.amount.toLocaleString('ko-KR')}원` : ''}`,
    evidence: `현재 revision snapshot ${currentHistory.length}/${entities.length} · source lineage ${sourceLineage.length}개`,
    details: { entities, currentHistory }
  });
  const projectedProduct = active?.data.find((item) => item.productId === product.id) ?? null;
  rows.push({
    stage: 'PROJECTION',
    status: active && projectedProduct && relevantProjectionLineage.length > 0 ? 'OK' : 'HOLD',
    title: 'ERP Public Projection',
    summary: active
      ? `선택 상품 ${projectedProduct ? 1 : 0}건 · 선택 상품 필드 증거 ${relevantProjectionLineage.length}개`
      : '활성 Projection이 없습니다.',
    evidence: active ? `projection erp-public · release ${active.releaseId}` : 'NO_ACTIVE_RELEASE',
    details: relevantProjectionLineage
  });
  rows.push({
    stage: 'RELEASE',
    status: active?.status === 'ACTIVE' && manifest ? 'OK' : 'HOLD',
    title: active?.releaseId ?? '활성 배포본 없음',
    summary: manifest
      ? `ACTIVE · 전체 배포 상품 ${manifest.productCount} · 전체 오퍼 ${manifest.offerCount} · 전체 필드 증거 ${manifest.fieldEvidenceCount}`
      : 'Manifest를 찾지 못했습니다.',
    evidence: manifest
      ? `manifest ${manifest.manifestId} · input ${manifest.inputDigest.slice(0, 12)}… · data ${manifest.dataDigest.slice(0, 12)}…`
      : 'NO_MANIFEST',
    details: manifest
  });
  rows.push({
    stage: 'CONSUMER',
    status: 'LOCAL_ONLY',
    title: '로컬 ERP Public API',
    summary: '이 로컬 브라우저에서 읽을 수 있음 · 운영 ERP/Admin/Sales/Estimate는 아직 미연결',
    evidence: 'GET /v1/views/erp-public/products',
    details: { releaseId: active?.releaseId ?? null, externalConsumerReceipts: [] }
  });

  return {
    productId,
    generatedAt: now,
    rows,
    fieldFlows,
    counts: {
      sources: sourceContexts.length,
      rawRecords: sourceContexts.filter((item) => item.raw).length,
      candidates: sourceContexts.filter((item) => item.candidate).length,
      canonicalEntities: entities.length,
      projectionFields: relevantProjectionLineage.length,
      releases: active ? 1 : 0,
      connectedConsumers: 0
    }
  };
}
