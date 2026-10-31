import type { EstimateNewcarMasterRecord, EstimateMasterOption, EstimateMasterColor, EstimateMasterMoney } from './estimate-master.js';
import type { OperationalMasterDocument } from './estimate-operational-source.js';

export const OPERATIONAL_ESTIMATE_COLLECTIONS = [
  'vehicle_master','vehicle_trim_master','new_car_trim',
  'vehicle_master_source_documents','vehicle_master_normalized_records',
] as const;
export type OperationalEstimateCollection = typeof OPERATIONAL_ESTIMATE_COLLECTIONS[number];
export type OperationalEstimateSourceDocument = OperationalMasterDocument & { collection:OperationalEstimateCollection };
export type OperationalEstimateSourceWitness = {
  collection:OperationalEstimateCollection;
  documentId:string;
  updateTime:{seconds:number;nanoseconds:number};
  dataDigest:string;
};
export type OperationalManufacturerFacts = {
  contract:'estimate-manufacturer-facts/v1';
  sourceDocumentId:string;
  sourceBytesSha256:string;
  additionalSourceDocuments?:Array<{id:string;sha256:string}>;
  /** Top-level fact field/path -> exact primary or additional source document ID. */
  fieldSources?:Record<string,string>;
  maker:string;
  model:string;
  trimName:string;
  modelYear:number;
  basePrice:EstimateMasterMoney;
  priceBefore:EstimateMasterMoney|null;
  priceAfter:EstimateMasterMoney|null;
  priceBasis:string|null;
  options:EstimateMasterOption[];
  exteriorColors:EstimateMasterColor[];
  interiorColors:EstimateMasterColor[];
  physical:{fuel:string;engineCc:number|null;turbo:boolean|null;drivetrain:string|null;seats:number|null;bodyConfiguration:string|null};
};
/** Both documents must be read from existing Data source persistence, not constructed by the caller. */
export type OperationalManufacturerFactsPacket = {
  sourceDocument:OperationalEstimateSourceDocument;
  normalizedDocument:OperationalEstimateSourceDocument;
  normalizedFactsPath:string;
  additionalSourceDocuments?:OperationalEstimateSourceDocument[];
};
export type OperationalEstimateReviewedBinding = {
  productId:string;
  masterId:string;
  trimId:string;
  vehicleModelId:string;
  powertrainId:string;
  modelYearId:string;
  expectedMasterDigest:string;
  expectedTrimDigest:string;
  expectedProductDigest:string;
  manufacturerFactsDigest:string;
  sourceDocumentId:string;
  normalizedDocumentId:string;
  normalizedFactsPath:string;
};
export type OperationalEstimateProductProof = {
  productId:string;
  masterDocumentId:string;
  trimDocumentId:string;
  sourceDocumentId:string;
  normalizedDocumentId:string;
  normalizedFactsPath:string;
  manufacturerFactsDigest:string;
  recordDigest:string;
  additionalSourceDocumentIds:string[];
};
export type OperationalEstimateReleaseProof = {
  contract:'estimate-operational-release-proof/v1';
  authority:'FREEPASS_DATA_OPERATIONAL_VEHICLE_MASTER';
  publicationRevision:number;
  expectedActiveReleaseId:string|null;
  approval:{reviewId:string;reviewedBy:string;reviewedAt:string;expiresAt:string;bindingsDigest:string};
  sourceReadAt:string;
  sourceInputDigest:string;
  documents:OperationalEstimateSourceWitness[];
  products:OperationalEstimateProductProof[];
  reviewedBindings:OperationalEstimateReviewedBinding[];
  dataDigest:string;
};
export type OperationalEstimatePublishGuard = {
  proofDigest:string;
  approvalReviewId:string;
};
export type OperationalEstimatePublicationPlan = {
  contract:'estimate-operational-publication-plan/v1';
  releaseId:string;
  manifestId:string;
  generatedAt:string;
  records:EstimateNewcarMasterRecord[];
  proof:OperationalEstimateReleaseProof;
  inputDigest:string;
  dataDigest:string;
};
