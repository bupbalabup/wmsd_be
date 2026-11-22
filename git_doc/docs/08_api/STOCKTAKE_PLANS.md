# Stocktake plans (Kế hoạch kiểm kê) — API contract (22 November 2026)

Decision source: **User decision 22 Nov 2026 following lecturer feedback (separate plan/slip, remove blind count, simplified reconciliation, drop closing reason).** The lecturer asked to separate the recurring *plan* from the *slip* (phiếu) that is actually counted. Before this decision a "plan" was just a `Stocktake` document in status `PLANNED`; that status stays as the slip's pre-activation state. The slip lifecycle and the reconciliation redesign are in [STOCKTAKE_LIFECYCLE.md](STOCKTAKE_LIFECYCLE.md#redesign--22-november-2026-current-contract).

A plan posts **no stock, locks nothing, reserves nothing**. It only remembers *what* to count (warehouse, scope, counters), *how often*, and generates ordinary `PLANNED` slips on request. There is no cron or scheduler: the plan only reports that a period is due (`isDue` / `dueSoon`) and the Owner presses "Tạo phiếu kiểm kê từ kế hoạch". Ad-hoc slips (`POST /api/stocktakes` with no plan) are unchanged and still work.

## Identity and storage

- Collection `stocktake_plans`, Mongoose model `StocktakePlan` (`src/models/stocktake-plan.model.js`, nested `stocktake-plan-header.schema.js`). Registry size goes from 58 to **59** collections.
- Document identity follows [DOCUMENT_IDENTITIES.md](DOCUMENT_IDENTITIES.md): `_id` = `documentNo` = `KHKK-<warehouse code>-YYMMDD-<6 digits>`, e.g. `KHKK-RD-261122-000001`, allocated inside the creating transaction by `nextDocumentFields(..., 'ST_SCHEDULE', ...)`. **Decision:** a plan is a document type (it has a lifecycle, versions, an audit trail and is referenced from slips), so it gets a coded identity and `DocumentIdentity` references; the nested header and scope use plain ObjectIds as for every other document. Slips reference it by `header.planId` (document identity).
- Slips created from a plan carry `header.planId`, `header.planPeriodNo` (0-based) and `header.planPeriodDueAt`. A unique partial index `stocktake_plan_period_once` on `stocktakes` `{header.planId, header.planPeriodNo}` (partial filter `header.planId` exists) makes "one slip per period" a database guarantee. **The index definition is in code only; it has not been built on any shared database.**

## Status, permissions, versions

Status values: `ACTIVE`, `PAUSED`, `ENDED` (`workflowStatus`; Vietnamese label in `trangThaiTiengViet`: Đang áp dụng / Tạm dừng / Đã kết thúc). `ACTIVE ↔ PAUSED`; `ACTIVE|PAUSED → ENDED` (terminal; also reached automatically when generating the last period before `endDate`).

No new permission code was added (exact grants unchanged): **writes use `stocktake:create`** (Owner only in the seed roles), **reads use `stocktake:read`** with warehouse scope (Owner sees all warehouses, other roles only assigned warehouses). Every command is idempotent through `idempotencyKey` (same key and payload replays the original receipt with `replayed: true`; same key and a different payload → 409 `ERR-CORE-409-003`) and uses optimistic `expectedVersion` on the plan.

Command receipt (same as other documents): `{ id, version, workflowStatus, operationId, resultRefs, replayed }`.

## Schedule rules

- `frequency`: `MONTHLY` (1 month), `QUARTERLY` (3), `YEARLY` (12). No custom interval.
- Occurrence `n` is `startDate` + `n × step` calendar months on the **Asia/Ho_Chi_Minh calendar** (UTC+7, no DST; fixed 22 Nov 2026, previously the UTC calendar), with the local day clamped to the length of the target month and the local time of day kept. A `startDate` of `2026-01-31T00:00:00+07:00` (= 30 Jan 17:00 UTC) anchors on 31 Jan local and falls on 28 Feb (29 in a leap year) and 31 Mar again (stored as `…T17:00:00Z` of the day before); quarter and year steps keep the local anchor day (31 Jan → 30 Apr, 29 Feb 2028 → 28 Feb 2029 → 29 Feb 2032); no drift. The frontend's current `08:00+07:00` payload falls on the same UTC calendar day, so its results are identical to the earlier UTC arithmetic (840 occurrences compared). The instants are stored in UTC; only the calendar arithmetic is local. `nextPeriodNo` is the index of the next period, `nextDueAt` its instant.
- `reminderDays` (0–90, default 7): a period can be generated, and the plan reports `dueSoon`, from `reminderDays` days before `nextDueAt`.
- `dueState`: `OVERDUE` (`nextDueAt ≤ now`, `isDue: true`), `DUE_SOON` (`dueSoon: true`), otherwise `NOT_DUE`. Only `ACTIVE` plans are ever due. `canGenerate` = `dueState !== 'NOT_DUE'`. `daysUntilDue` is negative when overdue.
- After generating, the next period is the first one **after now** (never earlier than the following period), so periods missed while nobody generated them are skipped, not backfilled. If that next period would fall after `endDate`, the plan becomes `ENDED` (`endReason: "END_DATE_REACHED"`, `nextDueAt` cleared).
- Resuming a paused plan does not skip an overdue period; it simply shows `OVERDUE` again.
- `frequency` and `startDate` are fixed after creation (period numbers identify generated slips). To change cadence, end the plan and create a new one.

