# Iancar source capture

## Contract

`src/adapters/iancar-source-capture.ts` extends the existing immutable ERP5 capture pattern for two
independent upstreams. One bundle contains the Iancar ERP raw response, its vehicle/rate evidence, and
the complete raw CSV of both fixed Google Sheet tabs (`이안카`, `이안카 재렌트`). A SHA-256 digest covers
the entire bundle. Failure of either Sheet tab fails the run instead of producing a partial success.
ERP failure also rejects the whole Promise. ERP raw, parsed vehicle list, and parsed rate list have separate
digests plus a required parser version so derivation drift is visible.

This is `REUSE_WITH_ADAPTER`: the ERP5 capture's immutable evidence/digest pattern is reused, while a
new adapter is necessary because Iancar has no cross-system transaction and has two independent sources.

## Non-volatile boundary

`persistIancarCapture()` saves each bundle with exclusive-create semantics under
`~/.codex/private/freepass-data-iancar-captures/<runId>/capture.json` and verifies the digest after readback.
There is no caller-selected output path and no overwrite. The existing append-only RAW store is the later
operational destination after authorization. Neither inspection nor mapping overwrites an earlier capture.
The collector must provide source revision, observation time, full-collection evidence, and separate ERP
rate coverage. Collection success alone does not prove freshness.

ERP and Google Sheets cannot be read in one cross-system transaction. Every bundle therefore declares
`crossSourceConsistency=NON_ATOMIC`; its digest proves bundle integrity, not simultaneous source state.
Downstream freshness/parity review must account for the independent observation times.
The digest covers the exact captured representation and is intentionally order-sensitive; it is not a
semantic equality hash across independently serialized provider responses.

The local private file is plaintext and is only a preparation/evidence boundary. UUID naming and file modes
are not encryption or a complete Windows ACL/retention policy. Long-term operational storage must use the
authorized encrypted append-only RAW store with explicit access and retention controls.

The existing authenticated `/api/inventory` path contains inventory facts but does not establish complete
rental-rate coverage. Until the ERP rate source is captured and `rateCoverageComplete=true` is supported by
evidence, pricing remains `HOLD`. Google Sheet prices do not silently replace missing ERP rate evidence.

This module imports no Firebase client or canonical writer. No Firebase writes, Sheet writes, Canonical writes,
publication, or consumer cutover are authorized by this unit.
