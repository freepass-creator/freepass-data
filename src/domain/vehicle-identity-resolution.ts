/**
 * Name authority: active Data vehicle_master / vehicle_trim_master.
 * F03 is a projection and never an identity input. Only known aliases can select a record.
 */
import { canonicalVehicleMakerName } from './vehicle-maker-name.js';
export type VehicleIdentity = readonly [maker: string, model: string, subModel: string, trimName: string];
export type VehicleIdentitySpecs = { fuel?: string | null; displacementCc?: number | null; drive?: string | null; seats?: number | null; modelYear?: number | null };
export type VehicleMasterRecord = { masterId: string; trimId: string; names: VehicleIdentity; aliases: string[][];
  specs?: VehicleIdentitySpecs; modelYearStart?: number | null; modelYearEnd?: number | null };
/** Native document IDs verified against one sealed snapshot, never a name-derived reference hash. */
export type VehicleMasterReference = {
  state: 'KNOWN'; authority: 'FREEPASS_DATA_VEHICLE_MASTER';
  identityKind: 'FIRESTORE_DOCUMENT_ID'; masterId: string; trimId: string;
  snapshotDigest: string; readAt: string;
};
export type IdentityChoice =
  | { pick: 'DATA' | 'SHEET'; identity: VehicleIdentity; dataIdentity: VehicleIdentity | null; notes: string[]; masterId: string; trimId: string }
  | { pick: 'HOLD'; identity: null; dataIdentity: VehicleIdentity | null; notes: string[] };
export const VEHICLE_IDENTITY_RULE_VERSION = 'data-master-identity/3';
const text = (v: string) => v.trim();
export function indexVehicleMaster(records: VehicleMasterRecord[]) {
  const match = (identity: VehicleIdentity, specs?: VehicleIdentitySpecs): VehicleMasterRecord | null => {
    const hits = records.filter(r => r.names.every((name, i) => {
      const value = i === 0 ? canonicalVehicleMakerName(text(identity[i]!)) : text(identity[i]!);
      return value === name || r.aliases[i]?.includes(value) || (i === 0 && value === canonicalVehicleMakerName(name));
    }));
    // Same visible name with multiple immutable trim IDs is not a unique choice.
    const compatible = hits.filter(r => !specs || Object.entries(specs).every(([key, value]) => {
      if (value == null) return false; // supplied but invalid is not missing evidence
      if (key === 'modelYear') return typeof value === 'number' && typeof r.modelYearStart === 'number' &&
        typeof r.modelYearEnd === 'number' && value >= r.modelYearStart && value <= r.modelYearEnd;
      return r.specs?.[key as keyof VehicleIdentitySpecs] === value;
    }));
    return compatible.length === 1 ? compatible[0]! : null;
  };
  return { records, match };
}
export type VehicleMasterIndex = ReturnType<typeof indexVehicleMaster>;
export function chooseVehicleIdentity(master: VehicleMasterIndex, input: {
  sheet: VehicleIdentity; data: VehicleIdentity | null; raw: string; firstRegistration: string; modelYear: string; specs?: VehicleIdentitySpecs
}): IdentityChoice {
  const data = input.data ? master.match(input.data, input.specs) : null;
  const sheet = master.match(input.sheet, input.specs);
  const dataIdentity = data?.names ?? null;
  // The normalizer supplies the already parsed registration date; do not infer MY from it.
  const yearMismatch = typeof input.specs?.modelYear === 'number' && /^20\d{2}-/.test(input.firstRegistration) &&
    Number(input.firstRegistration.slice(0, 4)) !== input.specs.modelYear;
  const hold = (...notes: string[]): IdentityChoice => ({ pick: 'HOLD', identity: null, dataIdentity,
    notes: [...notes, ...(yearMismatch ? ['YEAR_REGISTRATION_MISMATCH'] : [])] });
  if (input.specs && Object.values(input.specs).some(value => value == null)) return hold('SOURCE_SPEC_REVIEW_REQUIRED');
  const nonMatchReason = (identity: VehicleIdentity, fallback: string) => {
    const named = input.specs && master.match(identity);
    if (!named) return fallback;
    const unavailable = Object.keys(input.specs!).some(key => key === 'modelYear'
      ? named.modelYearStart == null || named.modelYearEnd == null
      : named.specs?.[key as keyof VehicleIdentitySpecs] == null);
    return unavailable ? 'MASTER_SPEC_EVIDENCE_REQUIRED' : 'SOURCE_SPEC_MASTER_CONFLICT';
  };
  // Missing aliases or contradictory names remain unresolved, never a guessed basic trim.
  if (input.data && !data) return hold(nonMatchReason(input.data, 'DATA_NOT_UNIQUE_MASTER'));
  if (data && sheet && data.trimId !== sheet.trimId) return hold('DATA_SHEET_MASTER_CONFLICT');
  if (data && !sheet && input.sheet.some((value, i) => value.trim() &&
      ![data.names[i], ...(data.aliases[i] ?? [])].includes(i === 0 ? canonicalVehicleMakerName(value.trim()) : value.trim()))) {
    return hold('DATA_SHEET_MASTER_CONFLICT');
  }
  const selected = data ?? sheet;
  if (!selected) return hold(nonMatchReason(input.sheet, 'IDENTITY_NOT_UNIQUE_MASTER'));
  if (yearMismatch) return hold();
  // Explicit powertrain tokens in supplier evidence cannot silently select the opposite known sibling.
  const name = selected.names.slice(1).join(' ');
  const siblings = master.records.filter(r => r.names[0] === selected.names[0] && r.names[1] === selected.names[1]);
  for (const [tag, rx] of [['HYBRID', /하이브리드|HEV|E-?TECH|(^|[^A-Z])ECH([^A-Z]|$)/i], ['ELECTRIC', /전기|(^|[^A-Z])EV([^A-Z]|$)/i]] as const) {
    const fuelMatches = tag === 'HYBRID' ? ['하이브리드', '플러그인하이브리드', '플러그인 하이브리드'].includes(selected.specs?.fuel ?? '')
      : selected.specs?.fuel === '전기';
    if (rx.test(input.raw) && !rx.test(name) && (selected.specs && !fuelMatches ||
        siblings.some(r => rx.test(r.names.slice(1).join(' '))))) {
      return hold(tag + '_SOURCE_CONFLICT');
    }
  }
  return { pick: data ? 'DATA' : 'SHEET', identity: selected.names, dataIdentity,
    masterId: selected.masterId, trimId: selected.trimId, notes: [] };
}