## Endpoints (base `/api/stocktake-plans`, `Authorization: Bearer`, strict bodies)

| Method / path | Permission | Request body / query | Result |
|---|---|---|---|
| `GET /` | `stocktake:read` | query (strict): `q?` (plan number or title), `warehouseId?`, `status?` (`ACTIVE|PAUSED|ENDED`), `dueState?` (`OVERDUE|DUE_SOON`), `page?`, `limit?` ≤ 100. Sorted by `header.nextDueAt` ascending. | `{ items: Plan[], total, page, limit, lookups: { warehouses } }` |
| `GET /:id` | `stocktake:read` | — | `Plan` plus `slips[]` (`{ id, documentNo, workflowStatus, version, periodNo, dueAt, plannedAt, completedAt }`, newest period first) and `lookups` (`warehouses`, `locations` resolved from locationIds + areaCodes, `counters`) |
| `POST /` | `stocktake:create` | `{ idempotencyKey, warehouseId, title (1–200), reason?, frequency, startDate (ISO with offset), endDate?, reminderDays?, assignedCounterIds[≥1], scope, note? }` where `scope = { locationIds?, areaCodes?, batchIds?, productIds? }` and at least one of `locationIds`/`areaCodes` is non-empty | Creates `ACTIVE` plan, version 1, `nextPeriodNo: 0`, `nextDueAt = startDate`. Receipt. |
| `POST /:id/update` | `stocktake:create` | `{ idempotencyKey, expectedVersion, title?, reason?, note?, reminderDays?, assignedCounterIds?, scope?, endDate? (null clears) }`. `endDate` must not precede `nextDueAt`. | Not allowed on `ENDED` (409 `ERR-STP-409-001`). Receipt. |
| `POST /:id/pause` | `stocktake:create` | `{ idempotencyKey, expectedVersion, reason? }` | `ACTIVE → PAUSED` |
| `POST /:id/resume` | `stocktake:create` | same | `PAUSED → ACTIVE` |
| `POST /:id/end` | `stocktake:create` | same (`reason` is stored as `header.endReason`) | `ACTIVE|PAUSED → ENDED` |
| `POST /:id/generate` | `stocktake:create` | `{ idempotencyKey, expectedVersion }` | Creates one slip, see below |

Plan response fields: `id`, `documentNo`, `documentKind: "STOCKTAKE_PLAN"`, `workflowStatus`, `version`, `createdBy`, `occurredAt`, `note?`, `header` (`warehouseId`, `title`, `reason?`, `scope { locationIds, areaCodes, batchIds, productIds }`, `assignedCounterIds`, `frequency`, `startDate`, `endDate?`, `nextPeriodNo`, `nextDueAt?`, `reminderDays`, `lastGeneratedAt?`, `lastStocktakeId?`, `generatedCount`, `pausedAt?`, `pausedBy?`, `resumedAt?`, `endedAt?`, `endedBy?`, `endReason?`), `tenLoaiPhieu`, `trangThaiTiengViet`, `createdAt`, `updatedAt`, and the computed `isDue`, `dueSoon`, `dueState`, `canGenerate`, `daysUntilDue`.

Scope validation uses the same rules as slips: locations must belong to the warehouse and be active, filter lots/products must exist, counters must belong to the warehouse, be active and hold `stocktake:update`. `areaCodes` are resolved to the warehouse's active locations with that `areaCode` **each time a slip is generated**, so a new bin in an area is picked up automatically; the plan scope stores the codes, the slip stores the resolved `locationIds`.

### `POST /:id/generate` — "Tạo phiếu kiểm kê từ kế hoạch"

Runs in one transaction with the same validation and the same slip creation code as `POST /api/stocktakes` (`createStocktakeSlip`): active warehouse, scope validation, counters, document identity `KK-<wh>-YYMMDD-<n>`. The slip is `PLANNED`, version 1, `header.reason` = plan `reason` or `"<title> - kỳ <n>"`, `header.plannedAt` = the period's due instant, counters and scope from the plan, plus `planId`/`planPeriodNo`/`planPeriodDueAt`. The plan advances (`generatedCount`, `lastGeneratedAt`, `lastStocktakeId`, next period) in the same transaction. Receipt `resultRefs[0] = { documentType: "stocktakes", documentId: <new slip id> }`. The slip is then activated by an assigned counter exactly like any slip (`POST /api/stocktakes/:id/activate`), which takes the snapshot and locks the bins; generating does not.

Idempotency per period (verified, see Evidence):

