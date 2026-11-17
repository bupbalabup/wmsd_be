# Excel and opening-stock local setup

16 November 2026. Source: [API contract](../08_api/EXCEL_AND_OPENING_STOCK.md). No remote rollout or application-data migration was performed.

Frontend checkout for this task: `review-latest-fe`, branch `codex/excel-opening-stock`. Backend: `review-latest-be`, same branch name in the separate repository. Both branches started from the fetched main tips. Install frontend dependencies with `pnpm install --frozen-lockfile`; ExcelJS 4.4.0 is dynamically loaded for import/export. Backend has no new runtime dependency.

## Existing local database

Use the actual local application database name. The following example uses a placeholder; it is not a database changed during this task.

```powershell
node scripts/setup-opening-stock.mjs 'mongodb://127.0.0.1:27017/YOUR_LOCAL_DATABASE?replicaSet=rs0'
node scripts/setup-opening-stock.mjs 'mongodb://127.0.0.1:27017/YOUR_LOCAL_DATABASE?replicaSet=rs0' --apply
```

The first command previews setup. The second adds only the three opening-stock permissions, their Owner-only grants, the unique POSTED-warehouse index and a zero technical stock-operation counter on warehouses missing it. Opening-stock grants are explicitly removed from all non-Owner roles, including old Warehouse or custom-role grants. All unrelated permissions/grants and business data remain intact. Re-run this setup for a local database that installed the earlier opening-stock version. It refuses non-loopback URIs and duplicate/unscoped posted opening documents. Restart the application and sign in again to refresh the session's frontend permissions. Do not use a full permission reseed to install this feature.

Configure the existing frontend API URL and proxy for the chosen local backend. The normal project port is 3334; backend is normally 3000. The implementation's browser verification uses isolated ports and synthetic users instead of the application's production connection.

Create warehouses and storage locations, and ensure categories and units exist. Only Owner can use opening stock and can review and confirm their own draft. Each warehouse can be initialized once; cancelled drafts or failed previews do not consume that one initialization, while an empty POSTED opening does. The preview and template explain all required fields and the custody/transit boundary.

## Isolated automated verification

`test/opening-stock.test.js` never uses `MONGODB_URI`. Its integration case uses a newly named `opening_test_<ObjectId>` database on `127.0.0.1:27119`, replica set `opening-test`, asserts that exact database prefix before dropping only that test database, and retains no store data.

```powershell
$env:RUN_OPENING_TESTS='1'
node --test test/opening-stock.test.js
```

Start a dedicated local MongoDB replica set on that port before running the integration test. Without the flag, unit validation runs and the integration case reports skipped. Frontend verification commands:

```powershell
pnpm test src/features/opening-stock/OpeningStockPage.test.tsx src/app/routeAccess.test.ts src/shared/lib/excel.test.ts src/shared/components/ExcelExportButton.test.tsx src/features/opening-stock/file.test.ts src/features/stocktakes/live.test.tsx src/features/operational-reports/live.test.ts
pnpm typecheck
pnpm build
```

Run `npm run docs:check` in the backend. Keep the difference between isolated transaction tests, component tests and real browser checks explicit in verification notes. Existing project-wide lint/test/UI-script failures are not evidence that the new flow was deployed.
