# FreePass Data Architecture v2 — Implementation Baseline

Status: **APPROVED FOR IMPLEMENTATION — CATALOG V1**  
Approved source: Google Doc `FreePass Data 아키텍처 v2 — CATALOG V1 구현 승인본`  
Date: 2026-09-20

This file records the approved implementation baseline in GitHub so repository work does not fall back to the older v1 proposal.

## Mission

FreePass Data is the central data platform for the FreePass product family.

It owns:

- source ingestion and immutable RAW evidence
- normalization and validation
- Canonical SSOT
- field authority, revision and command receipts
- lineage and audit
- durable outbox
- consumer projections
- atomic projection releases
- migration/shadow controls
- stable data-serving contracts

It does not absorb the business workflow ownership of Admin, Sales or Estimate.

## Approved Catalog V1 flow

`Source -> RAW -> Normalized Candidate -> Canonical -> Projection -> Release -> Consumer`

## Approved Catalog V1 model

Core entities:

- VehicleModel
- VehicleAsset
- Product
- Offer
- PriceTerm
- Policy

Optional fact structures such as RateTable/PricingInputSet preserve supplier-provided calculation inputs. They do not become the Estimate calculation engine.

## Write path

`Authentication -> Authorization -> Writer/Field Authority -> Expected Revision -> Schema Validation -> Domain Validation -> Transaction -> Revision -> Audit -> Durable Outbox`

Last-write-wins is not the default.

## Migration

Read migration is evidence-driven and uses legacy-authoritative Change Mirror during Shadow.

Application-level dual write is not the default migration mechanism.

## Runtime shape

Catalog V1 remains a TypeScript modular monolith. Firestore is isolated behind repository/port contracts.

No Kafka, generic event bus, mandatory external search engine, microservice split, or AI automatic canonical commit is required for V1.

## Repository implementation map

See [REPO-STRUCTURE.md](./REPO-STRUCTURE.md).

## Supersession

`FREEPASS-DATA-IMPLEMENTATION-ARCHITECTURE-v1.md` is retained as design history only. It is not the current implementation authority.
