/** Internal source-derived facts; evidence is private and must not enter public projections/logs. */
export type SourceVehicleFact = {
  value: string | number | null;
  state: 'KNOWN' | 'MISSING' | 'REVIEW_REQUIRED';
  evidence: string;
  ruleVersion: string;
  reasons: string[];
};
export type SourceVehicleFacts = {
  ruleVersion: string;
  fields: Record<string, SourceVehicleFact>;
  reasons: string[];
};
