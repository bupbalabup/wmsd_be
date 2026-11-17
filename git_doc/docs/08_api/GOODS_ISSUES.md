## Customer details on documents — 17 November 2026

User decision: customers are not managed as catalogue records. New sales orders require `customerName` (1–160 characters) and allow `customerPhone` (up to 30 characters); the delivery address remains on the order. Creating an order does not query or create a Customer. Sales options return an empty compatibility `customers` array.

Customer-return creation sends warehouse and source lines only, without `customerId` or a customer selector. The server resolves name/phone from the source sales order or verified historical delivery and saves a snapshot on the return. Each new request is limited to one source document, while allowing multiple lines and split parts from that document. Warehouse access, source ownership/permissions, confirmed received quantity, claims, evidence, versions and idempotency remain enforced. Direct goods issues retain the sales-order link and no longer require a customer catalogue ID.

Historical verification requires customer name text and optional phone from the external document; verification/evidence remains mandatory. New historical sources with customer snapshots use the current inspection/acceptance/receipt flow without custody. Previously stored sources and custody ledgers retain their legacy behavior. Optional legacy customerId fields and the Customer collection remain readable; no records or collections are deleted or backfilled. Deploy FE and BE together; old clients sending customerId to new creation endpoints must update.

Validation: focused sales/return contract tests and the local direct-sales transaction test passed using an isolated database on the local rs0 replica set (port 27017). The transaction fixture creates a new sale and return with no Customer record, and separately verifies legacy custody compatibility. No Atlas write or migration was performed.

Current contract: [customer document snapshots](CUSTOMER_DOCUMENT_SNAPSHOTS.md).

# Goods Issue — current sales flow, 17 November 2026

Decision source: the user's latest explicit instruction restores Sales Order and simplifies sales to **Sales Order → Phiếu xuất kho**. New manual-reference SALE creation is rejected by the public API; existing manual-sale records keep their legacy execution. New sales do not require WIR, OD, picking, delivery tracking or customer custody. This section supersedes the 16 November manual-sale decision retained below for compatibility.

## New sales and responsibilities

1. Sales creates the Sales Order, identifying the customer and requested products/quantities through the existing verified source flow.
2. Warehouse creates a DRAFT sale issue against that order. Select the assigned warehouse and actual GOOD, STORE-owned stock in pickable STORAGE locations. Several issues may serve one order; one issue may split one order line over multiple balances/lots.
3. Warehouse posts the issue directly. PGI deducts actual source balances once, preserves packaging and records `header.issuedToName/issuedAt/issuedBy`. No picking task, staging move, reservation or delivery order is generated. Posting means goods left the warehouse; it does not prove customer receipt.
4. Sales records customer receipt on the posted issue after checking external evidence. The named recipient, actual received time, quantity and uploaded evidence are retained per issue item. This command does not post stock. Only the Sales creator of the source order may confirm receipt; permission alone does not grant another Sales user's order.
5. Warehouse uses **Nhận lại hàng chưa giao** on that same issue when goods actually return without customer receipt. Enter quantity, reason, actual quality, receiving/storage or quarantine location and evidence. The command immediately posts a linked FAILED_DELIVERY goods receipt, restores STORE stock and makes that quantity available for a replacement issue under the original order. It creates no FailedDelivery request, separate inspection document, custody record or WIR/OD reopening.

Order status is PARTIAL after issue; it becomes DELIVERED once all order quantities, less recorded cancellations, are confirmed customer-received. Confirmed customer returns do not reopen sales demand or issue refunds.

## API and quantities

All routes are below `/api`. Authentication, current permissions, record and warehouse scopes, optimistic version, idempotency and audit/outbox records are enforced transactionally.

