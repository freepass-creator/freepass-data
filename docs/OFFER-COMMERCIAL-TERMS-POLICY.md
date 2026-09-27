# Offer Commercial Terms Policy

Status: comparison branch proposal  
Branch: `work/data/offer-commercial-policy-20260927`

## Problem

A product is not commercially usable from a monthly rent alone. Each active offer needs a coherent set of:

- default annual mileage
- rental period
- monthly rent for each period/mileage variant
- deposit state and amount
- a linked policy that explains the default and exceptions

The existing Catalog already preserves `PriceTerm` facts and a generic `Policy`, but it does not provide one deterministic answer to:
"Which mileage is the default for this offer, which price row is the default row, and which facts still need a business decision?"

This layer answers that question without creating a second price source of truth.

## Authority boundary

1. **Price amount authority stays in Offer.priceTerms.**
2. **Default mileage authority comes only from the linked Policy.fact `annual_mileage`.**
3. A term-level `mileageLimitKmPerYear` is an explicit variant/override. It is never overwritten.
4. Deposit amount authority stays in the term. Policy prose or notes are not converted into money.
5. Missing or ambiguous facts become decision items. They are never converted to zero or guessed defaults.
6. This resolver is read/decision logic only. It does not write Canonical Catalog data.

## Resolution rules

### Default mileage

- linked policy + positive integer `annual_mileage` -> KNOWN default mileage
- missing policy link -> `DEFAULT_MILEAGE_POLICY_REQUIRED`
- linked policy missing `annual_mileage` -> `DEFAULT_MILEAGE_REQUIRED`
- zero, negative, decimal, string, or other invalid value -> `INVALID_POLICY_ANNUAL_MILEAGE`

A value of `0` is **not** interpreted as unlimited mileage.

### Mileage variants

For each term:

- explicit term mileage -> preserve it
- no term mileage + known policy default -> inherit policy default
- neither -> `MILEAGE_REQUIRED:<termKey>`

For every offered duration, a known default mileage must have a matching price row.
If not, emit `DEFAULT_MILEAGE_PRICE_MISSING:<months>`.

This means, for example, 24-month / 20,000 km and 24-month / 30,000 km remain two rows.
If policy says 20,000 km is the default, the 20,000 km row is marked `isDefault=true`.

### Deposit

- `KNOWN` requires a positive KRW amount
- `ZERO` requires an explicit KRW zero amount
- `NOT_APPLICABLE` requires no amount
- `UNKNOWN` becomes `DEPOSIT_REQUIRED:<termKey>`

Contradictions are INVALID rather than silently repaired.

This branch intentionally does **not** implement "monthly rent x N", percentage-of-vehicle-price, or prose-derived deposit formulas until a separate typed canonical rule is approved.

## Status

Each resolved offer is one of:

- `READY`: default mileage, default price coverage, mileage, rent and deposit facts are coherent
- `NEEDS_DECISION`: facts are missing but not contradictory
- `INVALID`: canonical facts contradict each other

The summary function counts unresolved items by decision code so Control Tower/Admin can surface a finite policy work queue.

## Recommended business workflow

1. ingest raw supplier/product/policy evidence
2. canonicalize Offer + Policy with lineage
3. run commercial terms resolver
4. show `NEEDS_DECISION` rows in Admin/Control Tower
5. a human or approved policy command resolves the missing canonical fact
6. rebuild projection
7. expose only `READY` offers to downstream consumer products that require complete commercial terms

## Deliberate non-goals

- no second vehicle master
- no second price table
- no direct Firebase access
- no source-note parsing into money
- no automatic canonical writes
- no assumption that every supplier uses the same deposit formula
