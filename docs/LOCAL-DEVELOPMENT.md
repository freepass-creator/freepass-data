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
- Price command: `POST /v1/commands/offers/offer_gv70_demo/price`

Stop with Ctrl+C. Restarting resets demo data.

The API and `npm run worker:memory` each own a separate memory store. Running
both does **not** connect the worker to API commands. For the local Console only,
the API processes the price command's outbox event after Canonical commit so the
same in-memory ACTIVE projection refreshes immediately. Firestore/production
delivery remains worker-owned.

`preview/index.html` is served by the memory runtime as a local live Console.
Its remaining screens still contain design-sample data. Production authentication,
Firebase binding, and consumer rollout remain outside this local setup, and the
Console route returns 404 outside memory mode.

## Verification recorded on 2026-09-21

- Architecture check and TypeScript build passed.
- All 48 tests passed across 8 files.
- Live memory API: health and one demo product read succeeded; price command
  returned revision 2; identical replay returned the same receipt; stale revision
  returned 409; invalid command returned 400.
- Live Console loaded the ACTIVE release, changed monthly rent, displayed the
  command receipt, refreshed the Offer revision and Release ID, and preserved
  operator input on a simulated stale-revision conflict.
- Loopback listener confirmed even with inherited Firestore/any-interface settings.
- Compiled native ESM API (`node dist/src/api/server.js`) health check passed;
  the isolated memory worker also started without errors.
- In-app browser navigation was blocked with `ERR_BLOCKED_BY_CLIENT`; HTTP checks
  above are API verification, not visual Console verification.

## Independent review

Cursor's read-only review agreed with the launcher, optional Firebase property,
and evidence-staging fixture changes. It flagged `addFormats.default` as a
potential compiled-ESM startup failure. The installed, locked `ajv-formats`
explicitly exports `default = formatsPlugin`; both tsx and compiled native ESM
startup passed. The suggested fallback was therefore not applied.
Claude review was attempted but unavailable due to its weekly usage limit.
