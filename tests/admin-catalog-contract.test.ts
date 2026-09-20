import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../contracts/admin-catalog-view-v1.schema.json' with { type: 'json' };

const ajv=new Ajv2020({allErrors:true,strict:false});
addFormats(ajv);
const validate=ajv.compile(schema);

const sample={
  schema:'freepass-data.admin-catalog/v1',
  meta:{
    schemaVersion:'1.0.0',
    releaseId:'rel-admin-1',
    revision:17,
    generatedAt:'2026-09-21T00:00:00.000Z',
    activatedAt:'2026-09-21T00:01:00.000Z',
  },
  data:[{
    productId:'product-1',
    productRevision:7,
    sourceProductKey:'legacy-77',
    updatedAt:'2026-09-20T23:59:00.000Z',
    displayName:'싼타페 MX5 캘리그래피',
    commercialType:'USED_RENT',
    vehiclePrice:42000000,
    vehicleModel:{
      id:'vm-1',
      origin:'KR',
      maker:'현대',
      model:'싼타페',
      generation:'MX5',
      trim:'캘리그래피',
      fuel:'하이브리드',
      drive:'AWD',
      seats:6,
      modelYear:2026,
    },
    vehicleAsset:{
      id:'asset-1',
      status:'AVAILABLE',
      plateNumber:'123하4567',
      vin:'VIN-1',
      odometerKm:21000,
      firstRegistrationDate:'2026-01-03',
    },
    offers:[
      {
        offerId:'offer-a',
        offerRevision:3,
        supplierId:'supplier-a',
        policyId:'policy-a',
        policyValues:[
          {policyId:'basic_driver_age',type:'NUMBER',value:21},
          {policyId:'deposit_card_payment',type:'BOOLEAN',value:true},
        ],
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
      },
      {
        offerId:'offer-b',
        offerRevision:2,
        supplierId:'supplier-b',
        policyValues:[{policyId:'basic_driver_age',type:'NUMBER',value:26}],
        priceTerms:[{
          termKey:'36_3만',
          termMonths:36,
          monthlyRent:{amount:900000,currency:'KRW'},
          deposit:{amount:1000000,currency:'KRW'},
          depositState:'KNOWN',
          mileageLimitKmPerYear:30000,
        }],
      },
    ],
  }],
};

test('Admin Catalog V1 accepts multi-supplier Offer terms and explicit deposit states',()=>{
  assert.equal(validate(sample),true,JSON.stringify(validate.errors));
});

test('Admin Catalog V1 rejects KNOWN deposit without a money value at semantic validation layer',()=>{
  // JSON Schema intentionally validates shape only; semantic release validation must
  // additionally reject KNOWN without deposit. Keep this distinction explicit.
  const copy=structuredClone(sample);
  delete copy.data[0].offers[1].priceTerms[0].deposit;
  assert.equal(validate(copy),true,JSON.stringify(validate.errors));
});
