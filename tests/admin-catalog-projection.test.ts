import { describe, expect, it } from 'vitest';
import { buildAdminCatalogProjection } from '../src/application/admin-catalog.js';
import type {
  AdminCatalogProjectionMetadata,
  Offer,
  Policy,
  Product,
  VehicleAsset,
  VehicleModel,
} from '../src/domain/catalog.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';

const actor={id:'test',kind:'SERVICE' as const};
const now='2026-09-21T00:00:00.000Z';
const meta={
  schemaVersion:'1.0.0',
  revision:1,
  validationStatus:'VALID' as const,
  createdAt:now,
  updatedAt:now,
  createdBy:actor,
  updatedBy:actor,
  lineageId:'lin-test',
};

function fixtures(){
  const model:VehicleModel={
    ...meta,
    id:'vm-1',
    maker:'현대',
    model:'싼타페',
    generation:'5세대',
    subModel:'MX5',
    trim:'캘리그래피',
    fuel:'하이브리드',
    drive:'AWD',
    seats:6,
    displayName:'현대 싼타페 MX5 캘리그래피',
  };
  const asset:VehicleAsset={
    ...meta,
    id:'va-1',
    vehicleModelId:model.id,
    status:'AVAILABLE',
    plateNumber:'123하4567',
    vin:'VIN-1',
    odometerKm:21000,
  };
  const product:Product={
    ...meta,
    id:'prd-1',
    vehicleModelId:model.id,
    vehicleAssetId:asset.id,
    commercialType:'USED_RENT',
    status:'ACTIVE',
    displayName:model.displayName,
  };
  const policyA:Policy={
    ...meta,
    id:'policy-a',
    kind:'OTHER',
    version:'2026-09',
    effectiveFrom:'2026-09-01T00:00:00.000Z',
    facts:{
      basic_driver_age:21,
      deposit_card_payment:true,
      pay_method:['CARD','TRANSFER'],
    },
  };
  const policyB:Policy={
    ...meta,
    id:'policy-b',
    kind:'OTHER',
    version:'2026-09',
    effectiveFrom:'2026-09-01T00:00:00.000Z',
    facts:{
      basic_driver_age:26,
    },
  };
  const offerA:Offer={
    ...meta,
    id:'offer-a',
    productId:product.id,
    supplierId:'supplier-a',
    status:'ACTIVE',
    policyId:policyA.id,
    priceTerms:[
      {
        termKey:'36_2만',
        termMonths:36,
        monthlyRent:{amount:920000,currency:'KRW'},
        deposit:{amount:0,currency:'KRW'},
        depositState:'ZERO',
        mileageLimitKmPerYear:20000,
      },
      {
        termKey:'48_2만',
        termMonths:48,
        monthlyRent:{amount:850000,currency:'KRW'},
        depositState:'UNKNOWN',
        mileageLimitKmPerYear:20000,
      },
    ],
  };
  const offerB:Offer={
    ...meta,
    id:'offer-b',
    productId:product.id,
    supplierId:'supplier-b',
    status:'ACTIVE',
    policyId:policyB.id,
    priceTerms:[{
      termKey:'36_3만',
      termMonths:36,
      monthlyRent:{amount:900000,currency:'KRW'},
      deposit:{amount:1000000,currency:'KRW'},
      depositState:'KNOWN',
      mileageLimitKmPerYear:30000,
    }],
  };
  return{model,asset,product,policyA,policyB,offerA,offerB};
}

describe('Admin Catalog projection',()=>{
  it('preserves multi-supplier Offer boundaries, unknown deposits and typed policies',async()=>{
    const store=new MemoryDataStore();
    const f=fixtures();
    await store.seed({
      vehicleModels:[f.model],
      vehicleAssets:[f.asset],
      products:[f.product],
      offers:[f.offerA,f.offerB],
      policies:[f.policyA,f.policyB],
    });

    const release=await buildAdminCatalogProjection(store,store,now);
    const metadata=release.metadata as AdminCatalogProjectionMetadata;

    expect(release.projectionId).toBe('admin-catalog');
    expect(release.status).toBe('ACTIVE');
    expect(metadata.policyParity).toBe('COMPLETE');
    expect(metadata.missingPolicyOfferIds).toEqual([]);
    expect(metadata.invalidPolicyFactRefs).toEqual([]);
    expect(release.data).toHaveLength(1);

    const product=release.data[0]!;
    expect(product.vehicleModel.generation).toBe('5세대');
    expect(product.vehicleModel.subModel).toBe('MX5');
    expect(product.vehicleAsset?.vin).toBe('VIN-1');
    expect(product.offers.map((offer)=>offer.supplierId)).toEqual(['supplier-a','supplier-b']);

    const a=product.offers.find((offer)=>offer.offerId==='offer-a')!;
    expect(a.priceTerms[1]?.depositState).toBe('UNKNOWN');
    expect(a.priceTerms[1]?.deposit).toBeUndefined();
    expect(a.policyValues).toContainEqual({
      policyId:'basic_driver_age',
      type:'NUMBER',
      value:21,
    });
    expect(a.policyValues).toContainEqual({
      policyId:'deposit_card_payment',
      type:'BOOLEAN',
      value:true,
    });
    expect(a.policyValues).toContainEqual({
      policyId:'pay_method',
      type:'MULTI_SELECT',
      value:['CARD','TRANSFER'],
    });
  });

  it('activates a shadowable release but marks policy parity incomplete when an Offer has no canonical Policy',async()=>{
    const store=new MemoryDataStore();
    const f=fixtures();
    const noPolicy={...f.offerA,policyId:undefined};
    await store.seed({
      vehicleModels:[f.model],
      vehicleAssets:[f.asset],
      products:[f.product],
      offers:[noPolicy],
      policies:[],
    });

    const release=await buildAdminCatalogProjection(store,store,now);
    const metadata=release.metadata as AdminCatalogProjectionMetadata;

    expect(release.status).toBe('ACTIVE');
    expect(metadata.policyParity).toBe('INCOMPLETE');
    expect(metadata.missingPolicyOfferIds).toEqual(['offer-a']);
    expect(release.data[0]?.offers[0]?.policyValues).toEqual([]);
  });

  it('marks typed policy mismatch incomplete instead of coercing human text into a number',async()=>{
    const store=new MemoryDataStore();
    const f=fixtures();
    const badPolicy:Policy={
      ...f.policyA,
      facts:{basic_driver_age:'만 21세 이상'},
    };
    await store.seed({
      vehicleModels:[f.model],
      vehicleAssets:[f.asset],
      products:[f.product],
      offers:[f.offerA],
      policies:[badPolicy],
    });

    const release=await buildAdminCatalogProjection(store,store,now);
    const metadata=release.metadata as AdminCatalogProjectionMetadata;

    expect(metadata.policyParity).toBe('INCOMPLETE');
    expect(metadata.invalidPolicyFactRefs).toContain('policy-a:basic_driver_age');
    expect(release.data[0]?.offers[0]?.policyValues).toEqual([]);
  });
});