| Endpoint | Input / permission |
|---|---|
| GET `/goods-issues/direct-options` | `goods_issue:create`; active orders with remaining quantities and eligible stock in assigned warehouses; up to 100 recent orders |
| POST `/goods-issues` | `goods_issue:create`; `{salesOrderId, warehouseId, expectedVersion: order.version, idempotencyKey, note?, lines:[{salesOrderLineId, sourceBalanceId, qtyBase}]}`; Sales cannot execute |
| POST `/goods-issues/:id/post` | `goods_issue:post`; `{expectedVersion, idempotencyKey, recipientName, vehiclePlate?}`; DIRECT DRAFT posts without picking; vehiclePlate is a legacy input and is not used by DIRECT |
| POST `/goods-issues/:id/customer-receipt` | `delivery_confirmation:confirm` AND SALES; `{expectedVersion, idempotencyKey, recipientName, receivedAt: ISO timestamp, evidenceIds, lines:[{lineId,qtyBase}]}` |
| POST `/goods-issues/:id/receive-undelivered` | `failed_delivery:post`; `{expectedVersion, idempotencyKey, reason, evidenceIds, lines:[{lineId,qtyBase,locationId,qualityCode: GOOD|DAMAGED|BLOCKED,portions?}]}` |
| POST `/goods-issues/:id/cancel` | existing `goods_issue:update`; DRAFT only, reason/version/key; no stock effect |

New quantities are exact positive base-unit decimal strings, with whole-base-unit checks. Physical issue rows use base-unit factor 1, actual lot/packaging and a source link back to the order item; commercial unit/price snapshots remain available separately. DRAFT quantities count against order allowance but do not reserve inventory; Warehouse must recheck availability at posting. Stocktake locks, holds, other reservations and capacity checks remain active. When a draft's stock is no longer free, cancel it and create a replacement with the current source.

At each issue item, customer-confirmed quantity + posted undelivered quantity + outstanding legacy failed-delivery claims cannot exceed effective posted issue quantity. A shared ReturnSourceLock serializes competing receipt/return actions. New direct issues cannot enter the old FailedDelivery create flow. Customer-return allowance is confirmed customer-received quantity less CR claims, never gross issue quantity. SO version writes serialize order edits/cancellations against fulfillment; active old WIR commitments and direct issues cannot be mixed.

GET detail exposes per-item `issuedQtyBase`, `customerReceivedQtyBase`, `undeliveredReturnedQtyBase`, `unconfirmedQtyBase`, `customerReceipts`, linked `undeliveredReceipts` and server capabilities. List/filter/detail retain Sales order-creator scope and Warehouse assigned scope, and redact prices. The Sales Order detail links all its direct issues and their receipt history. Sale issue list also supports Excel export with current filters.

## Customer returns without custody

New requests carry `header.intakeMode=DIRECT` regardless of whether their source is a confirmed direct issue, a historical legacy chain, or a verified historical delivery. Sales requests → Warehouse records physical condition, actual quantity and evidence → Sales accepts/rejects → Warehouse posts only the accepted amount as CUSTOMER_RETURN receipt. Inspection changes no balances and asks for no custody location. Rejected handbacks are embedded evidence/recipient/quantity events with no ledger or inventory effect. Reassessment is blocked after any posted receipt or handback. See [return workflow contract](RETURN_WORKFLOWS_NATIVE.md).

## Persistence and compatibility

No collection, stored ID rewrite or backfill. Additive optional fields:

- `sales_goods_issues.header`: `fulfillmentMode=DIRECT`, SalesOrder `salesOrderId`, Customer `customerId`, `issuedToName` (max160).
- Issue items: `sourceBalanceId` (InventoryBalance); existing `salesOrderItemId` links the source embedded order line. `customerReceipts[]` has stable ID, `issueLineId`, positive `quantityBase`, `recipientName`, `receivedAt`, `recordedBy/recordedAt`, `evidenceIds`. It is an embedded schema, not a collection.
- `customer_returns.header.intakeMode=DIRECT`; `handbacks[]` has stable ID, `returnLineId`, positive `quantityBase`, `recipientName`, `recordedBy/recordedAt`, evidence IDs.
- FAILED_DELIVERY variant in `goods_receipts.header.goodsIssueId` points directly to SalesGoodsIssue. Its item details retain required `salesIssueLineId`; legacy `failedDeliveryLineId/inspectionLineId` are optional for this direct mode. Legacy commands still require their inspected source chain.