1. same `idempotencyKey` → replay of the same receipt (`replayed: true`), same slip, nothing written;
2. a new key with a stale `expectedVersion` → 409 `ERR-CORE-409-001` (the first call already bumped the plan version);
3. a new key with the fresh version while the next period is not yet within `reminderDays` → 409 `ERR-STP-409-002` (`details: { nextDueAt, reminderDays }`);
4. if a **non-cancelled** slip for the period already exists → 409 `ERR-STP-409-003`; the unique partial index is the final guard against concurrent generation.

**Cancelled slips free their period (22 Nov 2026).** A `CANCELLED` slip no longer occupies its plan period. The exists-check ignores `CANCELLED` slips and the index `stocktake_plan_period_once` is now partial on `header.planId` exists **and** `workflowStatus ∈ {PLANNED, COUNTING, RECONCILING, PENDING_APPROVAL, APPROVED, IN_PROGRESS, COMPLETED, CLOSED, POSTED} (the three retired plan-workflow statuses stay in the list for historical in-flight slips)` (MongoDB partial filters do not support `$ne`, so this is an allow-list: a future non-cancelled status must be added to it in `stocktake.model.js`). Two non-cancelled slips for one period stay impossible, in code (exists-check) and in the index; several `CANCELLED` slips for one period are kept as history. Because generating advances the plan to the next period, a cancelled period is regenerated explicitly: `POST /:id/generate` accepts an optional `periodNo` (integer ≥ 0). With `periodNo` the plan must be `ACTIVE`, the period must be earlier than `nextPeriodNo` and already have slips, and none of them may be non-cancelled (otherwise 409 `ERR-STP-409-003`, or 409 `ERR-STP-409-001` "Kỳ này chưa có phiếu nào để tạo lại" when the period never had a slip or is not generated yet). The new slip is a normal `PLANNED` slip with the same `planPeriodNo` and `planPeriodDueAt` = that period's due instant; `generatedCount`, `lastGeneratedAt` and `lastStocktakeId` are updated but **`nextPeriodNo`/`nextDueAt` do not move** and the `canGenerate` due check is not applied (the period is already past). `GET /:id` returns `regenerablePeriodNos: number[]` (periods whose slips are all `CANCELLED` and are earlier than `nextPeriodNo`) so the screen can offer "Tạo lại phiếu kỳ n". A plan that already became `ENDED` (end date reached) cannot regenerate.

## Error codes

| HTTP | `code` | When |
|---|---|---|
| 400 | `ERR-CORE-400-001` | strict body/query violation, unknown warehouse/counter/scope, `endDate` before `startDate`/`nextDueAt` |
| 403 | `ERR-CORE-403-001` / `-002` | missing permission / warehouse not assigned |
| 404 | `ERR-CORE-404-001` | plan not found |
| 409 | `ERR-CORE-409-001` | stale `expectedVersion` |
| 409 | `ERR-CORE-409-003` | same `idempotencyKey` with a different payload |
| 409 | `ERR-STP-409-001` | transition/update not allowed in the current status (e.g. edit or generate on `ENDED`/`PAUSED`) |
| 409 | `ERR-STP-409-002` | next period not due yet |
| 409 | `ERR-STP-409-003` | slip already generated for the period |

Error body: `{ success: false, message, code?, fieldErrors?, details? }`.

## Data impact and rollout

New collection `stocktake_plans` (empty at start), new optional fields on `stocktakes.header` (`planId`, `planPeriodNo`, `planPeriodDueAt`, `settledLines`, `recountLines`), one new unique partial index on `stocktakes` (`stocktake_plan_period_once`, filter amended 22 Nov 2026 as above; still only a definition in code — it was never built on a shared database, so no index rebuild is needed), two read indexes on `stocktake_plans` (`{workflowStatus, header.nextDueAt}`, `{header.warehouseId, workflowStatus}`). Existing slips are untouched (no backfill needed; absent `planId` means ad-hoc). No permission or seed change beyond description text. **No index was built and no write was made on any shared or remote database**; index creation is a separate, explicitly authorised rollout step.

## Evidence

Isolated local replica set only (`127.0.0.1:27018`, throw-away database, dropped afterwards): plan create (Owner-only), detail flags, due filter, generate twice (replay, stale version, not-due), exactly one slip per plan, `nextDueAt` advanced by a quarter, pause blocks generate, ad-hoc slip still created. See the check list in [change_logs.md](../../change_logs.md) (22 Nov 2026). Follow-up proofs 22 Nov 2026 (isolated 27018, throw-away database): Asia/Ho_Chi_Minh anchor (31 Jan 00:00+07 → 28 Feb → 31 Mar, quarter/year clamps, leap year), 08:00+07 payload identical to the old UTC results, generate → cancel slip → generate the same period again succeeds (new slip, same `planPeriodNo`, `nextPeriodNo` unchanged), second regeneration while the new slip is open refused, the index refuses a second `PLANNED`/`COUNTING` slip for a period and accepts extra `CANCELLED` ones. Not run: scheduler (none exists), UI, shared database.
