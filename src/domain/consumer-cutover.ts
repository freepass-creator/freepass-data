export type ConsumerCutoverStage =
  | 'LEGACY_DIRECT'
  | 'OBSERVE'
  | 'SHADOW_READ'
  | 'PARITY_VERIFIED'
  | 'FREEPASS_DATA_READ';

export type ApprovedReleaseEvidence = {
  projectionId: string;
  releaseId: string;
  manifestId: string;
  inputDigest: string;
  dataDigest: string;
  observedAt: string;
};

export type ConsumerCutoverEvidence = {
  // These flags concern the registered Canonical cutover contract. Compatibility
  // transport or REFERENCE_ONLY readback must not satisfy them automatically.
  contractReady: boolean;
  authenticationVerified: boolean;
  legacyReadVerified: boolean;
  freepassReadVerified: boolean;
  parityVerified: boolean;
  fallbackVerified: boolean;
  productionReadbackVerified: boolean;
  approvedRelease: ApprovedReleaseEvidence | null;
};

export type ConsumerSwitchRegistration = {
  consumerId: string;
  project: string;
  repository: string;
  domains: string[];
  stage: ConsumerCutoverStage;
  activeReadOwner: string;
  targetReadOwner: 'freepass-data';
  switchKey: string;
  evidence: ConsumerCutoverEvidence;
  holdReasons: string[];
};

export type ConsumerSwitchDecision = {
  allowed: boolean;
  from: ConsumerCutoverStage;
  to: ConsumerCutoverStage;
  blockers: string[];
};

const ORDER: ConsumerCutoverStage[] = [
  'LEGACY_DIRECT',
  'OBSERVE',
  'SHADOW_READ',
  'PARITY_VERIFIED',
  'FREEPASS_DATA_READ'
];

