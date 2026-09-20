# Catalog V1 Field Authority

Status: **IMPLEMENTED BASELINE**  
Scope: Catalog V1

Field Authority is a semantic write gate. It does not replace authentication, Firebase IAM, or service-account authorization.

## Rule dimensions

Each protected field rule defines:

- domain
- aggregate
- field path
- semantic owner
- allowed commands
- allowed writers
- approval policy
- conflict policy
- override policy
- effective-time policy
- source-refresh behavior

## First enforced rule

`offer.priceTerms.*.monthlyRent`

- semantic owner: `catalog-pricing`
- command: `UPDATE_OFFER_PRICE`
- user operator: allowed at the semantic layer
- service writer IDs: `service:freepass-data`, `service:freepass-admin`
- conflict: `EXPECTED_REVISION`
- override: `DISALLOWED`
- effective time: `IMMEDIATE`
- source refresh: `PRESERVE_CANONICAL_AND_REVIEW`

Unknown fields, unknown commands, and unregistered service writers fail closed.

## Security boundary

The current API still accepts an `actor` value in the command payload. Therefore the Field Authority layer must not be described as authentication or IAM enforcement.

The later security/IAM work must derive the actor/service identity from authenticated runtime credentials and pass that verified identity into the same authority check.

This separation is intentional:

`Authentication/IAM → verified ActorRef → Field Authority → Domain Validation → Transaction`
