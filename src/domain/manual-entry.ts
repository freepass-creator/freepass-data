import type {
  ActorRef,
  CommercialType,
  DepositState,
  Money
} from './catalog.js';

export type ManualPriceTermInput = {
  termMonths: number;
  monthlyRent: Money;
  depositState: DepositState;
  deposit?: Money | null;
  mileageLimitKmPerYear?: number | null;
};

export type ManualCatalogEntry = {
  carNumber?: string | null;
  maker: string;
  model: string;
  subModel?: string | null;
  trimName?: string | null;
  commercialType: CommercialType;
  supplierId: string;
  fuelType?: string | null;
  mileageKm?: number | null;
  driveType?: string | null;
  seats?: number | null;
  priceTerms: ManualPriceTermInput[];
};

export type ManualCatalogEntryCommand = {
  commandId: string;
  idempotencyKey: string;
  entry: ManualCatalogEntry;
  actor: ActorRef;
  reason: string;
};

export type ManualCatalogEntryReceipt = {
  idempotencyKey: string;
  commandId: string;
  status: 'SOURCE_ACCEPTED';
  requestDigest: string;
  sourceId: string;
  sourceRecordId: string;
  runId: string;
  candidateId: string;
  sourceFingerprint: string;
  acceptedAt: string;
};
