# Vehicle Master assist — observation-order retry regression

Date: 2026-09-25 (KST)
Scope: assistance to the existing Vehicle Master session; PR #51 only.
Status: CODED / FOCUSED TESTED. Full-suite, Firestore persistence and deployment verification remain HOLD.

## Recovery checkpoint

- Repository: `freepass-creator/freepass-data`
- Branch: `work/gpt/vehicle-master-ingestion-20260925`
- Inspected baseline: `838f514ce10fae1fbddb3af98e771feafc3c68f0`
- Regression tests: `7cb818dab3892f40f5ac44779f941433604d2bab`
- Implementation fix: `35beb7503a4647454db8566bd56a96a07990567b`
- Existing PR #49/#50/#51 stack preserved. No replacement branch or duplicate PR.
- Chat-session/platform failure itself was not diagnosed; this is a persisted code recovery checkpoint, not a claim that the chat UI was repaired.

The prior Claude finding about CREATED versus UNCHANGED outcome payloads was already fixed in `e5768e1`. Claude's later PR comment reports `npm run check` exit 0 / 340 PASS / 4 skipped at **baseline `838f514`**, not at the new commits above. Do not reuse that result as acceptance for this patch.

## Reproduced remaining defect

`persistPromotionEvidence` sorted observations for `observationDigest` (and hence deterministic record IDs), but wrote the original unsorted observations into immutable `CANDIDATE_FACT.payload`.

For a fixed proposal, source, policy, reference state and observedAt:

1. Promote with observations A,B.
2. Retry with the exact same observations in order B,A.
3. The record ID stays the same but the payload hash changes.
4. The real MemoryVehicleMasterStore rejects the candidate with `VEHICLE_MASTER_DETERMINISTIC_ID_COLLISION:CANDIDATE_FACT:...` before the canonical retry.

This was reproduced separately for node, price and compatibility-rule promotion. In addition, conflicting values with the same field/source had no tie-breaker in their observation sort; reversing these generated different evidence identities rather than one stable HOLD result.

## Minimal fix

Use one copied, canonical observation array for both the digest and the immutable candidate payload. Sort by fieldPath, sourceDocumentId, then stable value digest. Preserve contradictory observations; do not discard them or weaken evidence/HOLD gates. Caller arrays are not mutated.

Only `src/application/vehicle-master-ingestion.ts` production code changed, in the shared evidence persistence helper. The existing outcome-replay fix, source authority, temporal checks, canonical revision checks and immutable collision protection are unchanged.

## Actual validation performed

The source files were retrieved through the connected GitHub API. Their local Git blob SHAs were checked against the exact baseline before execution:

| File | Baseline blob |
| --- | --- |
| ingestion | `5f55e69da5f0f05b1ec1f631685e4c793e4647df` |
| domain | `fa188ce4be4a82ad28bb85e9203d0d27abfb3768` |
| memory store | `9afdfd18b9cf6baa772b0e4eb3be4f260e6c1bbf` |
| store port | `343cddf6c85d860cc9437bfb5e5b802569a3c7c3` |
| stable digest | `096c1b8395059db7c04609959372f828974604dc` |

New test file: `tests/vehicle-master-observation-order.test.ts`.

Nine regression cases cover the three successful reordered retries; the three contradictory same-field/source HOLD retries; changed evidence not replayed as approval; exact retry preserving the CREATED outcome; and rejection of tampered immutable payloads. The successful-retry cases also check stable IDs, unchanged original evidence/outcome/event records and no caller-array mutation.

Local execution used Node v22.16.0 with TypeScript transpilation. Because repository dependencies could not be installed in this runtime (GitHub DNS resolution failed), only the test-runner import was changed locally from `vitest` to `node:test`; the same test callbacks/assertions ran against the actual production domain, ingestion and MemoryVehicleMasterStore modules. The committed test retains its Vitest import.

- Baseline + new test callbacks: **3 PASS / 6 FAIL**.
- Patched source + identical callbacks: **9 PASS / 0 FAIL / 0 skipped**.
- Focused production-module strict TypeScript check (`noUncheckedIndexedAccess`, NodeNext): exit 0.
- Same test bodies checked with native Node test typings: exit 0.
- Transpilation diagnostics: 0 errors.
- Remote readback verified fixed ingestion blob `779c31521714b96c7d667d3ac4f063dd25b5529e` and test blob `62c5b17dce33e25310828e8147111dcb818a189a` against the locally tested files.

These are **focused native-runner tests**, not a fresh full Vitest or `npm run check` result. No mocked Firebase result or production persistence claim is being made.

## Resume / remaining HOLDs

1. Run `npx vitest run tests/vehicle-master-observation-order.test.ts`, then `npm run check` on the current exact PR head using the repository's installed dependencies.
2. Verify the same immutable evidence cases through the Firestore emulator before claiming PERSISTENCE VERIFIED.
3. Pre-patch persisted candidates with unsorted payloads are not silently rewritten. An immutable mismatch on pre-existing data remains a review/migration HOLD; this patch does not authorize deleting or overwriting history.
4. This regression fixes reordered observations at a fixed observedAt and fixed decision context. Retries with changed timestamps, policy/reference state or interrupted multi-record writes are separate recovery cases, not verified by these nine tests.
5. Continue the original Vehicle Master source/pilot work after these gates. FreePass Data retains master-data ownership; no Estimate calculation or UI scope was absorbed.

No main merge, production Firebase/Storage writes, deployment, IAM changes, schedule changes, workflow activation or RTDB use occurred in this assistance packet.