Older documents without the mode markers retain their original custody/picking semantics and immutable ledgers. Do not mark existing custody-backed CR as DIRECT; their physical balances must be consumed through the original path. The navigation hides retired workflows, while historical detail links remain readable. OTHER, supplier returns and transfers keep their established execution rules.

The [focused current relationship view](../03_thiet_ke/DB_Current_2026-11-12_58/Simplified_Sales_Returns.svg) is also included as a page in the current draw.io ERD.

Run the existing permission synchronization against the intended database to add `delivery_confirmation:confirm` to SALES before exposing this UI. No remote database was changed. See [local verification/setup](../09_phat_trien/SIMPLIFIED_SALES_SETUP.md).

## Dated compatibility contract — 16 November 2026

The remaining text describes manual/external and old OD-backed issue records. Its SALE creation/picking requirements do not govern the new DIRECT mode above.

### Previous Goods Issue — UC-69–72

Decision source: user confirmation on 16/11/2026. UC-71 creates a goods issue;
UC-72 updates its information and supported workflow states. The latest decision
replaces the mandatory SO → WIR → OD prerequisite for new sale issues.

## One create form, five reasons

`/goods-issues/create` first selects the issue reason and its reference. Sales
(the existing `SALES` role, called Sale Order by the user) sees only **Xuất bán**.
Warehouse Staff sees other reasons only with the matching execution permission.

| Reason | Reference and input | Existing execution contract |
|---|---|---|
| SALE / Xuất bán | Manually entered MISA eShop order code; warehouse; products, base quantities, per-line/general notes | New independent Goods Issue |
| TRANSFER / Xuất điều chuyển | Select an approved TR; enter the quantities for this dispatch | Native TransferDispatch, then PICK TO and dispatch confirmation |
| SUPPLIER_RETURN / Trả NCC | Select a READY/PARTIAL supplier-return agreement; quantity, handover/evidence | Native supplier-return dispatch/custody release |
| SCRAP / Hủy hàng | Select a defect report and its approved SCRAP plan portions; actual execution/evidence | Native StockScrapRecord; no REGRADE/RELEASE lines in this form |
| OTHER / Xuất khác | Manually entered reference and reason text; warehouse/products/quantities/notes | Independent GI_OTHER |

The last three established business flows retain their native documents, source
caps, permissions and stock effects; the common form embeds their existing
execution commands rather than creating an extra stock posting. Results open the
corresponding source detail. `/goods-issues` lists GI_SALE/GI_OTHER; native transfer,
supplier-return and defect records remain in their existing lists.

For SALE, `header.referenceNo` is a recorded external order code, not a foreign
key to SalesOrder or a unique import key. The user checks the external order and
its quantities manually. Repeated shipments may record the same code. Creating
this issue does not create an SO/WIR/OD, validate a MISA order, require source
verification/evidence, or call MISA. Product/quantity validity is still checked.
Lines accept base quantities or an entered quantity with a current verified
product conversion (carton/pallet/area). The item retains entered unit, quantity,
factor and optional carton snapshot. Lots/bins are selected
by Warehouse Staff when planning physical picking, not by Sales on this form.

## Approval and stock milestones

```mermaid
stateDiagram-v2
  [*] --> PENDING_APPROVAL: Sales creates SALE
  PENDING_APPROVAL --> DRAFT: different Store Owner approves same ID
  PENDING_APPROVAL --> CANCELLED: creator cancels
  [*] --> DRAFT: Warehouse creates SALE or OTHER
  DRAFT --> DRAFT: edit / create picking task
  DRAFT --> CANCELLED: cancel before physical picking
  DRAFT --> PICKED: assigned picker finishes TO
  PICKED --> POSTED: actual issue and handover
```

Approval is a versioned status update on the same issue, with `approvedBy` and
`approvedAt`. It creates no replacement issue, reservation, stock transaction or
commercial order. Warehouse cannot pick/post pending requests. Sales can edit or
cancel only their own PENDING_APPROVAL issue; after approval, Warehouse handles it.
Sales cannot create OTHER or use the legacy OD-backed endpoint to bypass approval.
Store Owner must differ from the creator and must have `goods_issue:approve`.

