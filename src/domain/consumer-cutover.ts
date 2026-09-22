export type ConsumerCutoverStage =
  | 'LEGACY_DIRECT'
  | 'OBSERVE'
  | 'SHADOW_READ'
  | 'PARITY_VERIFIED'
  | 'FREEPASS_DATA_READ';

export type ConsumerCutoverEvidence = {
  contractReady: boolean;
  authenticationVerified: boolean;
  legacyReadVerified: boolean;
  freepassReadVerified: boolean;
  parityVerified: boolean;
  fallbackVerified: boolean;
  productionReadbackVerified: boolean;
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
    stage: 'SHADOW_READ',
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
      productionReadbackVerified: false
    },
    holdReasons: [
      'FreePass Data consumer runtime is not deployed',
      'ACTIVE Catalog release is empty',
      'shadow latency and parity require production evidence'
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
      productionReadbackVerified: false
    },
    holdReasons: [
      'each registered white-label needs an individual identity and read receipt',
      'tenant exposure parity is not verified'
    ]
  },
  {
    consumerId: 'freepass-admin-catalog',
    project: 'FreePass Admin',
    repository: 'freepass-creator/freepass-admin',
    domains: ['catalog'],
    stage: 'OBSERVE',
    activeReadOwner: 'freepass-admin-development-store',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_ADMIN_CATALOG_READ_MODE',
    evidence: {
      contractReady: true,
      authenticationVerified: false,
      legacyReadVerified: false,
      freepassReadVerified: false,
      parityVerified: false,
      fallbackVerified: false,
      productionReadbackVerified: false
    },
    holdReasons: [
      'Admin projection PR is not integrated',
      'Policy parity and production persistence are not verified'
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
      productionReadbackVerified: false
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
      productionReadbackVerified: false
    },
    holdReasons: [
      'catalog input contract is not implemented',
      'quote calculation and provider ownership must remain in Estimate'
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
      productionReadbackVerified: false
    },
    holdReasons: ['publisher does not consume an approved FreePass Data release']
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
      productionReadbackVerified: false
    },
    holdReasons: ['publisher does not consume an approved FreePass Data release']
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

  if (targetIndex > currentIndex + 1) {
    blockers.push(`stage skip is forbidden: ${registration.stage} -> ${target}`);
  }

  for (const key of requiredEvidence(target)) {
    if (!registration.evidence[key]) blockers.push(`missing evidence: ${key}`);
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
