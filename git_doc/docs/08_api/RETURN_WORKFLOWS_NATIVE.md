## Customer details on documents — 17 November 2026

User decision: customers are not managed as catalogue records. New sales orders require `customerName` (1–160 characters) and allow `customerPhone` (up to 30 characters); the delivery address remains on the order. Creating an order does not query or create a Customer. Sales options return an empty compatibility `customers` array.

Customer-return creation sends warehouse and source lines only, without `customerId` or a customer selector. The server resolves name/phone from the source sales order or verified historical delivery and saves a snapshot on the return. Each new request is limited to one source document, while allowing multiple lines and split parts from that document. Warehouse access, source ownership/permissions, confirmed received quantity, claims, evidence, versions and idempotency remain enforced. Direct goods issues retain the sales-order link and no longer require a customer catalogue ID.

Historical verification requires customer name text and optional phone from the external document; verification/evidence remains mandatory. New historical sources with customer snapshots use the current inspection/acceptance/receipt flow without custody. Previously stored sources and custody ledgers retain their legacy behavior. Optional legacy customerId fields and the Customer collection remain readable; no records or collections are deleted or backfilled. Deploy FE and BE together; old clients sending customerId to new creation endpoints must update.

Validation: focused sales/return contract tests and the local direct-sales transaction test passed using an isolated database on the local rs0 replica set (port 27017). The transaction fixture creates a new sale and return with no Customer record, and separately verifies legacy custody compatibility. No Atlas write or migration was performed.

Current contract: [customer document snapshots](CUSTOMER_DOCUMENT_SNAPSHOTS.md).

# Current customer returns — 17 November 2026

Latest user decision: new Sales Order → Phiếu xuất kho flow has no picking/delivery management or customer custody. New CR uses `header.intakeMode=DIRECT`: Sales request → Warehouse inspection of quantity/packaging/use/damage/deadline and evidence → Sales acceptance → Warehouse receipt of accepted quantity. Inspection has no stock effect and requires no custody location. The receipt creates STORE stock directly; there is no customer custody consumption. Rejected handback appends `handbacks[]` with item, quantity, recipient, operator/time and evidence; it changes no stock. Reassessment cannot follow a posted receipt or handback. Quantity/version/idempotency/evidence/eligibility rules remain enforced.

Trace direct returns to the original issue item and source Sales Order/customer. Return allowance is customer-confirmed receipt less charged CR claims. Verified historical sources remain supported. Warehouse records physical facts; Sales checks source/customer, commercial eligibility, requested versus inspected quantity and accepts/rejects. This flow does not issue a refund. New undelivered goods are received inline from the issue, without a FailedDelivery request; see [current Goods Issue contract](GOODS_ISSUES.md).

Legacy documents without `intakeMode=DIRECT` retain the dated custody behavior below so existing posted balances/history remain valid. Supplier custody is unaffected.

15 November 2026 — quantity handling across customer returns, supplier returns and defects (explicit user request to implement the four reviewed Minh patterns). Detail items now include read-only `progress`: requested, inspected/accepted/received/handedBack/custodyRemaining/handbackAvailable for CR; agreed/dispatched/acknowledged for SR; processed/remaining/proposable for defects. Pending inspection/agreement/approval is absent rather than a fabricated zero. Counts use the latest inspection and decision, posted receipts/releases/issues only, and current non-superseded accepted ACKs. Defect plans expose `remainingQtyBase` per plan line after execution. FE selects submitted plans for decision and approved plans with remaining quantities for execution, sends their exact planId, and can resume older outstanding plans. Stocktake-bound holds expose zero ordinary proposable quantity and remain in stocktake resolution. These are DTO fields, not persisted schema additions.

CR creation accepts multiple parts from one sales/historical source (maximum 100 lines). Each part has its own item ID, claim, reason, inspection and decision. Warehouse then inspects each part separately; it cannot change the lot or source of a posted request. Aggregate source caps and concurrent locks still apply inside the existing transaction. Defect proposals similarly allow multiple outcomes for one defect source, with the aggregate including all earlier submitted/approved plans and earlier rows of the same new proposal. Supplier proposal and receipt source uniqueness rules stay in force. Partial physical movements use separate posted documents with current remaining caps.

Customer rejected parts can be handed back in REJECTED, ACCEPTED, PARTIAL or COMPLETED states, but only up to current inspected quantity minus approved quantity minus prior handbacks. Approved quantities cannot be handed back through this action. This supports an accepted part entering store stock while the refused part remains customer-owned until handover. Permission, evidence, recipient, version and idempotency checks continue to apply.

