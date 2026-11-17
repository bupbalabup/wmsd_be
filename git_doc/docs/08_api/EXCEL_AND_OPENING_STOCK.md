# Excel exports and opening stock

Implemented 16 November 2026 following the user's request to add list exports and Owner-accessible file import. Latest explicit user decision on 16 November 2026: only Owner may use opening-stock import and may confirm their own draft; initialization succeeds only once per warehouse. This supersedes H36's former Warehouse preparer / different Owner verifier rule for opening stock only. One-time initialization, stock history and all other workflow separation-of-duties rules remain in effect. No remote rollout was requested.

## Excel export contract

The frontend uses ExcelJS 4.4.0, loaded on demand, to generate real `.xlsx` workbooks. Existing authenticated list APIs remain authoritative for permissions, warehouse scope, filters and financial redaction. Export starts at page 1 and fetches all matching pages with the original filters and ordering. Any failed page or repeated record aborts the entire export. Results above 100,000 records are rejected with a request to narrow the filters; they are never silently truncated. Paged exports are read over multiple requests, not a database snapshot; concurrent changes can require retrying.

Workbooks contain Vietnamese headings, frozen headings, automatic filters and a metadata sheet with UTC export time and filter parameters. Document codes and formula-like strings remain literal strings. Quantities with at most 15 significant digits become numeric cells; higher-precision quantities remain text to avoid Excel rounding. Products with different units are never summed. Movement exports retain both endpoints; document items are separate rows. Only an explicit display-field allowlist is exported, not arbitrary JSON, credentials, evidence or permission data.

Coverage: products, lots, suppliers, UOMs, warehouses, locations, inventory, stock movements, replenishments, purchase orders, inspections, goods receipts, awaiting put-away queue, put-away tasks, custody receipts, transfers, relocations, sales orders, outbound deliveries, picking tasks, customer returns, supplier returns, failed deliveries, defects, external references and operational reports. Stocktake list export and detail reconciliation export are separate. Reconciliation export is unavailable in PLANNED/COUNTING and uses the frozen snapshot and selected/latest counts after reconciliation becomes visible. Missing counts remain distinct from confirmed zero.

The existing `/issue-requests` and `/adjustments` screens still use their existing local stores. Their exports use the full filtered local list, and do not establish backend integration for those legacy screens. Existing operational report CSV export remains available alongside Excel. The inventory report remains a current transaction snapshot; historical date-range stock reconstruction is outside this change. Administrative account/role exports are outside the agreed operational scope.

## Opening-stock routes and permissions

Frontend routes: `/opening-stocks` and `/opening-stocks/:id`, under Kho & hàng hóa. Direct-route and sidebar access require the Owner role and `opening_stock:read`. All opening-stock APIs also enforce the Owner role, even if another role retains stale or custom permission grants. Options expose `warehouses[].initialized`; initialized warehouse choices are disabled, and import controls are hidden when all available warehouses are initialized.

| API | Permission / behavior |
| --- | --- |
| GET `/api/opening-stocks/options` | read; scoped active warehouses, category/unit codes for the template |
| GET `/api/opening-stocks` | read; scoped documents |
| GET `/api/opening-stocks/:id` | read plus warehouse scope; display labels for items |
| POST `/api/opening-stocks/preview` | create; validate only, no writes |
| POST `/api/opening-stocks` | create; atomically create a draft and any explicitly validated new catalogue records |
| POST `/api/opening-stocks/:id/post` | post; Owner may confirm their own draft; atomically record all opening stock once per warehouse |
| POST `/api/opening-stocks/:id/cancel` | create; only the creator may cancel a DRAFT |

Default role: OWNER only for `opening_stock:read`, `opening_stock:create` and `opening_stock:post`. Active user, current role/permission and warehouse scope are checked server-side, including replay. Admin has no automatic business authority. Creating products or batches additionally requires `product:create` / `product_lot:create`; Warehouse Staff, Sales, Accountant, Admin and custom roles cannot use opening stock even if granted its permission codes. A single Owner can upload, review, save and confirm their own draft. The user's explicit correction is the authority for this opening-stock exception.

All responses use the existing `{data: ...}` envelope. Commands require `idempotencyKey`; post/cancel also require `expectedVersion` and nonblank `reason`. Same actor/key/payload replays the committed receipt, and a changed payload conflicts. Unknown network outcomes retain the exact pending request in the frontend for retry. POSTED documents are immutable; corrections follow existing stocktake/reversal rules. Cancellation does not delete newly created catalogue records.

## File and payload

The UI downloads an `.xlsx` template with `TonDau`, `HuongDan`, `NhomSanPham` and `DonVi` worksheets. Upload is processed in the browser; only validated row JSON goes to the API. Limit: 5 MB compressed file, 1,000 rows and the existing Express JSON body limit of 1 MB. Exact Vietnamese headings and column order are required. Formula cells, special cell types and unsafe numeric cells are rejected; use text for identifiers and precise decimals. The original workbook is not uploaded or retained as evidence.