Creating/editing an independent draft or approving it does not reserve or change
stock. Warehouse allocates exact quantities across active STORAGE balances and
STAGING locations within the issue warehouse; allocations may split a product
across lots/bins. Creation of the PICK TO reserves the selected stock. TO confirm
moves storage → staging, supports partial actuals, preserves lot/owner/packaging
and reservations, and keeps total stock unchanged. PGI consumes staged
reservations, deducts stock once, appends one handover and sets POSTED atomically.
OTHER uses `OTHER_ISSUE` ledger operation. Neither posting completes an order.

Cancellation releases an independent draft's unstarted reservations and cancels
its OPEN task. Physical/partial picking blocks this cancellation. Old OD-backed
issues continue restoring their root OD allowance on edit/cancel. Posted history
is immutable. Freeze, availability and whole-base-unit rules still apply;
manual external-order quantity checks never bypass physical stock validation.

The user also permits outbound carton opening and fractional cartons. For example,
1.5 cartons × 4 pieces = 6 pieces is valid; 0.1 × 4 is invalid for a whole-piece
product. Picking and posting may split cartons, reuse OPEN/LOOSE stock first, and
retain an OPEN remainder without a sealed-pack count. If a partial portion has no
known dimensions, measured volume or existing volume bound, splitting is rejected.
Opened portions store a conservative `volumeUpperBoundMm3`, never an invented
measurement. Each fragment retains a safe bound (possibly overestimating occupied
space); capacity checks use it until a real measurement is recorded. This outbound
opt-in also covers BF04 picking/dispatch, supplier dispatch and SCRAP execution.
Ordinary BF03 relocation and receiving retain their existing packaging rules.

## API, permissions and DTO

| Action | API | Permission |
|---|---|---|
| List/detail | GET /api/goods-issues, GET /api/goods-issues/:id | goods_issue:read |
| Create catalogue | GET /api/goods-issues/options | goods_issue:create |
| Create | POST /api/goods-issues | goods_issue:create |
| Edit/cancel | PUT /api/goods-issues/:id, POST /api/goods-issues/:id/cancel | goods_issue:update |
| Approve | POST /api/goods-issues/:id/approve | goods_issue:approve + OWNER |
| Create picking | POST /api/goods-issues/:id/picking-tasks | picking_task:create + warehouse scope |
| Confirm picking | POST /api/picking-tasks/:id/confirm | picking_task:confirm + assignee/scope |
| Post | POST /api/goods-issues/:id/post | goods_issue:post + warehouse scope |

Manual create body: `{idempotencyKey,expectedVersion:1,issueKind:'SALE'|'OTHER',
warehouseId,referenceNo,reasonText?,note?,lines:[{productId,quantity,conversionId?,note?}]}`.
OTHER requires reasonText. Every product appears once; quantities are positive
six-place decimal strings. Without conversionId, quantity is in the base unit;
with it, the server loads the effective verified conversion and snapshots it.
The alternative legacy manual input `qtyBase` cannot be combined with quantity or
conversionId. Whole-base products require integer converted quantities; area
conversions follow the shared ceiling-to-piece contract. Options returns active
units and effective conversions, not a client-supplied factor. New manual
picking body uses `{idempotencyKey,expectedVersion,allocations:[{lineId,
sourceBalanceId,locationId,qtyBase}]}`; totals must equal every planned line.
Approval accepts only `{idempotencyKey,expectedVersion}`; arbitrary status writes
are rejected. Updates supply each existing line once. Post requires
`recipientName` with optional `vehiclePlate`; cancel requires a reason.

Default permissions: Sales gains create/update; Warehouse retains create/update/
post and picking permissions; Owner gains approve. Read remains permission-based:
Sales sees only their own manual SALE requests (and previously scoped SO issues),
Warehouse/custom operators see assigned warehouses, Owner/Accountant read across
the store. Sales may select an active warehouse for a pending request even without
warehouse assignments; this grants no physical stock access. ADMIN receives no
business grants. Live actor, permissions and scope are rechecked in transactions.

