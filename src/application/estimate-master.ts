import {
  buildEstimateNewcarMasterRecord,
  uncoveredEstimateMasterIssues,
  type EstimateMasterCandidate,
  type EstimateNewcarMasterRecord,
} from '../domain/estimate-master.js';

export { buildEstimateNewcarMasterRecord, type EstimateMasterCandidate } from '../domain/estimate-master.js';

export function buildEstimateNewcarMaster(
  candidates: readonly EstimateMasterCandidate[]
): EstimateNewcarMasterRecord[] {
  const records = candidates.map(buildEstimateNewcarMasterRecord);
  const issues = uncoveredEstimateMasterIssues(records);
  if (issues.length) {
    throw new Error(`ESTIMATE_MASTER_SET_INVALID:${issues.map((issue) => issue.code).join(',')}`);
  }
  return records;
}


export {
  selectVehiclesFromNewcarMaster as selectEstimateNewcarMaster,
} from './vehicle-selector-adapters.js';
