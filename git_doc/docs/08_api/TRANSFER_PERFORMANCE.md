# BF03/BF04 read performance — 17 November 2026

Source: user reports slow online database loading across relocation and inter-warehouse transfers. Optimizations preserve permissions, assigned-warehouse scope, decimal arithmetic, partial-trip/reversal history and all transactional write validation. No schema, index, migration, shared-database write or remote rollout.

## Availability selection

BF04 stock options use `freeQuantities` in `src/shared/utils/stock-availability-read.js`, a read-only selection helper. It reads reservations, open/draft/partial transfer orders and active defect holds in parallel, then the relevant orders' ledger transactions. Data are grouped by balance, task and line. Reservation-backed pending quantities are subtracted once, partial ledger quantities are deducted from pending, and resolved hold amounts retain existing semantics.

Before: `freeQuantity` performs six queries per balance; stock options invoked it for every balance concurrently. After: at most four availability queries per request regardless of balance count (three without pending orders, zero for no balances). A synthetic 1,000-balance query-budget test verifies this bound and compares results with the existing scalar helper. This is a query-count result, not an online latency benchmark.

The transaction helpers in `stock.js` and every posting/create/confirm command remain unchanged. Never use the read-side result to bypass source versions, locks, reservations, capacity, ownership/quality, quantity caps or independent receiver checks.

## Options and detail payloads

18/11/2026: BF03 projected item details additionally include optional `packagingState` so mixed sealed/loose plans retain their category in details, edit, confirmation and history. It adds no database query; options reuse the existing packaging breakdown. Transactional stock helpers now support the narrowly scoped explicit LOOSE split in the [BF03 contract](location-movements/README.md#mixed-sealed-cartons-and-loose-pieces--18-november-2026); other read optimizations do not bypass posting checks.

`GET /api/warehouse-transfers/options` accepts optional `mode=stock|locations`, default `stock`. `locations` still requires `stock_transfer:read` and warehouse access, and returns the normal envelope with warehouses/sourceWarehouseIds/locations; holdingPoints, balances, batches, products, units and conversions are empty arrays. It never queries stock. FE uses this for destination put-away locations. Unknown modes are rejected. Existing calls without mode keep stock selection behavior.

Both BF03/BF04 warehouse option catalogues select only `_id/code/name/isActive`, excluding layout3d snapshots and other unused master fields. BF04 deduplicates sorted current conversions using a Set instead of repeated scans. BF03 unit reads use compact projections. No field used by the paired FE selection forms is removed.

BF03's display-only [source packaging overview](location-movements/README.md#source-packaging-breakdown--17-november-2026) additionally selects `packagingPortions.sealedPackCount` and `packagingPortions.quantityBase` in its existing balance query. The FE sums real sealed counts and OPEN/LOOSE quantities without new queries, conversion-derived carton counts or a schema change. BF04's balance projection remains unchanged.

BF04 detail reads independent requirements, approvals, differences, transit points and effective receipt quantities in parallel after request authorization; task and transit balance reads then run in parallel. BF03 detail resolves display references alongside ledger reads and searches product/lot references in parallel. Empty lists avoid unnecessary display-reference queries. These reads do not run parallel operations on a MongoDB write transaction/session.

`GET /warehouse-transfers/dispatches/:id` validates the parent request's authorized scope directly and reads only that dispatch's transit balances for receipt limits. It no longer calls the full transfer-detail expansion or enumerates all scoped requests. Sales still receives not-found; unauthorized parent scope still receives not-found. Independent sender/receiver, assigned destination, permission and workflow checks remain unchanged. Transit totals use indexed Maps while retaining exact decimal arithmetic.

## Frontend

- Only approved requests with source dispatch permission/access load stock options. Completed/cancelled/rejected/read-only detail views do not load source stock.
- Destination options use `mode=locations`, only for approved requests with receiver permission/access. They do not load destination balances or conversion history.
- BF03 presentation indexes products, lots, locations, holding points and conversions with Maps; ledger totals are grouped by line once. Decimal totals, first/latest conversion precedence and packaging restrictions remain unchanged.
- Existing RTK mutation invalidation, explicit command refresh, version conflicts and uncertain-command retry are retained. No global stock cache or longer stale-stock TTL is introduced.

## Field projections — 17 November 2026

Source: user requested reading only fields actually consumed. `movement-read-fields.js` defines inclusion projections used by BF03/BF04 read services. MongoDB excludes unused fields before returning records to Node; trimming is not limited to frontend presentation.

BF03 list, BF04 request list and BF04 dispatch list accept `view=summary|full` (optional, default `full`). Summary rows contain `_id`/derived `id`, documentNo, workflowStatus, createdAt, the relevant header warehouse IDs and authorized catalogue warehouse labels. They omit items, version, creator and execution metadata. Paired FE tables and the receivable-dispatch picker request summary; detail endpoints still provide versions and the line data needed for edits/commands. Counts, filters, ordering, pagination and warehouse facets are unchanged. Excel callers keep the default full view, including product/lot snapshots, units, entered/base quantities and conversion factors. Full is a projected read DTO, not an unrestricted persisted document.

Option queries project location identity/type/allocatability, holding-point identity/location/type, balance identity/version/quantity/quality/owner/packaging state, product and lot labels/units/carton factors, and conversion identity/product/batch/unit/factor. Warehouse layout snapshots, unused product attributes, complete packaging measurements and other unused master metadata are excluded. All active products remain selectable in BF04; this change does not restrict requested products to currently available stock.

Detail queries retain document identity/state/version/creator/date, required warehouse/source links, reasons, line IDs/snapshots/units/quantities, carton factors and operational location/balance references. Related ITR/task/discrepancy/approval reads have separate projections; approval reviewed-content and authority snapshots are not loaded by the transfer screen. BF03 ledger reads retain time, operation, performer and source-line quantities, and performer lookup reads only ID/full name. Effective receipt/reversal totals load transaction IDs, reversal links and source-line quantities only, and skip empty inputs. Stored evidence, audit records and posting command reads are unchanged; these read projections must not be reused by transactional write commands.

Deploy the paired BE query validation/projections and FE summary/mode callers together. Synthetic projection tests assert omitted fields really disappear while quantities, versions, packaging and warehouse scope remain valid. No online latency reduction is claimed from these fixtures.

## Verification and rollout limits

Tests compare batch/scalar availability, partial execution, covered reservations and resolved holds; verify a constant query budget for 1,000 balances; check locations-only scope/payload and stock-query absence; verify scoped transfer detail progress. FE tests cover the completed-request skip behavior plus existing relocation, transfer, receipt and 3D flows. Exact results are in [change log](../../change_logs.md).

Deploy the paired BE mode validation/service and FE caller together. No index installation is required. Online p50/p95, `explain('executionStats')` and index existence have not been measured in this task. The isolated localhost replica set on port 27018 was unavailable, so transaction integration tests are not claimed as passed. Remote indexes must be reviewed against execution plans before rollout; do not run `syncIndexes` or change production data as a performance experiment.
