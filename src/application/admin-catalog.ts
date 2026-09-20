import { randomUUID } from 'node:crypto';
import type {
  AdminCatalogProduct,
  AdminCatalogProjectionMetadata,
  AdminPolicyValue,
  Offer,
  Policy,
  ProjectionRelease,
} from '../domain/catalog.js';
import type { CatalogStore, ProjectionStore } from '../ports/catalog-store.js';

const MONEY_KEYS=new Set([
  'mileage_upcharge_per_10000km',
  'additional_driver_cost',
  'age_lowering_cost',
  'succession_fee',
  'own_damage_min_deductible',
  'own_damage_max_deductible',
  'self_body_deductible',
  'property_deductible',
  'injury_deductible',
  'over_mileage_rate_domestic',
  'over_mileage_rate_imported',
  'over_mileage_rate_per_km',
]);
const PERCENT_KEYS=new Set([
  'early_termination_rate_under1y',
  'early_termination_rate_over1y',
  'own_damage_repair_ratio',
  'late_fee_rate',
]);
const NUMBER_KEYS=new Set([
  'accident_termination_count',
  'deposit_return_days',
  'auto_terminate_overdue_days',
  'basic_driver_age',
  'driver_age_lowering',
  'driver_age_upper_limit',
  'annual_mileage',
  'max_annual_mileage',
]);
const BOOL_KEYS=new Set([
  'deposit_card_payment',
  'deposit_installment',
  'succession_allowed',
  'maintenance_service',
  'insurance_included',
]);

function activeOffer(offer:Offer,now:string){
  if(offer.status!=='ACTIVE'||offer.validationStatus==='INVALID')return false;
  if(offer.validFrom&&offer.validFrom>now)return false;
  if(offer.validUntil&&offer.validUntil<=now)return false;
  return true;
}

function activePolicy(policy:Policy,now:string){
  if(policy.validationStatus==='INVALID')return false;
  if(policy.effectiveFrom&&policy.effectiveFrom>now)return false;
  if(policy.effectiveTo&&policy.effectiveTo<=now)return false;
  return true;
}

function typedFact(
  policyId:string,
  key:string,
  raw:unknown,
):{value?:AdminPolicyValue;invalid?:string}{
  const ref=policyId+':'+key;

  if(BOOL_KEYS.has(key)){
    return typeof raw==='boolean'
      ?{value:{policyId:key,type:'BOOLEAN',value:raw}}
      :{invalid:ref};
  }
  if(MONEY_KEYS.has(key)){
    return typeof raw==='number'&&Number.isFinite(raw)
      ?{value:{policyId:key,type:'MONEY',value:raw}}
      :{invalid:ref};
  }
  if(PERCENT_KEYS.has(key)){
    return typeof raw==='number'&&Number.isFinite(raw)
      ?{value:{policyId:key,type:'PERCENTAGE',value:raw}}
      :{invalid:ref};
  }
  if(NUMBER_KEYS.has(key)){
    return typeof raw==='number'&&Number.isFinite(raw)
      ?{value:{policyId:key,type:'NUMBER',value:raw}}
      :{invalid:ref};
  }

  if(typeof raw==='boolean')return{value:{policyId:key,type:'BOOLEAN',value:raw}};
  if(typeof raw==='number'&&Number.isFinite(raw))return{value:{policyId:key,type:'NUMBER',value:raw}};
  if(typeof raw==='string')return{value:{policyId:key,type:'TEXT',value:raw}};
  if(Array.isArray(raw)&&raw.every((item)=>typeof item==='string')){
    return{value:{policyId:key,type:'MULTI_SELECT',value:[...raw]}};
  }
  return{invalid:ref};
}

function policyValues(
  offer:Offer,
  policyById:Map<string,Policy>,
  now:string,
):{values:AdminPolicyValue[];missing:boolean;invalid:string[]}{
  const policyId=offer.policyId?.trim();
  if(!policyId)return{values:[],missing:true,invalid:[]};

  const policy=policyById.get(policyId);
  if(!policy||!activePolicy(policy,now))return{values:[],missing:true,invalid:[]};

  const values:AdminPolicyValue[]=[];
  const invalid:string[]=[];
  for(const [key,raw] of Object.entries(policy.facts)){
    const mapped=typedFact(policy.id,key,raw);
    if(mapped.value)values.push(mapped.value);
    if(mapped.invalid)invalid.push(mapped.invalid);
  }
  values.sort((a,b)=>a.policyId.localeCompare(b.policyId));
  return{values,missing:values.length===0,invalid};
}

