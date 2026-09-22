import { DATA_ASSETS, DATA_DOMAINS, searchDataCatalog } from '../domain/data-domain-catalog.js';

const query = process.argv.slice(2).join(' ').trim();
const result = query ? searchDataCatalog(query) : {
  domains: [...DATA_DOMAINS],
  assets: [...DATA_ASSETS]
};

console.log(JSON.stringify({
  query: query || null,
  domainCount: result.domains.length,
  assetCount: result.assets.length,
  domains: result.domains,
  assets: result.assets
}, null, 2));