DTO adds `manualReference`, nullable `deliveryOrder`/`issueRequest`/`salesOrder`,
header reference/reason, optional approval metadata, and `canApprove`. Detail
supplies product/notes, lot/bin labels, plan/prepared/issued quantities, tasks and
handover history. `stockSources` appears only for scoped physical pick operators
on manual drafts, never for Sales. Actual lot identity is derived from task and
ledger source references; same-product picking lines remain distinct.

Filters: literal q (issue number), sourceRequest (external reference or old WIR),
status including PENDING_APPROVAL, warehouse and legacy source IDs, inclusive ISO
from/to actual issue dates, page/limit (20 default, max100). Scope precedes counts
and paging. DTO omits prices. Dates in FE use Vietnam time.

## Persistence, compatibility and rollout

Collection remains `sales_goods_issues`, model SalesGoodsIssue. It now supports
GI_SALE and GI_OTHER; header.issueKind is SALE/OTHER (default SALE). Optional
header.referenceNo (max160), reasonText (max500), approvedBy(User), approvedAt(Date)
have no backfill/default for historical documents. Item details remain embedded;
outboundDeliveryLineId is optional for manual issues, mandatory at the legacy
command boundary. Manual planned rows have no invented lot or SO price snapshot.
Inventory packaging portions add optional Decimal128 `volumeUpperBoundMm3` (mm³)
for OPEN/LOOSE portions produced by outbound splitting. Existing documents remain
valid without it; capacity reads measured volume first, then this bound. No backfill
is needed and no quantity is reconstructed from a volume.
New codes: PXB-[warehouse]-[YYMMDD]-[sequence] for SALE and PXK-... for OTHER.
No collection/index is added; no stored ID is changed.

```mermaid
flowchart LR
  Product -->|1:n planned lines| GI[SalesGoodsIssue / GI_OTHER]
  Warehouse -->|1:n| GI
  Creator[User / creator] -->|1:n| GI
  Approver[User / Owner] -->|1:n optional approval| GI
  OD[DeliveryOrder] -. optional legacy source .-> GI
  Ref[External reference text] -. no foreign key .-> GI
  GI -->|1:n allocations / actual lots| TO[TransferOrder PICK]
  GI -->|1:n ledger / embedded handover| Stock[StockTransaction]
```

Old issues missing header.deliveryOrderId resolve a unique OD from item links.
Legacy POST /outbound-deliveries/:id/picking-tasks and OD-backed GI create remain
compatible for their authorized warehouse callers. New UI defaults to manual
references. Confirmed historical tasks without SALES_PICK ledger use confirmed
quantities; POSTED issues without picking history return null prepared quantity.
Issued quantity uses effective ledger after reversals. Manual-reference issues do
not fabricate SO/POD/financial completion or the old SO-based return source chain.

Existing DBs need `npm run seed:goods-issue-permissions` with MONGODB_URI deliberately
selected. The additive command inserts missing create/update/approve codes and adds
only their new default grants; it preserves all other/custom grants. This change
requires no schema migration or data rewrite. Remote rollout needs explicit approval.
All commands retain exact replay payloads/keys, optimistic versions, audit/outbox
and transaction rollback. The UI preserves uncertain writes, including query
refresh failures, and confirms approval/picking/posting/cancellation explicitly.

## Validation

Run `RUN_GOODS_ISSUE_TESTS=1 node --test test/goods-issues.integration.test.js
 test/goods-issue-validation.test.js` using only loopback27018/hieudt-test and random
`goods_issue_test_<ObjectId>` databases with guarded teardown. Tests cover legacy
source caps, standalone external codes, same-ID approval without reservations or
SO creation, unauthorized roles/other Sales, pending physical guards, picking,
freeze/rollback, once-only posting, OTHER codes/cancel and concurrent drafts.
Component tests cover manual form/retry, Sales-only reasons, owner approval,
field validation and existing detail behavior. See the dated local-test evidence
for actual final results and known repository-wide failures.
