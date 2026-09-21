# Local development

Working directory: `C:\dev\freepass-data`

Requires Node.js 22 or newer. Verified on Windows with Node.js 24.19.0 and npm 11.17.0.

```powershell
cd C:\dev\freepass-data
npm ci
npm run check
npm run dev
```

`npm run dev` always uses disposable in-memory demo data and listens on
`127.0.0.1:8787`. It overrides inherited `FREEPASS_DATA_DRIVER` and `HOST` values.
No Firebase credentials are needed. Set `PORT` to select another local port.

- Health: `http://127.0.0.1:8787/health`
- Local Console: `http://127.0.0.1:8787/console`
- Demo catalog: `http://127.0.0.1:8787/v1/views/erp-public/products`
- Product evidence trace: `http://127.0.0.1:8787/v1/console/products/prod_gv70_demo/trace`
- Price command: `POST /v1/commands/offers/offer_gv70_demo/price`

Stop with Ctrl+C. Restarting resets demo data.

The API and `npm run worker:memory` each own a separate memory store. Running
both does **not** connect the worker to API commands. For the local Console only,
the API processes the price command's outbox event after Canonical commit so the
same in-memory ACTIVE projection refreshes immediately. Firestore/production
delivery remains worker-owned.

`preview/index.html` is served by the memory runtime as a local live Console.
The Home, Data, Flow Trace, and Release screens use live memory API evidence.
The demo seed includes a complete local Source → RAW → Normalized Candidate →
Canonical → Projection → Release chain. The Flow screen presents one source record
as one list card containing the untouched imported object, the normalized object,
and the exact object exposed by the local consumer API. Field lineage remains in
the trace API as evidence but is not split into separate cards in the Console.
The final consumer boundary stays explicitly `LOCAL_ONLY` until a real consumer
receipt exists. The remaining review
and history screens still contain design-sample data. Production authentication,
Firebase binding, and consumer rollout remain outside this local setup, and the
Console route returns 404 outside memory mode.

## Verification recorded on 2026-09-21

- Architecture check and TypeScript build passed.
- All 53 tests passed across 9 files.
- Live memory API: health and one demo product read succeeded; price command
  returned revision 2; identical replay returned the same receipt; stale revision
  returned 409; invalid command returned 400.
- Live Console loaded the ACTIVE release, changed monthly rent, displayed the
  command receipt, refreshed the Offer revision and Release ID, and preserved
  operator input on a simulated stale-revision conflict.
- Live Flow displayed one record card with imported, normalized, and outgoing
  objects. The imported object retained monthly rent KRW 690,000 while the outgoing
  local API object showed the current KRW 735,000 value.
- Loopback listener confirmed even with inherited Firestore/any-interface settings.
- Compiled native ESM API (`node dist/src/api/server.js`) health check passed;
  the isolated memory worker also started without errors.
- The in-app browser rendered the responsive record card and all three object
  stages successfully; browser warning/error logs were empty.

## Independent review

Cursor's read-only review agreed with the launcher, optional Firebase property,
and evidence-staging fixture changes. It flagged `addFormats.default` as a
potential compiled-ESM startup failure. The installed, locked `ajv-formats`
explicitly exports `default = formatsPlugin`; both tsx and compiled native ESM
startup passed. The suggested fallback was therefore not applied.
Claude review was attempted but unavailable due to its weekly usage limit.
