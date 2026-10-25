import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };
const rawSupplierChannels = spec.supplierChannels;
const providerPattern = /^(?:RP|PT-)\d+$/;
const whitelistSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const publicSingleQueryValue = (value, code = 'PUBLIC_QUERY_INVALID') => {
    if (value === undefined)
        return undefined;
    if (Array.isArray(value) || value === '')
        throw Object.assign(new Error(code), { statusCode: 400 });
    return value;
};
const codesFrom = (items) => (items ?? []).map((item) => item.code).filter((code) => typeof code === 'string' && providerPattern.test(code));
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
    code;
    constructor(code, message = code) {
        super(message);
        this.code = code;
    }
}
const parseEnvSubset = (name, base, pattern) => {
    if (base.length === 0)
        throw new PublicAllowlistConfigError(`${name}_BASE_EMPTY`);
    const baseSet = new Set(base);
    const raw = process.env[name];
    if (raw === undefined)
        return baseSet;
    const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
    if (values.length === 0)
        throw new PublicAllowlistConfigError(`${name}_EMPTY`);
    const out = new Set();
    for (const value of values) {
        if (!pattern.test(value))
            throw new PublicAllowlistConfigError(`${name}_INVALID`);
        if (!baseSet.has(value))
            throw new PublicAllowlistConfigError(`${name}_OUTSIDE_CODE_CONSTANT`);
        out.add(value);
    }
    if (out.size === 0)
        throw new PublicAllowlistConfigError(`${name}_EMPTY`);
    return out;
};
export const publicProviderAllowlist = () => parseEnvSubset('FREEPASS_PUBLIC_PROVIDER_ALLOWLIST', PUBLIC_PROVIDER_ALLOWLIST, providerPattern);
export const publicWhitelabelAllowlist = () => parseEnvSubset('FREEPASS_PUBLIC_WHITELABEL_ALLOWLIST', PUBLIC_WHITELABEL_ALLOWLIST, whitelistSlugPattern);
export const assertPublicAllowlistsConfigured = () => {
    publicProviderAllowlist();
    publicWhitelabelAllowlist();
};
