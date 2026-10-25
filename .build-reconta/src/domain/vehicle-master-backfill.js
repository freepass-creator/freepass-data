export const VEHICLE_MASTER_BACKFILL_SOURCES = [
    {
        key: 'MANUFACTURER',
        sourceType: 'MANUFACTURER_OFFICIAL',
        sourceName: 'Manufacturer official',
        discoveryUrl: null,
        priority: 100,
        currentCoverage: true,
        historicalCoverage: 'RECENT',
        discoveryOnly: false,
        countsAsCanonicalCorroboration: true,
    },
    {
        key: 'CARNOON',
        sourceType: 'CARNOON',
        sourceName: 'Carnoon',
        discoveryUrl: 'https://www.carnoon.co.kr/newcar/search',
        priority: 80,
        currentCoverage: true,
        historicalCoverage: 'RECENT',
        discoveryOnly: false,
        countsAsCanonicalCorroboration: true,
    },
    {
        key: 'DANAWA',
        sourceType: 'DANAWA',
        sourceName: 'Danawa Auto',
        discoveryUrl: 'https://auto.danawa.com/newcar/',
        priority: 75,
        currentCoverage: true,
        historicalCoverage: 'RECENT',
        discoveryOnly: false,
        countsAsCanonicalCorroboration: true,
    },
    {
        key: 'CARISYOU',
        sourceType: 'CARISYOU',
        sourceName: 'CarIsYou',
        discoveryUrl: 'https://www.carisyou.com/car/',
        priority: 70,
        currentCoverage: true,
        historicalCoverage: 'DEEP',
        discoveryOnly: false,
        countsAsCanonicalCorroboration: true,
    },
    {
        key: 'WIKICAR',
        sourceType: 'WIKICAR',
        sourceName: 'WikiCar discovery',
        discoveryUrl: null,
        priority: 30,
        currentCoverage: false,
        historicalCoverage: 'DEEP',
        discoveryOnly: true,
        countsAsCanonicalCorroboration: false,
    },
];
export function vehicleMasterBackfillPolicy(key) {
    const policy = VEHICLE_MASTER_BACKFILL_SOURCES.find((item) => item.key === key);
    if (!policy)
        throw new Error(`VEHICLE_MASTER_BACKFILL_SOURCE_UNKNOWN:${key}`);
    return policy;
}