export async function buildAdminCatalogProjection(
  catalog:CatalogStore,
  projections:ProjectionStore,
  now=new Date().toISOString(),
):Promise<ProjectionRelease<AdminCatalogProduct>>{
  const [models,assets,products,offers,policies]=await Promise.all([
    catalog.listVehicleModels(),
    catalog.listVehicleAssets(),
    catalog.listProducts(),
    catalog.listOffers(),
    catalog.listPolicies(),
  ]);

  const modelById=new Map(models.map((value)=>[value.id,value]));
  const assetById=new Map(assets.map((value)=>[value.id,value]));
  const policyById=new Map(policies.map((value)=>[value.id,value]));
  const offersByProduct=new Map<string,Offer[]>();
  for(const offer of offers.filter((value)=>activeOffer(value,now))){
    const rows=offersByProduct.get(offer.productId)??[];
    rows.push(offer);
    offersByProduct.set(offer.productId,rows);
  }

  const missingPolicyOfferIds:string[]=[];
  const invalidPolicyFactRefs:string[]=[];
  const data:AdminCatalogProduct[]=[];

  for(const product of products){
    if(product.status!=='ACTIVE'||product.validationStatus==='INVALID')continue;
    const model=modelById.get(product.vehicleModelId);
    if(!model||model.validationStatus==='INVALID')continue;

    const asset=product.vehicleAssetId?assetById.get(product.vehicleAssetId):undefined;
    if(product.vehicleAssetId&&!asset)continue;
    if(asset&&asset.status!=='AVAILABLE')continue;

    const projectedOffers=(offersByProduct.get(product.id)??[]).map((offer)=>{
      const policy=policyValues(offer,policyById,now);
      if(policy.missing)missingPolicyOfferIds.push(offer.id);
      invalidPolicyFactRefs.push(...policy.invalid);
      return{
        offerId:offer.id,
        offerRevision:offer.revision,
        supplierId:offer.supplierId,
        ...(offer.policyId!==undefined?{policyId:offer.policyId}:{}),
        policyValues:policy.values,
        priceTerms:structuredClone(offer.priceTerms),
      };
    });

    if(!projectedOffers.length)continue;

    data.push({
      productId:product.id,
      productRevision:product.revision,
      updatedAt:product.updatedAt,
      displayName:product.displayName,
      commercialType:product.commercialType,
      vehicleModel:{
        id:model.id,
        maker:model.maker,
        model:model.model,
        ...(model.generation!==undefined?{generation:model.generation}:{}),
        ...(model.subModel!==undefined?{subModel:model.subModel}:{}),
        ...(model.trim!==undefined?{trim:model.trim}:{}),
        ...(model.fuel!==undefined?{fuel:model.fuel}:{}),
        ...(model.drive!==undefined?{drive:model.drive}:{}),
        ...(model.seats!==undefined?{seats:model.seats}:{}),
      },
      ...(asset?{
        vehicleAsset:{
          id:asset.id,
          status:asset.status,
          ...(asset.plateNumber!==undefined?{plateNumber:asset.plateNumber}:{}),
          ...(asset.vin!==undefined?{vin:asset.vin}:{}),
          ...(asset.odometerKm!==undefined?{odometerKm:asset.odometerKm}:{}),
        },
      }:{}),
      offers:projectedOffers,
    });
  }

  const metadata:AdminCatalogProjectionMetadata={
    policyParity:missingPolicyOfferIds.length||invalidPolicyFactRefs.length?'INCOMPLETE':'COMPLETE',
    missingPolicyOfferIds:[...new Set(missingPolicyOfferIds)].sort(),
    invalidPolicyFactRefs:[...new Set(invalidPolicyFactRefs)].sort(),
  };
  const canonicalRevision=Math.max(
    0,
    ...models.map((value)=>value.revision),
    ...assets.map((value)=>value.revision),
    ...products.map((value)=>value.revision),
    ...offers.map((value)=>value.revision),
    ...policies.map((value)=>value.revision),
  );
  const release:ProjectionRelease<AdminCatalogProduct>={
    releaseId:'rel_'+randomUUID(),
    projectionId:'admin-catalog',
    schemaVersion:'1.0.0',
    canonicalRevision,
    status:'BUILDING',
    generatedAt:now,
    data,
    metadata,
  };

  await projections.stage(release);
  await projections.markReady(release.releaseId);
  await projections.activate(release.releaseId);
  const active=await projections.getActive<AdminCatalogProduct>('admin-catalog');
  if(!active)throw new Error('Admin Catalog projection activation failed');
  return active;
}
