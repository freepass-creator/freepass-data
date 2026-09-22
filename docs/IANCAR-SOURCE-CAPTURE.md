# Iancar source capture

## Contract

`src/adapters/iancar-source-capture.ts` extends the existing immutable ERP5 capture pattern for two
independent upstreams. One bundle contains the Iancar ERP raw response, its vehicle/rate evidence, and
the complete raw CSV of both fixed Google Sheet tabs (`이안카`, `이안카 재렌트`). A SHA-256 digest covers
the entire bundle. Failure of either Sheet tab fails the run instead of producing a partial success.

This is `REUSE_WITH_ADAPTER`: the ERP5 capture's immutable evidence/digest pattern is reused, while a
new adapter is necessary because Iancar has no cross-system transaction and has two independent sources.

## Non-volatile boundary

`persistIancarCapture()` saves each bundle with exclusive-create semantics under
`~/.codex/private/freepass-data-iancar-captures/<runId>/capture.json` and verifies the digest after readback.
There is no caller-selected output path and no overwrite. The existing append-only RAW store is the later
operational destination after authorization. Neither inspection nor mapping overwrites an earlier capture.
The collector must provide source revision, observation time, full-collection evidence, and separate ERP
rate coverage. Collection success alone does not prove freshness.

The existing authenticated `/api/inventory` path contains inventory facts but does not establish complete
rental-rate coverage. Until the ERP rate source is captured and `rateCoverageComplete=true` is supported by
evidence, pricing remains `HOLD`. Google Sheet prices do not silently replace missing ERP rate evidence.

No Firebase writes, Sheet writes, Canonical writes, publication, or consumer cutover are authorized by this unit.