FE quantities for physical actions and customer-return receipt entry start blank. Source/request and defect-plan rows can be split into independent blank parts, and combined quantities are validated before submission and by the backend. Carton/piece input uses the historical packaging snapshot first; carton totals continue to be written as base-unit decimal strings. Area equivalence is shown only when the source already carries an area-unit conversion snapshot; it is read-only, never rounded up to increase a return. No new collection, migration or live database rollout.

14 November 2026 — user decision: non-GOOD purchase intake enters supplier custody, then the supplier-return alternate flow. Posted supplier custody DTO adds header.supplierId, capabilities.createSupplierReturn (permission, assigned warehouse, posted supplier ownership), and per-item custodyBalanceId / returnAvailableQty. Advisory quantity is capped by original quantity less supplier-return commitments and free physical stock at the original receiving balance; commands enforce current limits atomically. Warehouse selects “Tạo đề nghị trả NCC” on a custody line and enters quantity/reason. The proposal uses that exact custody item/balance, creates no DefectReport, and starts at AGREEMENT_PENDING. Accountant agreement → Warehouse dispatch creates CustodyRelease → Accountant ACK/close. Supplier-owned goods do not create SupplierReturnIssue. After relocation, use the regular supplier-return form with the current balance. No schema change or migration.

# Trungph return workflows on native models

12 November 2026: stock consumption preserves retained packaging subdocument identities and creation timestamps when earlier custody arrivals are removed. Balance validation, version guards, ledger and transaction boundaries remain enforced. The multiple-arrival custody regression reproduces the former immutable-timestamp failure and verifies the later portion remains unchanged after receipt.

Updated 7 November 2026. Scope: Trungph's three iterations, carried forward by function name through the [UC crosswalk](../07_ra_soat/UC_RENUMBER_2026-10-30.md). This implementation uses the single 59-collection registry and does not restore BusinessDocument, DocumentLine, UOM, separate holds/plans/ACKs or standalone movements.

## Scope and routes

All routes below are under `/api`, require active authentication, and recheck the current operation permission. Owner can access all warehouse scopes; other users require an assigned warehouse. Custom roles use the same permission checks. Requester/reviewer identity checks apply independently of role changes.

| Function / current UC | HTTP routes |
|---|---|
| Defect search/detail, UC-73/74 | GET `/defects`, `/defects/:id` |
| Detection/hold and proposal, UC-75/76 | POST `/defects`; POST `/defects/:id/proposals` |
| Decision/execution, UC-77/78 | POST `/defects/:id/decision`, `/execute` |
| Customer return list/detail/request, UC-79/80/81 | GET `/customer-returns`, `/:id`; POST `/customer-returns` |
| Ordinary / eligible exception decision, UC-82/83 | POST `/customer-returns/:id/decision`, `/exception-decision` |
| CR inspection / FD inspection, UC-84/85 | POST `/customer-returns/:id/inspect`, `/reassess`; POST `/failed-deliveries/:id/inspect` |
| CR receipt / FD receipt, UC-86/87 | POST `/customer-returns/:id/receipt`; POST `/failed-deliveries/:id/receipt` |
| Failed delivery record / search / detail | POST/GET `/failed-deliveries`; GET `/failed-deliveries/:id` |
| Customer handback (DIRECT: event only; legacy: custody release) | POST `/customer-returns/:id/handback` |
| Supplier return search/detail/proposal, UC-88/89/90 | GET/POST `/supplier-returns`; GET `/supplier-returns/:id` |
| Actual supplier dispatch / closure, UC-91/92 | POST `/supplier-returns/:id/dispatch`, `/close` |
| Supplier agreement and later acknowledgement (original UC-107 scope) | POST `/supplier-returns/:id/agreement`, `/acknowledgement` |
| Lot trace, UC-116 | GET `/lots/:id/trace`, `/lots/:id/trace/evidence/:evidenceId` |
| Verified historical delivery, UC-122 | POST `/external-references/historical` |
| External result references, UC-123 | GET/POST `/external-references` |
| Shared source options and evidence | GET `/return-workflows/options`; POST `/return-workflows/:id/evidence`; GET `/return-workflows/:id/evidence/:evidenceId` |

The older 19-UC assignment is covered by these functions; split UCs are shown separately. Retired supplier Owner approval is not restored.

## Nhập kho từ chứng từ nguồn

