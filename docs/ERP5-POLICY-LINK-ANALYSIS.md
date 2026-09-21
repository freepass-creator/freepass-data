# ERP5 policy link evidence

## Purpose

`src/adapters/erp5-policy-link-analysis.ts` examines the already captured, read-only
`freepasserp5/firestore/products` and `policy` documents. It reports aggregate evidence only.
It does not return policy codes, document IDs, source values, canonical entities, or writes.
It verifies the capture digest before classification, so changed evidence cannot silently produce a new link report.

An exact match means only that a product `policy_code` occurs as one unique policy document ID,
`_key`, or `policy_code`. It is `exactLinkedForReview`, not an approved canonical link.
Deleted or explicitly inactive policy documents are counted separately. Case or numeric zero-padding
similarity is only `aliasOrZeroPaddingCandidate`; the analyzer never turns it into a link.
Malformed activation/deletion markers also make a policy unusable and route its exact references to
the held `exactInactive` bucket rather than treating it as active.

## HOLD boundaries

- Different document ID, `_key`, and `policy_code` values are identity conflicts until an authority
  rule explains them.
- Duplicate exact identifiers are ambiguous.
- Policy facts are not normalized or interpreted. Mixed source types and field coverage remain evidence
  for the next review, not permission to invent a common policy model.
- The result always denies canonical writes and consumer cutover.
- The private capture stays outside Git. Reports contain counts and capture metadata only.

## Verification

Run the unit tests with `npm test -- --run tests/erp5-policy-link-analysis.test.ts`. A live aggregate may
be produced locally by loading the preserved private capture and passing it to
`analyzeErp5PolicyLinks`; do not commit the capture or emit raw identifiers.
