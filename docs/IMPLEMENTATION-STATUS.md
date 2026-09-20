# FreePass Data — Catalog V1 Implementation Status

Status: **IMPLEMENTATION STARTED**  
Approved scope: **CATALOG V1 ONLY**

## First executable baseline

Implemented:

- TypeScript / Node.js modular-monolith baseline
- JSON Schema contract bundle for VehicleModel / VehicleAsset / Product / Offer / PriceTerm / Policy
- VehicleModel / VehicleAsset separation
- Catalog repository ports
- Memory adapter for credential-free local smoke execution
- Firestore adapter behind the same ports
- Command-based Offer price change
- expectedRevision conflict protection
- idempotency receipt
- append-only audit
- durable outbox
- worker lease / retry / dead-letter state
- ERP Public Projection preserving Offer boundaries
- atomic Release activation pointer
- Fastify read/write API
- demo catalog seed
- tests for idempotency, stale revision, projection semantics and outbox-to-release flow
- pinned AI Core revision manifest

## Local execution

```bash
npm install
npm run check
npm run dev
```

Default driver: `memory`.

Routes:

```
GET  /health
GET  /v1/views/erp-public/products
POST /v1/commands/offers/:offerId/price
```

## Firestore mode

```bash
FREEPASS_DATA_DRIVER=firestore
FIREBASE_PROJECT_ID=...
GOOGLE_APPLICATION_CREDENTIALS=...
```

Firestore is an adapter, not a Domain dependency.

## Next

1. Source registry / RAW snapshot
2. Field Authority registry
3. legacy freepasserp3 read-only adapter
4. Change Mirror checkpoint + shadow comparator
5. price/deposit/model-mapping lineage
6. Console Data Explorer / Entity Detail / Command Edit
7. Firestore indexes/security/IAM review
8. ERP.com pilot consumer

## Explicitly out of scope

- Sales customer/call migration
- Application/Contract migration
- Settlement/Finance migration
- Kafka/Event Bus
- microservice split
- mandatory external search engine
- AI automatic Canonical commit