Preview/create body: `warehouseId`, `openingAt` (UTC ISO, entered in Vietnam time in the UI), `cutoverKey`, `sourceDescription`, `confirmEmpty`, `rows[]`; the opening date cannot be in the future. Create also adds `idempotencyKey`.

Each row requires explicit `sku`, `manufacturerCode`, `color`, `manufacturerLot`, `locationCode`, `enteredUnit`, positive decimal string `enteredQty`, `qualityStatus` (GOOD/PENDING/DAMAGED/BLOCKED) and `packagingState` (SEALED/OPEN/LOOSE). New products additionally require name, an existing `categoryCode`, an existing `baseUnit` and positive `lengthMm`, `widthMm`, `heightMm`. Optional `wholeBaseUnits` is the string `true`/`false`, default true for new products. New batches require positive integer `piecesPerCarton` and positive `cartonLengthMm`, `cartonWidthMm`, `cartonHeightMm`. OPEN/LOOSE portions require positive `measuredVolumeMm3` for the whole imported portion. Rows referring to existing catalogue identities may omit their creation fields; supplied conflicting values are rejected.

Identity is manufacturer + SKU + color and then manufacturer lot under that product. There is no fuzzy name matching or silent replacement of existing records. Product/batch creation, versioned auto-conversions, draft and audit records commit together. Preview performs the same catalogue, quantity, location and aggregate capacity checks without creating records. Quantities use base units or configured carton units only; fractional base units are rejected when `wholeBaseUnits` is true. Area rounding is not used to invent opening pieces. SEALED quantities must match complete cartons. DAMAGED stock requires QUARANTINE. Missing dimensions and occupied volume beyond capacity fail.

Warehouses, storage locations, categories and units must already exist; use the existing setup screens. This import covers STORE-owned physical stock. Custody, transit, open orders and reservations require a separate source/obligation reconciliation and are not silently imported as store-owned quantities. The workbook instructions make that boundary explicit.

## Posting and persistence

Existing `opening_stocks` documents use TDK document IDs allocated in the existing transaction. DRAFT → POSTED or CANCELLED. `header` keeps warehouse, `openingImportSource=FILE`, cutover, opening time, all covered locations, source description, preparer/time and verifier/version/note. Items keep stable IDs, product/batch/location, quality/ownership and historical unit/packaging snapshots. This change adds optional item `packagingState` and `measuredVolumeMm3` for exact opening packaging. Legacy documents remain readable.

A partial unique index on `header.warehouseId` applies to POSTED documents with `header.openingImportSource=FILE`, enforcing one file import per warehouse regardless of `cutoverKey` while leaving historical opening documents readable. The local setup replaces the earlier broader POSTED-warehouse index when present. The service also refuses an import if the warehouse already has any POSTED opening document, so historical initialization cannot be counted twice. Existing zero/nonzero inventory or transit balances block initialization. All covered locations must still match the draft; active bins and warehouse must be usable and unfrozen. Shared `guardWarehouses` increments `warehouses.stockOperationVersion` without changing catalogue `updatedAt`. Shared ordinary stock commands and storage-location edits use the same guard, preventing ordinary receipts/new bins from racing initialization; location guards still enforce freeze/capacity. The counter trades additional warehouse-level write contention for safe initialization. No new collection or business relationship was introduced.

Posting revalidates product/batch identity, preserves the accepted conversion snapshot and atomically updates balances, packaging portions, OPENING stock transaction/movements, document status, operation receipt, audit and outbox. `occurredAt` uses the opening date while `recordedAt` records actual posting time. An empty warehouse requires explicit confirmation, creates a POSTED opening document and no zero-quantity stock transaction, and cannot be initialized again. Uploaded data and a draft do not change stock. Capacity/freeze/version failures roll back the complete stock posting.

## Existing-database setup and validation

See [local setup instructions](../09_phat_trien/EXCEL_OPENING_SETUP.md). Model registration has auto-index creation disabled: apply the file-import index and additive permission grants before exposing the feature on an existing database. The setup script checks duplicate or unscoped POSTED file imports, replaces only the earlier known POSTED-warehouse index, removes only opening-stock grants from non-Owner roles, preserves unrelated existing/custom grants and never seeds or clears business data. No real or remote database was changed in this implementation task.

Verification and known project failures are recorded with the dated entry in [change_logs](../../change_logs.md). New tests cover real workbook round trips, literal formulas/precision, full pagination and failed-page rejection, file parsing, preview without writes, catalogue rollback, Owner self-confirmation, rejection of non-Owner roles with stale grants, role changes on replay, replay/payload conflict, duplicate/empty initialization, freeze and concurrent posts on an isolated localhost replica set.