export const CONSUMER_SWITCH_REGISTRY: ConsumerSwitchRegistration[] = [
  {
    consumerId: 'erp-com-public-catalog',
    project: 'ERP.com',
    repository: 'freepass-creator/freepasserp4',
    domains: ['catalog'],
    stage: 'OBSERVE',
    activeReadOwner: 'freepasserp5/products-policy',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_ERP_COM_READ_MODE',
    evidence: {
      contractReady: true,
      authenticationVerified: false,
      legacyReadVerified: true,
      freepassReadVerified: false,
      parityVerified: false,
      fallbackVerified: false,
      productionReadbackVerified: false,
      approvedRelease: null
    },
    holdReasons: [
      '2026-10-09T08:16:43.179Z: erp-com catalog-compat returned 200 with FREEPASS_DATA_COMPATIBILITY_BRIDGE; this is not Canonical or downstream cutover evidence',
      '2026-10-09: authenticated erp-com catalog returned 503; downstream active read mode and same-product/term parity remain unverified',
      '2026-10-09T08:27:51.878Z: ERP public feed retained 3890 UNKNOWN deposit terms as numeric zero without depositState; 752 omitted basic keys have equal-rent composite terms and are aliases, not missing distinct offers',
      'non-empty ACTIVE erp-public release parity and shadow latency require production evidence'
    ]
  },
  {
    consumerId: 'erp-whitelabel-catalogs',
    project: 'ERP white-labels',
    repository: 'freepass-creator/freepasserp4',
    domains: ['catalog'],
    stage: 'OBSERVE',
    activeReadOwner: 'freepasserp5/products-policy',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_WHITELABEL_READ_MODE',
    evidence: {
      contractReady: true,
      authenticationVerified: false,
      legacyReadVerified: true,
      freepassReadVerified: false,
      parityVerified: false,
      fallbackVerified: false,
      productionReadbackVerified: false,
      approvedRelease: null
    },
    holdReasons: [
      '2026-10-09T08:16:49.293Z to 08:17:44.949Z: catalog-compat returned 200 individually for whitelabel-uniplan, whitelabel-freepassmobility, whitelabel-haheoho, whitelabel-eancar, whitelabel-chashoong, whitelabel-krautoplan, whitelabel-withautoplan, whitelabel-ksautoplan, whitelabel-carping, whitelabel-siauto; catalog returned 503 for each identity',
      'compatibility transport receipts do not verify each downstream channel read mode, product/term parity or Canonical ACTIVE release',
      '2026-10-09T08:27:57.867Z to 08:29:36.174Z: public feeds dropped UNKNOWN deposit state and returned numeric zero for 3890 terms per general channel, 2256 for eancar; public economics and term parity remain HOLD',
      'tenant exposure parity is not verified'
    ]
  },
  {
    consumerId: 'freepass-admin-catalog',
    project: 'FreePass Admin',
    repository: 'freepass-creator/freepass-admin',
    domains: ['catalog'],
    stage: 'OBSERVE',
    activeReadOwner: 'freepass-admin/legacy-shape-catalog',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_ADMIN_CATALOG_READ_MODE',
    evidence: {
      contractReady: true,
      authenticationVerified: false,
      legacyReadVerified: true,
      freepassReadVerified: false,
      parityVerified: false,
      fallbackVerified: false,
      productionReadbackVerified: false,
      approvedRelease: null
    },
    holdReasons: [
      '2026-10-09T08:42:24.364Z: dedicated freepass-data-admin runtime authenticated freepass-admin-catalog catalog-compat with 200; Canonical catalog returned NO_ACTIVE_RELEASE 503',
      '2026-10-09: Admin Production environment command resolved OBSERVE with transport configuration present; code selects the legacy-shape bridge, while deployed revision and intake/policy parity remain unverified'
    ]
  },
  {
    consumerId: 'freepass-sales-catalog',
    project: 'FreePass Sales',
    repository: 'freepass-creator/freepass-sales',
    domains: ['catalog'],
    stage: 'LEGACY_DIRECT',
    activeReadOwner: 'welrixtable/firestore',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_SALES_CATALOG_READ_MODE',
    evidence: {
      contractReady: false,
      authenticationVerified: false,
      legacyReadVerified: true,
      freepassReadVerified: false,
      parityVerified: false,
      fallbackVerified: false,
      productionReadbackVerified: false,
      approvedRelease: null
    },
    holdReasons: [
      'catalog consumer adapter is not implemented',
      'customer and call data remain Sales-owned and outside Catalog cutover'
    ]
  },
  {
    consumerId: 'freepass-estimate-catalog',
    project: 'FreePass Estimate',
    repository: 'freepass-creator/freepass-estimate',
    domains: ['catalog', 'pricing-input'],
    stage: 'LEGACY_DIRECT',
    activeReadOwner: 'freepass-estimate/provider-adapters',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_ESTIMATE_CATALOG_READ_MODE',
    evidence: {
      contractReady: false,
      authenticationVerified: false,
      legacyReadVerified: true,
      freepassReadVerified: false,
      parityVerified: false,
      fallbackVerified: false,
      productionReadbackVerified: false,
      approvedRelease: null
    },
    holdReasons: [
      '2026-10-09: Estimate main 1925dd4a includes apps/new/api/freepass-data-master.js and the authoritative request consumer; code presence is verified, deployed consumer contract readiness is not',
      '2026-10-09: existing apps/new Vercel link resolves freepass-estimator prj_udO3Y62bU2dFLQqy3Tfc2Tj4dgDd; Production environment command observed master URL and token absent, so code presence is not transport adoption',
      '2026-10-09: dedicated freepass-data-estimate-writer runtime authenticated freepass-estimate estimate-newcar-master and returned NO_ACTIVE_RELEASE 503; ACTIVE readback and cutover remain HOLD',
      'quote calculation and provider ownership must remain in Estimate'
    ]
  },
  {
    consumerId: 'kakao-ops-catalog',
    project: 'Kakao Ops',
    repository: 'freepass-creator/kakao-ops',
    domains: ['catalog'],
    stage: 'OBSERVE',
    activeReadOwner: 'freepasserp5/products-policy',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_KAKAO_OPS_READ_MODE',
    evidence: {
      contractReady: true,
      authenticationVerified: false,
      legacyReadVerified: true,
      freepassReadVerified: false,
      parityVerified: false,
      fallbackVerified: false,
      productionReadbackVerified: false,
      approvedRelease: null
    },
    holdReasons: [
      '2026-10-09T08:16:02.295Z: dedicated kakao-ops authentication and catalog-reference 200 observed with REFERENCE_ONLY/HOLD; this does not verify Canonical reads',
      'non-empty ACTIVE erp-public release is not verified',
      'Kakao operator PC entrypoint and reference-contract adoption are not verified',
      '2026-10-09: deployed e0afae9 ignores ZERO/term/scope reference filters; PR408 is the single implementation line and is not deployed'
    ]
  },
  {
    consumerId: 'google-sheets-f01',
    project: 'Google Sheets F01',
    repository: 'freepass-creator/freepasserp4',
    domains: ['catalog'],
    stage: 'OBSERVE',
    activeReadOwner: 'freepasserp5-publication-snapshot',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_F01_READ_MODE',
    evidence: {
      contractReady: true,
      authenticationVerified: false,
      legacyReadVerified: true,
      freepassReadVerified: false,
      parityVerified: false,
      fallbackVerified: true,
      productionReadbackVerified: false,
      approvedRelease: null
    },
    holdReasons: [
      'publisher does not consume an approved FreePass Data release',
      'release-bound F01 delivery receipt is not verified'
    ]
  },
  {
    consumerId: 'google-sheets-f86',
    project: 'Google Sheets F86',
    repository: 'freepass-creator/freepasserp4',
    domains: ['catalog'],
    stage: 'OBSERVE',
    activeReadOwner: 'freepasserp5-publication-snapshot',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_F86_READ_MODE',
    evidence: {
      contractReady: true,
      authenticationVerified: false,
      legacyReadVerified: true,
      freepassReadVerified: false,
      parityVerified: false,
      fallbackVerified: true,
      productionReadbackVerified: false,
      approvedRelease: null
    },
    holdReasons: [
      '2026-10-08 user decision: F86 is supplier-managed input, not an active product publication target; this registration retains historical migration evidence only',
      'historical F86 delivery evidence must not authorize current publication or consumer cutover'
    ]
  }
];

