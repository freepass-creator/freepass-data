# Offer Commercial Terms Policy

Status: comparison branch proposal  
Branch: `work/data/offer-commercial-policy-20260927`

## Core commercial unit

The commercial row is:

`term + mileage + monthly rent + deposit`

Monthly rent and deposit are not independent consumer rows. They belong to the same term/mileage variant.
A deposit policy may be shared across an offer, but its **resolved deposit amount** is attached to each commercial row.

This preserves cases where one deposit rule produces different amounts as monthly rent, duration, mileage or another policy input changes.

## Authority boundary

1. Price and resolved deposit facts stay in `Offer.priceTerms`.
2. Default mileage authority comes from linked Policy fact `annual_mileage`.
3. A term-level `mileageLimitKmPerYear` remains an explicit variant and is never overwritten.
4. A future typed deposit calculation rule belongs to Policy; the resulting amount belongs to the matching PriceTerm.
5. Deposit handling such as return timing, card payment or installment eligibility is a contract condition, not the deposit amount.
6. Missing or ambiguous facts become decision items and are never guessed.
7. This resolver does not create a second price table or a second vehicle master.

## Deposit semantics

Current canonical values:
- `KNOWN`: explicit positive KRW amount
- `ZERO`: explicit zero
- `NOT_APPLICABLE`: no deposit applies
- `UNKNOWN`: business/policy decision still required

The branch intentionally does not invent a formula such as "monthly rent × N" or "vehicle price × percentage" until the ERP5 policy source exposes a typed, reviewed authority for that rule.

Once such a policy is approved:
1. policy rule is stored as Policy
2. rule is evaluated against the matching term inputs
3. resulting deposit is materialized/validated against that term
4. ERP and Sheets receive term + rent + deposit together

## Mileage variants

For each term:
- explicit term mileage -> preserve it
- no term mileage + known policy default -> inherit default
- neither -> decision required

For every offered duration, a known default mileage should have a matching price row.

## Status

- `READY`: term/mileage/rent/deposit and required policy facts are coherent
- `NEEDS_DECISION`: required facts are missing
- `INVALID`: canonical facts contradict each other

## Recommended consumer shape

ERP/Sheet projection:
- vehicle
- rentalTerms (term + mileage + monthlyRent + deposit)
- policy
- contractConditions

This is a projection over Canonical facts, not a new source of truth.