Kho dùng **Lập phiếu nhập** trên hồ sơ khách trả hoặc giao thất bại, hoặc tìm nguồn từ **Phiếu nhập kho**. API danh sách nhận `status` phân tách bằng dấu phẩy và `receivable=true`. Khách trả lọc `ACCEPTED,PARTIAL` và có tham chiếu quyết định. Giao thất bại lọc `INSPECTED,PARTIAL`. Chi tiết trả `receivableLines` theo dòng gốc, gồm lượng còn được nhập và phẩm cấp hợp lệ. Giao thất bại có thêm tình trạng bao bì đã kiểm.

Form gọi lệnh `/receipt` của nguồn với `expectedVersion`, `idempotencyKey`, minh chứng đã đính kèm và các dòng có lượng thực nhận. ĐVT là đơn vị gốc. Form nhận hàng giao thất bại ánh xạ `SEALED` thành `SEALED`, `LOOSE` thành `LOOSE`, các tình trạng còn lại thành `OPEN`. Khi nhận lại hàng giao thất bại hoặc kiểm hàng khách trả vào khu giữ hộ, mỗi phần `OPEN` hoặc `LOOSE` có thể kèm `measuredVolumeMm3`. Nếu không có giá trị, BE dùng [công thức ước tính](NATIVE_MODEL_RUNTIME.md#mua-và-nhập). Kiểm nhận và đánh giá lại chấp nhận tình trạng bao bì `LOOSE` (hàng lẻ). Lệnh thành công trả ID phiếu nhập trong `resultRefs` và cập nhật tồn trong cùng giao dịch. Kiểm hàng, ra quyết định và bàn giao lại khách thực hiện ở hồ sơ nguồn.

## Payload and response rules

Quantities are exact decimal strings, never JS floating-point numbers. IDs identify a native parent document and stable embedded item. `items[].sources[]` identifies the source collection/document/item and linked quantity. Client DTO adapters may call display rows `lines`; storage remains `items[]`.

All business creations use a stable `idempotencyKey`; commands also require `expectedVersion` on the parent. Reuse the original payload/key after a lost response. Changing payload requires a new key. Operation records bind actor, operation, target and payload hash. Replays recheck permission and scope. Command results are `{id, version, workflowStatus, operationId, resultRefs, replayed}` in the usual `data` envelope. Lists use `data.items` with `data.total/page/limit`; detail responses include `relatedDocuments`, scoped attachment metadata and audit history.

- Defect creation: `warehouseId, balanceId, quantity, sourceKind, reason`, optional matching source item and optional initial disposition. `sourceKind=STOCKTAKE` requires the actual locked session and forbids ordinary disposition. While that session is `COUNTING`, a non-Owner is refused before any quantity check ("Đợt kiểm kê đang đếm…"; user decision 18 Nov 2026), because repeated over-quantity refusals would reveal the blind book; the condition goes into the count note and the defect is recorded once the session is reconciled. During `COUNTING` the balance lookup (`kind=balances`) returns such balances with null quantities and `blindCount: true`, and the session lookup (`kind=stocktakes`) does not offer a `COUNTING` session to a non-Owner. Source-free inspection is MANUAL. Detection may be followed later by `/proposals` with `lines[{lineId,qtyBase,outcome,targetQuality?}]`, evidence and note.
- Decisions: `expectedVersion, idempotencyKey, decision, reason`, optional per-item `lines[{lineId,qtyBase}]`. Defect approval binds the plan and approved quantity; CR approval binds the actual current inspection snapshot. Installed/customer-damaged/verified-overdue or unknown facts cannot be approved as an eligible return.
- CR creation: `warehouseId, customerId, idempotencyKey, lines[{salesIssueLineId OR historicalExternalLineId,qtyBase,reason}]`. Never use both source types. Creation claims quantity but does not receive inventory.
- CR inspection: version/key/note/evidence, `custodyLocationId` only for legacy custody-backed requests, and `lines[{returnLineId,qtyReceived,packagingCondition,installationStatus,damageCause,deadlineStatus,deadlineReference?,assessmentReason,portions?}]`. Zero means an actual recorded non-arrival. Reassessment uses the same observed quantity and appends facts without receiving twice.
- Receipt: version/key/note/evidence and `lines[{lineId,qtyBase,locationId,qualityCode,portions?}]`. GOOD uses an appropriate receiving/storage location; defective STORE goods require quarantine. DIRECT customer receipt posts only accepted quantity as STORE stock. Legacy customer receipt consumes existing customer custody and transfers ownership, not a second physical arrival. It does not reopen demand or refund money.
- FD inspection records actual quantity/quality/packaging without stock. FD receipt, source claim consumption, stock movement and original SO/WIR/OD reopening commit together. Shared source cap is effective POD + posted FD returns + unresolved FD claims <= valid PGI. Claims do not reopen demand.
- Supplier proposal: warehouse/supplier/key/note and `lines[{originLineId,balanceId,qtyBase,defectHoldId?}]`. Source must trace to a posted receipt from that supplier's PO, or that supplier's custody receipt. Proposal reserves quantity and records PROPOSED details without inventing agreement facts. Returning held goods requires the explicit evidenced hold; unrelated holds are not consumed.
- Agreement: version/key/note/evidence/reference and `lines[{lineId,qtyBase}]`; zero records refusal. Verified facts are retained in agreement history and current line metadata. A new agreement cannot reduce quantities already dispatched.
- Supplier dispatch / custody handback: version/key/note/evidence, actual `recipientName`, and source item quantities. Store-owned goods use SupplierReturnIssue; supplier-owned goods use CustodyRelease. Neither uses Owner approval.
- ACK: version/key/note/evidence and actual dispatch `lines[{lineId,qtyBase,outcome}]`. Outcome is ACCEPTED, REJECTED or DAMAGED. Unacknowledged quantity remains missing, independently of rejected quantity. Optional `supersedesAcknowledgementId` corrects one earlier acknowledgement of exactly the same source quantity, preserves its facts as SUPERSEDED, and retains the reconciliation reason/evidence.
- Closure requires every agreed quantity dispatched and accepted acknowledgements for every dispatched portion; disputes block closure. Explicit verified refusal plus the closure reason accounts for an unshipped portion. Unused reservations are released; defect holds remain until actually resolved. Closure never posts stock.

## Selection and review interface

The frontend requests `GET /return-workflows/options?compact=true` for warehouses and permissions only. Growing catalogs are not bundled into that response. Existing callers without `compact=true` retain the older options response for compatibility.

`GET /return-workflows/lookup` accepts `kind`, `search` (literal text, maximum 100 characters), `page`, and `limit` (default 10, maximum 25). Kinds are customers, suppliers, parties, lots, locations, balances, sources, documents, document-lines, evidence, stocktakes and holds. Optional identity filters are warehouseId, customerId, supplierId, lotId, balanceId and documentId; locationKinds is a bounded comma-separated set. `sources` uses a workflow `purpose` and optional defect sourceKind. Responses use array `data` plus `meta.total/page/limit`. Queries recheck permissions and warehouse assignments, preserve Sales source ownership, and project only selection metadata. Source rows show advisory remaining claim quantity; balances show advisory free quantity. Actual commands still lock and revalidate all limits transactionally.

Large choices open searchable, paginated record tables. Changing warehouse, partner, balance or source clears dependent choices and entered source quantities. Quantities use exact decimal validation and the selected product's whole-unit rule. Detection can create a hold without a disposal proposal; no scrap direction is preselected. Actual quantities, supplier acknowledgement outcomes and actual receiving quality require deliberate entry. Stock changes and decisions receive a scope/consequence review before submission. Row identity is stable after partial-operation row removal. An evidence upload inside a command refreshes the version without remounting its form.

`GET /return-workflows/:id/context` returns only the currently authorized parent identity, version, warehouse and evidence-upload permission for external-reference creation. Existing parent evidence is searchable without granting upload permission. After evidence upload, the reference form waits for this version before submitting. External-reference lists now include pagination totals and bounded search. No payment or stock action is added.

`GET /lots/:id/trace/records?section=documents|movements|reservations|evidence|history&page=1&limit=10` loads one bounded trace section. It uses the same warehouse and Accountant purchasing restrictions as the existing trace route, scanning only source identities before fetching the selected page. Private storage fields and financial snapshots are excluded. The older full trace endpoint remains compatible. See the [UX review and verification record](RETURN_WORKFLOWS_UX_REVIEW_2026-11-07.md).

## Packaging, locks and stock

`InventoryBalance` uses holdingPointId/batchId/qualityStatus/ownerType/ownerId/quantityBase plus packagingPortions. STORE has no external owner ID; CUSTOMER/SUPPLIER stock has its actual owner. Every stock-changing command preserves exact quantities, acquires sorted location operation guards, checks LOCKED stocktake scopes, updates balance versions and packaging, records StockTransaction.movements, and checks destination capacity within its transaction.

`portions` declares actual SEALED/OPEN/LOOSE packaging. Incoming open/loose goods follow the receiving contract from main: use measuredVolumeMm3 when supplied, otherwise estimate from verified batch/product dimensions and reject missing dimensions. The user's outbound decision permits fractional-carton supplier dispatch and SCRAP execution: the shared split helper may open cartons or split known open portions, retaining conservative volumeUpperBoundMm3 on both fragments and no fabricated measurement. It prefers existing loose stock, preserves whole-base quantities, source caps and stock guards, and rejects a split without known volume/dimensions. Other movements keep the default whole-carton or whole-measured-portion restriction. See [Goods Issue outbound packaging](GOODS_ISSUES.md).

An active defect hold blocks its unresolved quantity, not automatically the entire balance. Reservations and pending tasks also reduce availability. Ordinary movements cannot consume held portions. Authorized defect execution and explicitly linked supplier returns consume only their selected hold. Existing multi-balance holds require explicit reconciliation before these execution commands; the API does not guess how a prior scalar resolution event should be allocated between balances.

## Historical-source decision and external results

In this implementation session the user explicitly confirmed: **“Yes—Accountant verifies with evidence.”** This authorizes the historical CR source workflow, not a broader new-sales-order verification gate. Broader D07/D08 decisions outside this scope remain open.

Historical creation is multipart with `file` and JSON `payload`: key/sourceSystem/referenceNo/referenceDate/correlationId/customerId/warehouseId/note and `lines[{productId,lotId,qtyBase,enteredUnit,baseUnitsPerUnit,returnedQty?}]`. Accountant verifies actual customer, warehouse, product/batch, historical conversion, delivered quantity and prior returns against uploaded evidence. No fake SO, GI or POD is created. Existing competing WMS source chains are rejected. Quantity claims serialize on the external source item and include prior returns. Sales can use only verified records with the required facts/evidence.

Ordinary external references remain linked to an authorized WMS parent/version and attachment; matched quantities are capped by source item and reference kind. Unique source identity/correlation indexes prevent duplicates. Invoice/Credit Note/refund/reconciliation references never execute money transfers, post stock or complete an SO.

Evidence accepts real bounded JPEG/PNG/PDF content through the existing file inspector, stores authenticated Cloudinary files, and retains owner/revision, checksum, actor and access category. Retrieval rechecks current parent/warehouse access and issues a short-lived signed URL. Price-restricted evidence and internal storage keys are excluded from these DTOs. Synthetic seed metadata is not proof of a real inspection or delivery; acceptance uses real uploads.

## Compatibility and rollout

No Atlas write, reseed, index creation or connection change is part of this port. The inspected Atlas database was `wmsd_database`; the old checkout selected `sep490`. Use a native isolated local database first. Never point these APIs at the old generic-document database. Existing defect rows with no derivable warehouse scope fail closed. No warehouse ID is guessed or backfilled.

New model fields are additive: supplier details have PROPOSED/VERIFIED phase, sourceBalanceId and optional defectHoldId; verified metadata remains mandatory in VERIFIED phase. Disposition details retain targetQuality. External references optionally store customer/warehouse/status/evidence/note and historical item conversion/lot/prior returns. CustodyRelease may embed supplier acknowledgements for supplier-owned handbacks. No new collection is introduced. Old external references without complete verified historical facts are not silently made return sources.

Before a separate approved rollout, review current native indexes and affected historical records against their real sources. Existing data is not rewritten by this feature. Runtime registry disables automatic collection/index creation. Keep real evidence, secrets and backups outside Git.

## Verification

Run `npm test`, `npm run test:returns`, `npm run docs:check`, and frontend `npm run build` plus the return-workflow tests. `test:returns` requires an isolated local replica set on `127.0.0.1:27028` named `wmsd_model_tests`. It creates a random `returns_test_<ObjectId>` database, checks that exact name before dropping only its own database, and never reads MONGODB_URI. It does not call Cloudinary. Current branch results and the known frontend full-suite failures are recorded in [verification evidence](RETURN_WORKFLOWS_VERIFICATION.md).

The suite exercises native model/validation contracts; actual defect, CR/FD, SR and historical claim transactions; partial execution; replay; stale versions; concurrent caps; freeze rollback; wrong roles/scope; rejected custody handback; custom permissions; HTTP authentication/options/trace; and acknowledgement correction. Shared native purchase/receiving/reversal/transfer tests remain separate. These are local automated checks, not an Atlas rollout or a real-image browser acceptance claim. Record current run results and any pre-existing FE suite failures in the PR evidence.