function requiredEvidence(target: ConsumerCutoverStage): (keyof ConsumerCutoverEvidence)[] {
  switch (target) {
    case 'LEGACY_DIRECT': return [];
    case 'OBSERVE': return ['legacyReadVerified'];
    case 'SHADOW_READ': return [
      'contractReady',
      'authenticationVerified',
      'legacyReadVerified',
      'freepassReadVerified'
    ];
    case 'PARITY_VERIFIED': return [
      'contractReady',
      'authenticationVerified',
      'legacyReadVerified',
      'freepassReadVerified',
      'parityVerified'
    ];
    case 'FREEPASS_DATA_READ': return [
      'contractReady',
      'authenticationVerified',
      'legacyReadVerified',
      'freepassReadVerified',
      'parityVerified',
      'fallbackVerified',
      'productionReadbackVerified'
    ];
  }
}

export function evaluateConsumerCutover(
  registration: ConsumerSwitchRegistration,
  target: ConsumerCutoverStage
): ConsumerSwitchDecision {
  const currentIndex = ORDER.indexOf(registration.stage);
  const targetIndex = ORDER.indexOf(target);
  const blockers: string[] = [];

  if (currentIndex < 0 || targetIndex < 0) {
    return {
      allowed: false,
      from: registration.stage,
      to: target,
      blockers: ['invalid consumer cutover stage']
    };
  }

  if (targetIndex > currentIndex + 1) {
    blockers.push(`stage skip is forbidden: ${registration.stage} -> ${target}`);
  }

  for (const key of requiredEvidence(target)) {
    if (!registration.evidence[key]) blockers.push(`missing evidence: ${key}`);
  }

  if (targetIndex >= ORDER.indexOf('PARITY_VERIFIED')) {
    const release = registration.evidence.approvedRelease;
    if (!release) {
      blockers.push('missing evidence: approvedRelease');
    } else {
      const requiredReleaseFields: (keyof ApprovedReleaseEvidence)[] = [
        'projectionId',
        'releaseId',
        'manifestId',
        'inputDigest',
        'dataDigest',
        'observedAt'
      ];
      for (const key of requiredReleaseFields) {
        if (!release[key]?.trim()) blockers.push(`invalid approvedRelease: ${key}`);
      }
      if (release.observedAt && Number.isNaN(Date.parse(release.observedAt))) {
        blockers.push('invalid approvedRelease: observedAt');
      }
      if (
        target === 'FREEPASS_DATA_READ' &&
        release.projectionId === 'sheet-publication-bridge'
      ) {
        blockers.push('migration bridge release cannot authorize final cutover');
      }
    }
  }

  if (targetIndex >= ORDER.indexOf('PARITY_VERIFIED') && registration.holdReasons.length > 0) {
    blockers.push(...registration.holdReasons.map((reason) => `HOLD: ${reason}`));
  }

  return {
    allowed: blockers.length === 0,
    from: registration.stage,
    to: target,
    blockers
  };
}

export function findConsumerSwitch(consumerId: string) {
  return CONSUMER_SWITCH_REGISTRY.find((item) => item.consumerId === consumerId) ?? null;
}
