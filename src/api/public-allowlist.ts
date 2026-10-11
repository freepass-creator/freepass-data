import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };

const rawSupplierChannels = spec.supplierChannels as {
  sharedInputSheet?: Array<{ code?: unknown }>;
  notInSharedSheet?: Array<{ code?: unknown }>;
  excludedFromSharedSheet?: Array<{ code?: unknown }>;
};

const providerPattern = /^(?:RP|PT-)\d+$/;
const whitelistSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const codesFrom = (items: Array<{ code?: unknown }> | undefined): string[] =>
  (items ?? []).map((item) => item.code).filter((code): code is string =>
    typeof code === 'string' && providerPattern.test(code));

export const PUBLIC_PROVIDER_ALLOWLIST = Object.freeze([
  ...new Set([
    ...codesFrom(rawSupplierChannels.sharedInputSheet),
    ...codesFrom(rawSupplierChannels.notInSharedSheet),
    ...codesFrom(rawSupplierChannels.excludedFromSharedSheet),
  ]),
].sort());

export const PUBLIC_WHITELABEL_ALLOWLIST = Object.freeze([
  'uniplan',
  'freepassmobility',
  'haheoho',
  'eancar',
  'chashoong',
  'krautoplan',
  'withautoplan',
  'ksautoplan',
  'carping',
  'siauto',
].sort());

class PublicAllowlistConfigError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

const parseEnvSubset = (name: string, base: readonly string[], pattern: RegExp): Set<string> => {
  if (base.length === 0) throw new PublicAllowlistConfigError(`${name}_BASE_EMPTY`);
  const baseSet = new Set(base);
  const raw = process.env[name];
  if (raw === undefined) return baseSet;
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new PublicAllowlistConfigError(`${name}_EMPTY`);
  const out = new Set<string>();
  for (const value of values) {
    if (!pattern.test(value)) throw new PublicAllowlistConfigError(`${name}_INVALID`);
    if (!baseSet.has(value)) throw new PublicAllowlistConfigError(`${name}_OUTSIDE_CODE_CONSTANT`);
    out.add(value);
  }
  if (out.size === 0) throw new PublicAllowlistConfigError(`${name}_EMPTY`);
  return out;
};

export const publicProviderAllowlist = (): Set<string> =>
  parseEnvSubset('FREEPASS_PUBLIC_PROVIDER_ALLOWLIST', PUBLIC_PROVIDER_ALLOWLIST, providerPattern);

export const publicWhitelabelAllowlist = (): Set<string> =>
  parseEnvSubset('FREEPASS_PUBLIC_WHITELABEL_ALLOWLIST', PUBLIC_WHITELABEL_ALLOWLIST, whitelistSlugPattern);

export const assertPublicAllowlistsConfigured = (): void => {
  publicProviderAllowlist();
  publicWhitelabelAllowlist();
};
