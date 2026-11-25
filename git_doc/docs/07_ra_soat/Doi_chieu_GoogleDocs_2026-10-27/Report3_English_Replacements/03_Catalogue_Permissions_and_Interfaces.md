# Report 3: 174-use-case catalogue

Replace only section I.4.2, **Use Cases (UC)**, with the English text inside the replacement block. Convert the Markdown table to a document table and omit the wrapper tags. Keep the report template and all other sections. Use UC-01 through UC-174 from the new table. The actor associations, permission matrix, screens, diagrams and specifications in the older prompt set use a different numbering scheme. Their cross-references will need a separate update before they can be used with this catalogue.

## Replacement content

<replacement_text>

4.2 Use Cases (UC)
The catalogue contains 174 active use cases across nine features, numbered UC-01 through UC-174. List and detail remain separate operations. In replenishment, purchase ordering and goods inspection, saving a draft and then submitting, issuing or confirming it are steps of the creation use case. Other Goods Receipt keeps its separate submission and review operations. Authorization for review and stock posting follows the relevant operation.

| ID | Name | Feature | State | Description |
|---|---|---|---|---|
| UC-01 | View replenishment request list | FE-01 | ACTIVE | Sales and Warehouse Staff view their own/assigned replenishment needs; Owner and Accountant view within responsibility and warehouse scope. |
| UC-02 | View replenishment request details | FE-01 | ACTIVE | Show requested and available quantities, source demand, pending supply allocations and versioned approval history within authorized scope. |
| UC-03 | Create Replenishment Request | FE-01 | ACTIVE | Sales Staff and Warehouse Staff create a replenishment request for shortage needs within scope and send it to the Store Owner for approval; an unfinished form may be kept as a draft and completed later within this use case. The form shows server warnings about open requests, incoming purchase orders and available stock. |
| UC-04 | Update Replenishment Request | FE-01 | ACTIVE | Sales or Warehouse Staff edit only their own request while it is DRAFT or returned by the Store Owner for revision; server warnings are re-evaluated. |
| UC-05 | Review Replenishment Request | FE-01 | ACTIVE | Store Owner approves, rejects or returns the exact request version for revision in one decision. Requester and approver must be different userIds; no PO before approval. |
| UC-06 | Cancel Replenishment Request | FE-01 | ACTIVE | Cancel an eligible replenishment request with a reason; a request that already has a purchase order is handled through the PO flow. |
| UC-07 | View purchase order list | FE-01 | ACTIVE | Filter orders by supplier, date, status, and outstanding quantity. |
| UC-08 | View purchase order details | FE-01 | ACTIVE | Display purchase order lines, ordered, received, accepted and outstanding quantities, and partial receipt history with links to source receipts. |
| UC-09 | Create Purchase Order | FE-01 | ACTIVE | Accountant creates a purchase order against approved replenishment lines and issues it to the supplier, making it open for receiving; saving it as a draft first and issuing it later are steps of this use case. Quantities beyond approval require reapproval; does not execute payments. |
| UC-10 | Update Purchase Order | FE-01 | ACTIVE | Accountant edits a purchase order while it is DRAFT (not yet issued); the source replenishment request cannot be changed and quantities stay within the approved replenishment lines. |
| UC-11 | Reschedule Purchase Order Expected Date | FE-01 | ACTIVE | Accountant updates the supplier expected delivery date of an open purchase order with a reason, without altering receipt history. |
| UC-12 | Close Purchase Order | FE-01 | ACTIVE | Accountant closes unreceived purchase order quantities that will not be delivered, with reason and evidence. When no outstanding quantity remains the purchase order becomes CLOSED; past receipts are preserved. |
| UC-13 | Reopen Purchase Order | FE-01 | ACTIVE | Accountant reopens a CLOSED purchase order after one of its goods receipts was reversed; only the reversed quantity becomes receivable again and short-closed quantities stay closed. |
| UC-14 | Cancel Purchase Order | FE-01 | ACTIVE | Accountant cancels a DRAFT or issued purchase order that has no linked receiving document, with a reason. |
| UC-15 | View goods receipt list | FE-01 | ACTIVE | Search deliveries associated with purchase orders and their processing status. |
| UC-16 | View goods receipt details | FE-01 | ACTIVE | Display delivered, accepted, pending inspection, defective, and rejected quantities. |
| UC-17 | View product list | FE-02 | ACTIVE | Search products by item code, name, size, and status. |
| UC-18 | View product details | FE-02 | ACTIVE | Display tile attributes, packaging specifications, and units of measure. |
| UC-19 | Create Product | FE-02 | ACTIVE | Store Owner creates new product catalog entries with tile attributes and standard units. Does not modify inventory balances. |
| UC-20 | Update Product Information | FE-02 | ACTIVE | Store Owner updates product master metadata and attributes. Historical transaction snapshots remain preserved and unaltered. |
| UC-21 | Change Product Status | FE-02 | ACTIVE | Store Owner activates or deactivates products in the catalog without altering inventory balances or active order lines. |
| UC-22 | Define Packaging Conversion Version | FE-02 | ACTIVE | Store Owner defines versioned BOX/PIECE/M2 conversions. In-use versions and transaction snapshots cannot be overwritten. |
| UC-23 | Configure Warehouse Stock Policy | FE-02 | ACTIVE | Store Owner configures warehouse stock policy ensuring target >= minimum >= 0; policy changes do not auto-create orders or change stock. |
| UC-24 | View lot list | FE-02 | ACTIVE | Search lots by product, lot number, tone, and actual calibre. |
| UC-25 | View lot details | FE-02 | ACTIVE | Display production date, tone, actual calibre, and related transaction history. |
| UC-26 | Create Product Lot | FE-02 | ACTIVE | Store Owner and Warehouse Staff create new product lot records with lot number, tone, and actual calibre supported by evidence. |
| UC-27 | Update Product Lot Information | FE-02 | ACTIVE | Store Owner and Warehouse Staff update lot metadata with audit history; lot identity and carton specification cannot change once the lot has documents or stock. |
| UC-28 | View supplier list | FE-02 | ACTIVE | Search suppliers by code, name, and cooperation status. |
| UC-29 | View supplier details | FE-02 | ACTIVE | Display contact information and related purchases, receipts, and returns. |
| UC-30 | Create Supplier | FE-02 | ACTIVE | Accountant creates new supplier profiles with contact details and tax codes under separate operation permissions. |
| UC-31 | Update Supplier Information | FE-02 | ACTIVE | Accountant maintains and updates supplier contact details, address, and operational information. |
| UC-32 | Change Supplier Cooperation Status | FE-02 | ACTIVE | Store Owner controls supplier cooperation status (Active/Suspended/Terminated) with dedicated authorization. |
| UC-33 | View Unit of Measure List | FE-02 | ACTIVE | Authorized users view the code, name and status of units used by products and packaging conversions. |
| UC-34 | Create Unit of Measure | FE-02 | ACTIVE | Store Owner creates a unit of measure with a unique code and a name for use in products and packaging conversions. |
| UC-35 | Update Unit of Measure | FE-02 | ACTIVE | Store Owner renames an existing unit of measure. |
| UC-36 | Change Unit of Measure Status | FE-02 | ACTIVE | Store Owner activates or deactivates a unit of measure. |
| UC-37 | Create Goods Inspection | FE-03 | ACTIVE | Warehouse Staff inspects a delivery against open PO lines, recording actual counted quantities, lots, quality, evidence and destination locations, then confirms the inspection; saving it as a draft first and confirming it later are steps of this use case. Confirming creates the goods receipt to post (and a custody receipt where applicable) and changes no stock. Owner/Accountant may assist physically and be recorded in evidence; they do not inherit GR posting rights. Torn packaging alone is not damage. |
| UC-38 | Update Goods Inspection | FE-03 | ACTIVE | Warehouse Staff edits a goods inspection while it is DRAFT (not yet confirmed); stock is not changed. |
| UC-39 | Cancel Goods Inspection | FE-03 | ACTIVE | Warehouse Staff cancels a DRAFT goods inspection with a reason; no goods receipt is created and stock is not changed. |
| UC-40 | Post Goods Receipt | FE-03 | ACTIVE | Only Warehouse Staff can post eligible receipts, and each receipt is posted once. For a PURCHASE receipt from a confirmed inspection, post only accepted quantities into owned stock by quality and location. For an OTHER receipt, post the quantities on the version approved by the Store Owner. |
| UC-41 | Correct Goods Inspection | FE-03 | ACTIVE | Replace a confirmed inspection after correction preflight checks. |
| UC-42 | Reverse Goods Receipt | FE-03 | ACTIVE | Reverse a posted goods receipt after reversal preflight checks. |
| UC-43 | Create Other Goods Receipt | FE-03 | ACTIVE | Warehouse Staff creates a non-purchase goods receipt draft. |
| UC-44 | Update Other Goods Receipt | FE-03 | ACTIVE | Warehouse Staff edits an other goods receipt while it is DRAFT. |
| UC-45 | Cancel Other Goods Receipt | FE-03 | ACTIVE | Warehouse Staff cancels an other goods receipt in DRAFT with a reason. Cancellation records the outcome without posting stock. |
| UC-46 | Submit Other Goods Receipt | FE-03 | ACTIVE | Warehouse Staff submits an other goods receipt draft for Store Owner approval. |
| UC-47 | Review Other Goods Receipt | FE-03 | ACTIVE | Store Owner approves or rejects a submitted other goods receipt in one decision; the approver differs from the creator. |
| UC-48 | View Custody Receipt List | FE-03 | ACTIVE | View goods held in custody pending inspection resolution. |
| UC-49 | View Custody Receipt Details | FE-03 | ACTIVE | Show custody lines, reinspection results, decisions and releases. |
| UC-50 | Post Custody Receipt | FE-03 | ACTIVE | Post goods into custody locations without counting them as owned stock. |
| UC-51 | Reinspect Custody Goods | FE-03 | ACTIVE | Record reinspection quality results for goods in custody with evidence. |
| UC-52 | Record Custody Resolution Decision | FE-03 | ACTIVE | Decide to accept or return custody goods with reason and evidence. |
| UC-53 | Convert Custody Goods to Purchase Receipt | FE-03 | ACTIVE | Create a purchase goods receipt for accepted custody goods. |
| UC-54 | Post Custody Release | FE-03 | ACTIVE | Release returned custody goods to the supplier recipient. |
| UC-55 | View Warehouse List | FE-04 | ACTIVE | Search warehouses by code, name and status. |
| UC-56 | View Warehouse Details | FE-04 | ACTIVE | Display warehouse information, layout and its storage locations by area, aisle, rack and location code. |
| UC-57 | View storage location details | FE-04 | ACTIVE | Display capacity, status, and lot-level quantities at a location. |
| UC-58 | Create Warehouse | FE-04 | ACTIVE | Create a store warehouse with its basic information. |
| UC-59 | Update Warehouse Information | FE-04 | ACTIVE | Update warehouse information and status. |
| UC-60 | Design Warehouse Layout | FE-04 | ACTIVE | Design the 3D warehouse layout and map storage locations. |
| UC-61 | Create Storage Location | FE-04 | ACTIVE | Store Owner defines new storage bins and locations with capacity parameters. Does not move inventory or bypass freeze. |
| UC-62 | Update Storage Location Information | FE-04 | ACTIVE | Store Owner updates location identifiers and physical attributes. Does not move stock or alter inventory balances. |
| UC-63 | Change Storage Location Status | FE-04 | ACTIVE | Store Owner activates or deactivates storage locations. Locations containing active inventory or pending tasks cannot be deactivated. |
| UC-64 | View stock by lot, location, and quality status | FE-04 | ACTIVE | Show stock by warehouse/location/lot/quality/ownership, with reserved, available and in-transit quantities separated and restricted by data scope. |
| UC-65 | View inventory balance details | FE-04 | ACTIVE | Display physical, usable, reserved, available, custody and transit balances with source movements; do not double count staging/reservations. |
| UC-66 | View Low-Stock Alerts | FE-04 | ACTIVE | View products below their warehouse minimum, with available, minimum and target quantities. The system scans on a schedule (every 15 minutes by default), raises or resolves the alerts and leaves order creation to authorized users. |
| UC-67 | Scan Low-Stock Alerts | FE-04 | ACTIVE | Store Owner triggers an immediate rescan to refresh low-stock alerts and notifications. |
| UC-68 | View location movement list | FE-04 | ACTIVE | Search same-warehouse movements by lot and status. |
| UC-69 | View location movement details | FE-04 | ACTIVE | Display source, destination, and actual transferred quantities. |
| UC-70 | Create location movement | FE-04 | ACTIVE | Warehouse Staff selects compatible source/destination locations in the same warehouse and checks quantity, reservations and stocktake locks; no Owner approval or inter-warehouse TR. |
| UC-71 | Update Location Movement | FE-04 | ACTIVE | Edit an unconfirmed location movement. |
| UC-72 | Cancel Location Movement | FE-04 | ACTIVE | Cancel an unconfirmed location movement with a reason. |
| UC-73 | Confirm actual location movement | FE-04 | ACTIVE | Confirm actual relocation atomically: source minus q, destination plus q, same lot/quality/owner and total. Carry reservations and block locked locations. |
| UC-74 | View Opening Stock List | FE-04 | ACTIVE | View opening stock documents by warehouse and status. |
| UC-75 | View Opening Stock Details | FE-04 | ACTIVE | Show opening stock lines by product, lot, location and quality. |
| UC-76 | Create Opening Stock Document | FE-04 | ACTIVE | Preview and create an opening stock document for a warehouse. |
| UC-77 | Post Opening Stock Document | FE-04 | ACTIVE | Store Owner posts a draft opening stock document into inventory balances once. |
| UC-78 | Cancel Opening Stock Document | FE-04 | ACTIVE | Store Owner cancels a draft opening stock document; no stock is posted. |
| UC-79 | View warehouse transfer list | FE-05 | ACTIVE | View transfers between the configured warehouses, with request, dispatch, in-transit, receipt and difference status. Sales sees progress for transfers linked to its own demand. |
| UC-80 | View warehouse transfer details | FE-05 | ACTIVE | Show requested/approved, dispatched, received by quality, in-transit and unresolved quantities with separate dispatch and receipt documents. |
| UC-81 | Create Transfer Request | FE-05 | ACTIVE | Warehouse Staff requests physical movement between distinct warehouses after considering direct customer dispatch or other compatible sources. For movement within the same warehouse, use UC-70 (Create location movement) and UC-73 (Confirm actual location movement). |
| UC-82 | Update Transfer Request | FE-05 | ACTIVE | Edit a transfer request before review. |
| UC-83 | Cancel Transfer Request | FE-05 | ACTIVE | Cancel an eligible transfer request with a reason. |
| UC-84 | Review Transfer Request | FE-05 | ACTIVE | Store Owner approves/rejects/returns the TR version; requester differs from approver. Approved TR authorizes execution and controlled source reservation; no extra inter-warehouse TO approval. |
| UC-85 | Create Transfer Dispatch | FE-05 | ACTIVE | Source Warehouse Staff drafts a transfer dispatch from an approved transfer request before picking; creating the draft changes no stock. |
| UC-86 | Cancel Transfer Dispatch | FE-05 | ACTIVE | Source Warehouse Staff cancels a draft transfer dispatch before picking is confirmed. |
| UC-87 | Create Transfer Picking Task | FE-05 | ACTIVE | Source Warehouse Staff creates and assigns a picking task for a draft transfer dispatch from compatible source stock. |
| UC-88 | Confirm Transfer Picking Task | FE-05 | ACTIVE | Source Warehouse Staff confirms actual picked quantities; the dispatch is posted at handover and the quantities move to in-transit. |
| UC-89 | Post Transfer Receipt | FE-05 | ACTIVE | Destination Warehouse Staff, independent of the dispatcher, records actual received quantities by quality against the posted dispatch and posts the receipt in one step; discrepancies stay open. |
| UC-90 | Confirm Transfer Put-away Task | FE-05 | ACTIVE | Destination Warehouse Staff confirms put-away of received transfer goods into storage locations; the put-away task is created automatically when the receipt is posted. |
| UC-91 | Propose Transfer Difference | FE-05 | ACTIVE | Warehouse Staff reports an unresolved quantity difference between a posted transfer dispatch and its receipt, with evidence, for Store Owner review. |
| UC-92 | Review Transfer Difference | FE-05 | ACTIVE | Store Owner reviews a proposed inter-warehouse difference and decides its resolution without editing posted quantities; unmatched amounts stay open. |
| UC-93 | Close Transfer Request | FE-05 | ACTIVE | Close a transfer request fully or partially. |
| UC-94 | View Sales Order List | FE-06 | ACTIVE | Search sales orders within the user's scope by customer, external reference, date and status. View ordered, issued, customer-received, returned and outstanding quantities and the progress toward DELIVERED. |
| UC-95 | View Sales Order Details | FE-06 | ACTIVE | View the buyer and copied source lines, cancellations, linked goods issues, customer receipt evidence and receipts for undelivered goods. Trace related customer returns through the applicable source issues. Authorized roles can view the copied unit selling price, line amount and price revision. |
| UC-96 | Create Sales Order | FE-06 | ACTIVE | Sales Staff manually copies an externally verified order, such as a MISA order or paper document, with source order and line references, evidence, customer contact and delivery details, quantities and the agreed unit selling price. WMSD calculates line amounts from the copied price and rejects duplicate source orders or lines. Creation leaves stock unchanged. |
| UC-97 | Update Eligible Sales Order Remainder | FE-06 | ACTIVE | Sales Staff changes eligible quantities on the original order, including goods received back as undelivered and still available to reissue. The new quantity must cover existing commitments. Sales may revise the copied unit price before any quantity on that line is committed. Record the reason and preserve the price already captured on existing goods issues. |
| UC-98 | Cancel Eligible Sales Order Remainder | FE-06 | ACTIVE | Sales Staff cancels eligible unissued quantities with a reason. An active issue or unresolved off-site quantity remains committed until the underlying issue or return is resolved. |
| UC-99 | View goods issue list | FE-06 | ACTIVE | Search goods issues by source, issue date and status within the user's scope. |
| UC-100 | View goods issue details | FE-06 | ACTIVE | View the source order, lot, location, planning and actual issue quantities as applicable. For direct sales, view customer-received quantity, remaining unconfirmed quantity and receipts for undelivered goods. |
| UC-101 | Create goods issue | FE-06 | ACTIVE | Warehouse Staff creates a draft sales goods issue from an eligible sales order and selects the actual lot and source location in an assigned warehouse. Warehouse Staff can also create an other goods issue under the relevant permission. Draft creation leaves stock unchanged. |
| UC-102 | Update goods issue | FE-06 | ACTIVE | Warehouse Staff edits an eligible non-direct draft goods issue before preparation starts. To change the stock source of a direct sales issue, cancel the draft and create a new one. |
| UC-103 | Cancel Goods Issue | FE-06 | ACTIVE | Warehouse Staff cancels an eligible unposted goods issue with a reason. A direct sales issue can be cancelled while it is in DRAFT. |
| UC-104 | Post Goods Issue | FE-06 | ACTIVE | Warehouse Staff records the actual handover and posts the issue once, deducting stock. A direct sales issue posts from DRAFT using its selected stock sources. Customer receipt is confirmed separately on the posted issue. |
| UC-105 | Confirm Customer Delivery with Photo Evidence | FE-06 | ACTIVE | Sales Staff records the actual recipient, receipt time, quantity per line and photo evidence on a posted goods issue. Total customer-confirmed and received-back quantities share the posted quantity limit. The sales order reaches DELIVERED when all active quantities have been confirmed. |
| UC-106 | Receive Undelivered Goods | FE-06 | ACTIVE | Warehouse Staff receives undelivered goods back against the posted sales issue, recording quantities, quality, location, reason and evidence. Posting restores store stock and makes the returned quantity available to issue again under the original sales order. |
| UC-107 | View defective goods list | FE-07 | ACTIVE | Filter defect cases by source, product/lot/location, ownership, evidence, unresolved quantity and disposition. |
| UC-108 | View defective goods details | FE-07 | ACTIVE | Show affected quantity, ownership/custody, inspector, evidence, approval and related outcomes; no duplicate deduction across cases. |
| UC-109 | Record Defective Goods | FE-07 | ACTIVE | Warehouse Staff records suspect goods with photo evidence; the quantity is held immediately and blocked from allocation without changing inventory balances. |
| UC-110 | Submit Defective Goods Disposition Proposal | FE-07 | ACTIVE | Warehouse Staff compiles inspection findings and submits formal disposition proposal (destruction, regrade, release, or supplier return) for decision. |
| UC-111 | Review Defective Goods Disposition | FE-07 | ACTIVE | Store Owner approves or rejects the proposed release, regrade or scrap in one decision, outside stocktake; supplier return uses the supplier return flow without Owner. |
| UC-112 | Record approved defective goods disposition | FE-07 | ACTIVE | Warehouse executes the approved release, regrade or scrap outside freeze. |
| UC-113 | View customer return list | FE-07 | ACTIVE | Search customer returns by source, reason and inspection/receipt status. |
| UC-114 | View customer return details | FE-07 | ACTIVE | View the source issue or verified historical delivery, quantities, condition, assessment history, evidence, acceptance or exception decision, and posted receipt or handback. Historical custody and external references remain visible where applicable. |
| UC-115 | Create Customer Return Request | FE-07 | ACTIVE | Sales creates a customer return only against a customer-confirmed delivery or a verified historical delivery, within source caps. |
| UC-116 | Inspect Customer Return | FE-07 | ACTIVE | Warehouse Staff inspects the actual returned goods and records the received quantity, physical condition, policy eligibility and evidence. For new returns this inspection leaves stock unchanged and uses no customer custody location. |
| UC-117 | Decide Ordinary Customer Return Acceptance | FE-07 | ACTIVE | Sales Staff accepts, rejects, or returns ordinary customer return requests after warehouse inspection, including own created requests within policy limits. |
| UC-118 | Reassess Customer Return | FE-07 | ACTIVE | Warehouse Staff records a new assessment version with evidence when an inspected return needs correction. Earlier versions remain in the history. A posted receipt or a recorded handback blocks reassessment. |
| UC-119 | Review Eligible Customer Return Exception | FE-07 | ACTIVE | Store Owner reviews and decides eligible customer return exceptions. Approver must be distinct from requester; cannot override non-negotiable policy exclusions. |
| UC-120 | Post Customer Return Receipt | FE-07 | ACTIVE | Warehouse Staff posts GR-CR for accepted return lines into designated location/quality under approved return decision. Does not reopen sales demand. |
| UC-121 | Hand Back Rejected Customer Return | FE-07 | ACTIVE | Warehouse Staff hands rejected returned goods back to the customer and records the actual recipient, quantity and evidence. The handback leaves store-owned stock unchanged. |
| UC-122 | View supplier return request list | FE-07 | ACTIVE | Search by supplier, lot, reason, agreement and reconciliation status. |
| UC-123 | View supplier return request details | FE-07 | ACTIVE | Display lot, location, quantity, source receipt, verified supplier agreement, ACK and Accountant reconciliation outcome. |
| UC-124 | Create Supplier Return Request | FE-07 | ACTIVE | Warehouse proposes a source-linked supplier return (including goods held in custody) and isolates the affected goods. There is no Owner dispatch, variance or closure approval. |
| UC-125 | Record Supplier Return Agreement | FE-07 | ACTIVE | Accountant records the verified supplier agreement and agreed quantities with evidence before dispatch. |
| UC-126 | Confirm Supplier Return Dispatch | FE-07 | ACTIVE | Warehouse posts the actual supplier return issue or supplier-custody release within the agreed quantity, without Owner authorization. |
| UC-127 | Record Supplier Return Acknowledgement | FE-07 | ACTIVE | Accountant records the supplier acknowledgement per line as accepted, rejected or damaged, with evidence. |
| UC-128 | Close Supplier Return | FE-07 | ACTIVE | Accountant closes the reconciled supplier return without Owner. Unresolved disputes stay open; external financial status is independent. |
| UC-129 | View stocktake list | FE-08 | ACTIVE | Search stocktakes by warehouse, scope, cutoff time, and status. |
| UC-130 | View stocktake details | FE-08 | ACTIVE | View the included lots and locations, frozen book quantities, physical count attempts, difference reasons and approved results. For posted adjustments, show the adjustment reference, before and after quantities, approved change and recorded reason where available. |
| UC-131 | Create Stocktake Session | FE-08 | ACTIVE | Store Owner plans a stocktake session with warehouse, scope and counters. Planning does not take a snapshot or post stock. |
| UC-132 | Update Stocktake Session | FE-08 | ACTIVE | Store Owner updates the scope, cutoff and counters of a planned stocktake session before activation; no snapshot or stock change. |
| UC-133 | Activate Stocktake Session | FE-08 | ACTIVE | Warehouse Staff activates stocktake session, capturing immutable inventory snapshot and applying warehouse freeze atomically. |
| UC-134 | Print Stocktake Count Sheet | FE-08 | ACTIVE | Print the activated session's snapshot-based count sheet by location/lot/quality, with cutoff and space for counts and newly found items. Printing does not post stock. |
| UC-135 | Record Stocktake Count | FE-08 | ACTIVE | Warehouse Staff records physical counts as separate attempts and explicitly confirms empty locations. If goods are found after an empty confirmation, the counter corrects that confirmation by recording a new count with a reason and evidence. The earlier confirmation remains in the history. |
| UC-136 | Record Stocktake Difference Reason | FE-08 | ACTIVE | Warehouse Staff selects the reason for each line whose latest count differs from the book quantity; reasons are required before reconciliation. |
| UC-137 | Reconcile Stocktake Results | FE-08 | ACTIVE | Warehouse Staff hands the counted result over for Owner decision once every line has a count and every difference has a reason; no stock is posted and locks stay in place. |
| UC-138 | Request Stocktake Recount | FE-08 | ACTIVE | Request a recount for lines with unresolved count differences. |
| UC-139 | Approve Stocktake Differences | FE-08 | ACTIVE | Store Owner approves selected or all reconciled lines; approval posts the inventory adjustment for nonzero differences in the same transaction. When every line is settled, including sessions without variance, the session is completed and its locations are unlocked. The approver cannot approve lines they counted. |
| UC-140 | Cancel Stocktake Session | FE-08 | ACTIVE | Cancel an unfinished stocktake session and release locked locations. |
| UC-141 | View Stocktake Plan List | FE-08 | ACTIVE | View recurring stocktake plans and their status within warehouse scope. |
| UC-142 | View Stocktake Plan Details | FE-08 | ACTIVE | Show plan scope, schedule, generated stocktake sessions and history. |
| UC-143 | Create Stocktake Plan | FE-08 | ACTIVE | Define a recurring stocktake plan with warehouse, location scope and schedule. |
| UC-144 | Update Stocktake Plan | FE-08 | ACTIVE | Update scope and schedule of an active stocktake plan. |
| UC-145 | Change Stocktake Plan Status | FE-08 | ACTIVE | Store Owner pauses, resumes or ends a stocktake plan with a reason. |
| UC-146 | Generate Stocktake Session from Plan | FE-08 | ACTIVE | Generate a planned stocktake session from a stocktake plan. |
| UC-147 | Sign in to the system | FE-09 | ACTIVE | The account holder signs in with a username or email and password. Active accounts can access functions and warehouses within their assigned permissions. |
| UC-148 | Sign Out | FE-09 | ACTIVE | The signed-in user ends the session and the refresh token is revoked. |
| UC-149 | View and Update Own Profile | FE-09 | ACTIVE | The signed-in user views own account, role and warehouses and updates personal contact information; role and warehouses cannot be self-changed. |
| UC-150 | Change Own Password | FE-09 | ACTIVE | The signed-in user changes the password after entering the current password; other sessions are signed out. |
| UC-151 | Change Own Email with OTP | FE-09 | ACTIVE | The signed-in user changes the registered email after verifying a one-time password sent to the new address. |
| UC-152 | Reset Own Password by Email | FE-09 | ACTIVE | An account holder requests a one-time password sent to the registered email address and uses it to set a new password. |
| UC-153 | View account list | FE-09 | ACTIVE | Search and filter accounts by name, role, and active status. |
| UC-154 | View account details | FE-09 | ACTIVE | Display the selected account's information, assigned role, and status. |
| UC-155 | Create Staff Account | FE-09 | ACTIVE | Administrator creates a staff account with exactly one role and its assigned warehouses; the initial password is generated and emailed. Inactive accounts cannot sign in. |
| UC-156 | Update Staff Account Information | FE-09 | ACTIVE | Administrator updates profile, contact information, role and assigned warehouses of a staff account. A change to the account email requires verification of the new address by OTP. |
| UC-157 | Change Staff Account Status | FE-09 | ACTIVE | Administrator activates or deactivates staff accounts. Inactive accounts are blocked from authentication and maintain single-role integrity. |
| UC-158 | View Role List | FE-09 | ACTIVE | View default and custom roles with their permissions. |
| UC-159 | Create Role | FE-09 | ACTIVE | Administrator creates a custom role by selecting existing permissions; a custom role is evaluated by its permissions, never by its name. |
| UC-160 | Update Role Permissions | FE-09 | ACTIVE | Administrator changes the permissions of a role; changes affect subsequent requests and never rewrite historical actors or decisions. |
| UC-161 | View Notifications | FE-09 | ACTIVE | Users view in-app notifications within scope, see the unread count and mark notifications as read. WMSD sends configured status emails in the background and records delivery status. An email failure leaves the committed business operation intact. |
| UC-162 | Quick Search | FE-09 | ACTIVE | Search documents, products, lots and locations by code or name across modules, returning only records within the user's role and warehouse scope. |
| UC-163 | View Owner Dashboard | FE-09 | ACTIVE | Store Owner views operational counts, pending work, outstanding receipts and issues, inventory warnings and recent activity within scope. |
| UC-164 | View Operational Reports | FE-09 | ACTIVE | Run authorized reports for physical, available, reserved, custody and in-transit stock, purchases, receipts, issues, sales fulfilment, defects, transfers, returns, stocktakes and posted inventory adjustments. Use the adjustment report to review recorded quantity changes and their stocktake references. |
| UC-165 | View stock movement log | FE-09 | ACTIVE | Filter movements by product, lot, location, transaction type, and time. |
| UC-166 | View stock movement details | FE-09 | ACTIVE | Display source document, before/after quantity, operator, time, and reason. |
| UC-167 | View Audit Log List | FE-09 | ACTIVE | Administrator searches audit logs by user, action, document type and time. |
| UC-168 | View Audit Log Details | FE-09 | ACTIVE | Display the actor, time, action, target document and changed fields (before/after) of an audit entry. |
| UC-169 | View and Resolve Error Logs | FE-09 | ACTIVE | Administrator views system error logs and marks an investigated error as resolved with a note. |
| UC-170 | Manage API Endpoint Permissions | FE-09 | ACTIVE | Administrator synchronizes discovered API routes, maintains endpoint names and descriptions, adds manual entries, and records whether entries are active. |
| UC-171 | View System Monitor | FE-09 | ACTIVE | Administrator views system health indicators such as service status, background jobs and recent request/error statistics. |
| UC-172 | Trace a product lot through source documents | FE-09 | ACTIVE | Trace lots across external source, sales order, goods issue and customer delivery confirmation, and linked receipts, movements, returns and adjustments with evidence and user/time history. |
| UC-173 | Verify Historical Customer Delivery Source | FE-09 | ACTIVE | Accountant verifies historical delivered order and line sources for customer documentation. Does not create POD or execute payments. |
| UC-174 | Record External Document Reference | FE-09 | ACTIVE | Accountant records external Invoice, Credit Note, refund, or tax references against matched quantities without triggering cash or stock changes. |

</replacement_text>

## Historical reference for the 97-use-case edition

The following actor, permission and system functionality sections reproduce the previous edition. Keep them as reference for the old UC and screen identifiers. Only the replacement block above applies to this edit.

4. User Requirements
4.1 Actors
Updated 25 October 2026, baseline 3.1.0 under survey decisions D1–D8. Exactly five application roles remain. Warehouse Staff is the canonical name for the existing Inventory Staff role, not an additional role. Each department records and confirms its own work using personal accounts (D2). Purchasing and delivery personnel may be external business participants but receive no new application role (D3). Survey-reported delegation does not automatically confer software approval rights.
#
	Actor
	Description
	1
	Store Owner
	Approve replenishment, TR, scoped on-site dispositions, eligible CR exceptions and B1 resolution; plan stocktake and perform Clear Difference. Distinct requester for Owner decisions. No BF-08 dispatch/variance/closure approval.
	2
	Accountant
	Create PO after approval; verify supplier agreements, reconcile ACK/variances and close supplier-return warehouse work via UC-83/107; record independent external Invoice/Credit Note references. No stock posting or operational demand origination.
	3
	Warehouse Staff
	Receive, inspect, put away, pick, post actual dispatch/receipt, relocate, count and isolate within assigned warehouses; confirm customer receipt with mandatory photo POD (UC-110). Source and destination transfer confirmations are independent.
	4
	Sales Staff
	Copy verified external SO, manage linked WIR/OD/net reopened demand; accept/reject ordinary CR after Warehouse inspection, including own CR (C2), but no exception approval. Confirm full external payment after current DELIVERED (UC-111).
	5
	Administrator
	Accounts, operation permissions and technical configuration; no implied business approval or stock-posting rights.

4.3 Use Case Actor Associations
The following associations derive from operation-level rights. Viewing a record does not authorize confirmation or posting.
Store Owner: UC-01, UC-02, UC-04, UC-05, UC-06, UC-08, UC-09, UC-11, UC-12, UC-13, UC-14, UC-15, UC-16, UC-17, UC-18, UC-19, UC-20, UC-21, UC-27, UC-28, UC-29, UC-30, UC-31, UC-34, UC-35, UC-38, UC-39, UC-41, UC-44, UC-45, UC-46, UC-49, UC-50, UC-52, UC-53, UC-56, UC-57, UC-63, UC-64, UC-66, UC-68, UC-69, UC-71, UC-79, UC-80, UC-83, UC-84, UC-85, UC-86, UC-89, UC-90, UC-92, UC-93, UC-94, UC-99, UC-100, UC-101, UC-102, UC-103, UC-105, UC-109, UC-110, UC-111.
Accountant: UC-01, UC-02, UC-05, UC-06, UC-07, UC-08, UC-09, UC-11, UC-12, UC-17, UC-18, UC-19, UC-20, UC-21, UC-30, UC-31, UC-38, UC-39, UC-45, UC-46, UC-49, UC-50, UC-52, UC-53, UC-56, UC-57, UC-68, UC-69, UC-79, UC-80, UC-83, UC-94, UC-99, UC-100, UC-101, UC-102, UC-107, UC-108, UC-109, UC-110, UC-111.
Warehouse Staff: UC-01, UC-02, UC-03, UC-05, UC-06, UC-08, UC-09, UC-10, UC-11, UC-12, UC-14, UC-15, UC-16, UC-20, UC-21, UC-26, UC-27, UC-28, UC-30, UC-31, UC-32, UC-33, UC-34, UC-35, UC-36, UC-37, UC-38, UC-39, UC-40, UC-43, UC-45, UC-46, UC-49, UC-50, UC-52, UC-53, UC-54, UC-55, UC-56, UC-57, UC-58, UC-63, UC-64, UC-65, UC-67, UC-68, UC-69, UC-72, UC-73, UC-79, UC-80, UC-81, UC-82, UC-84, UC-85, UC-87, UC-88, UC-89, UC-90, UC-91, UC-94, UC-99, UC-100, UC-101, UC-102, UC-103, UC-104, UC-105, UC-109, UC-110, UC-111.
Sales Staff: UC-01, UC-02, UC-03, UC-11, UC-12, UC-20, UC-21, UC-22, UC-30, UC-31, UC-38, UC-39, UC-45, UC-46, UC-47, UC-48, UC-49, UC-50, UC-51, UC-52, UC-53, UC-56, UC-57, UC-68, UC-69, UC-70, UC-71, UC-94, UC-103, UC-109, UC-110, UC-111.
Administrator: UC-94, UC-95, UC-96, UC-97, UC-98.

4.4 Permission Matrix
Operation/sub-operation rights require assigned warehouse, document state/version and actual user identity. Each user has exactly one role; the Owner decision requester must differ even after role reassignment; C2 permits Sales own ordinary inspected CR acceptance. BF-08 has no Owner approval; transfer receiver differs from dispatcher. Departments record their own work. Co-inspection/external contact grants no extra right. View never implies mutation.
| UC | Operation | Store Owner | Accountant | Warehouse Staff | Sales Staff | Administrator |
|---|---|---|---|---|---|---|
| UC-01 | View replenishment request list | View | View | Own / assigned scope | Own / assigned scope | — |
| UC-02 | View replenishment request details | View | View | Own / assigned scope | Own / assigned scope | — |
| UC-03 | Create replenishment request | — | — | Create | Create | — |
| UC-04 | Approve or reject replenishment request | Approve / reject / return; not requester | — | — | — | — |
| UC-05 | View purchase order list | View | View | Receiving scope only | — | — |
| UC-06 | View purchase order details | View | View | Receiving scope only | — | — |
| UC-07 | Manage Purchase Order and Supplier Confirmation | — | Perform | — | — | — |
| UC-08 | View goods receipt list | View | View | View | — | — |
| UC-09 | View goods receipt details | View | View | View | — | — |
| UC-10 | Create goods receipt from purchase order | — | — | Perform in assigned warehouse | — | — |
| UC-11 | View product list | View | View | View | View | — |
| UC-12 | View product details | View | View | View | View | — |
| UC-13 | Maintain Product and Packaging | Perform | — | — | — | — |
| UC-14 | View lot list | View | — | View | — | — |
| UC-15 | View lot details | View | — | View | — | — |
| UC-16 | Maintain Product Lot | Create / Update | — | Create only | — | — |
| UC-17 | View supplier list | View | View | — | — | — |
| UC-18 | View supplier details | View | View | — | — | — |
| UC-19 | Maintain Supplier | Activate / Deactivate | Create / Update | — | — | — |
| UC-20 | View Customer List | View | Reference scope | Delivery scope | View | — |
| UC-21 | View Customer Details | View | Reference scope | Delivery scope | View | — |
| UC-22 | Maintain Customer | — | — | — | Maintain contact / delivery reference | — |
| UC-26 | Inspect and Post Goods Receipt | — | — | Perform in assigned warehouse | — | — |
| UC-27 | View warehouse and location list | View | — | View | — | — |
| UC-28 | View storage location details | View | — | View | — | — |
| UC-29 | Maintain Storage Location | Perform | — | — | — | — |
| UC-30 | View stock by lot, location, and quality status | View | Reconciliation scope | Assigned warehouse | Available / related demand only | — |
| UC-31 | View inventory balance details | View | Reconciliation scope | Assigned warehouse | Available / related demand only | — |
| UC-32 | Create Put-away Task | — | — | Perform in assigned warehouse | — | — |
| UC-33 | Confirm Put-away Task | — | — | Perform in assigned warehouse | — | — |
| UC-34 | View location movement list | View | — | View | — | — |
| UC-35 | View location movement details | View | — | View | — | — |
| UC-36 | Create location movement | — | — | Perform in assigned warehouse | — | — |
| UC-37 | Confirm actual location movement | — | — | Perform in assigned warehouse | — | — |
| UC-38 | View warehouse transfer list | View | Reconciliation scope | Assigned warehouses | Related demand progress | — |
| UC-39 | View warehouse transfer details | View | Reconciliation scope | Assigned warehouses | Related demand progress | — |
| UC-40 | Create Transfer Request | — | — | Create | — | — |
| UC-41 | Review Transfer Request | Approve / reject / return; not requester | — | — | — | — |
| UC-43 | Record Transfer Dispatch | — | — | Draft TD before picking; confirm TO execution; post actual handover | — | — |
| UC-44 | Review Transfer Difference Resolution | Review transfer variance | — | — | — | — |
| UC-45 | View Copied Sales Order List | View | Reconciliation scope | Related execution | Own / assigned demand | — |
| UC-46 | View Copied Sales Order Details | View | Reconciliation scope | Related execution | Own / assigned demand | — |
| UC-47 | Create Copied Sales Order | — | — | — | Perform within unexecuted quantity | — |
| UC-48 | Update or Cancel Unissued Sales Order Remainder | — | — | — | Edit/cancel unexecuted or GR-FD-received-back, not-redelivered quantity | — |
| UC-49 | View Outbound Delivery List | View | Reconciliation scope | Related execution | Own / assigned demand | — |
| UC-50 | View Outbound Delivery Details | View | Reconciliation scope | Related execution | Own / assigned demand | — |
| UC-51 | Create Outbound Delivery | — | — | — | Plan OD/reuse or transfer reopened commitment without duplicate demand | — |
| UC-52 | View Picking Task List | View | Reconciliation scope | Assigned warehouse | Related progress | — |
| UC-53 | View Picking Task Details | View | Reconciliation scope | Assigned warehouse | Related progress | — |
| UC-54 | Create Picking Task | — | — | Perform; PGI only on actual handover | — | — |
| UC-55 | Confirm Picking Task | — | — | Perform; PGI only on actual handover | — | — |
| UC-56 | View goods issue list | View | Reconciliation scope | Assigned warehouse | Related progress | — |
| UC-57 | View goods issue details | View | Reconciliation scope | Assigned warehouse | Related progress | — |
| UC-58 | Post Goods Issue | — | — | Draft GI-S before picking; post actual handover once | — | — |
| UC-63 | View defective goods list | View | — | View | — | — |
| UC-64 | View defective goods details | View | — | View | — | — |
| UC-65 | Inspect Defective Goods and Submit Disposition | — | — | Inspect / isolate / propose | — | — |
| UC-66 | Approve or reject defective goods disposition | Approve on-site scrap/regrade/release outside ST; not requester | — | — | — | — |
| UC-67 | Record approved defective goods disposition | — | — | Execute approved on-site action outside freeze; B1 through UC-93 | — | — |
| UC-68 | View customer return list | View | External follow-up | Inspection / receipt scope | Own / assigned returns | — |
| UC-69 | View customer return details | View | External follow-up | Inspection / receipt scope | Own / assigned returns | — |
| UC-70 | Create Customer Return Request | — | — | — | Create / check source and conditions | — |
| UC-71 | Decide Customer Return Acceptance | Eligible EXCEPTION_APPROVAL only; not requester | — | — | STANDARD_ACCEPTANCE after inspection; own ordinary CR allowed | — |
| UC-72 | Inspect Return or Failed-Delivery Intake | — | — | Inspect CR/custody/D6 or GI-linked FD without customer custody | — | — |
| UC-73 | Post Customer Return or Failed-Delivery Receipt | — | — | Post GR-CR under proper decision or GR-FD with atomic net reopening | — | — |
| UC-79 | View supplier return request list | View | Agreement / reconciliation scope | Assigned warehouse | — | — |
| UC-80 | View supplier return request details | View | Agreement / reconciliation scope | Assigned warehouse | — | — |
| UC-81 | Create Supplier Return Request | — | — | Propose/isolate; Accountant agreement, no Owner | — | — |
| UC-82 | Confirm Supplier Return Dispatch | — | — | Post actual agreed GI-SR/custody release; no Owner | — | — |
| UC-83 | Review Supplier Return Closure | View | Reconcile and close accounted warehouse quantities | — | — | — |
| UC-84 | View stocktake list | View | — | View | — | — |
| UC-85 | View stocktake details | View | — | View | — | — |
| UC-86 | Create Stocktake Session | Plan session | — | — | — | — |
| UC-87 | Perform Stocktake Count and Record Results | — | — | Count / reconcile / propose within locked scope | — | — |
| UC-88 | Reconcile Stocktake | — | — | Count / reconcile / propose within locked scope | — | — |
| UC-89 | View inventory adjustment request list | View | — | View | — | — |
| UC-90 | View inventory adjustment request details | View | — | View | — | — |
| UC-91 | Create Inventory Adjustment Request | — | — | Propose B1 delta/RECLASS/location and confirm execution | — | — |
| UC-92 | Approve Stocktake Resolution | Approve/return current B1 resolution; not requester | — | — | — | — |
| UC-93 | Clear Stocktake Difference | Post approved B1 batch after Warehouse execution; unlock resolved scope | — | — | — | — |
| UC-94 | Sign in to the system | Use | Use | Use | Use | Use |
| UC-95 | View account list | — | — | — | — | View |
| UC-96 | View account details | — | — | — | — | View |
| UC-97 | Maintain Staff Account | — | — | — | — | Perform |
| UC-98 | Assign roles and operation permissions | — | — | — | — | Maintain existing role / operation / warehouse scope |
| UC-99 | View Operational Reports | All report groups | Movement; purchase/receipt | Movement; stock; transfer; stocktake | — | — |
| UC-100 | View stock movement log | View | Purchase / supplier scope | View | — | — |
| UC-101 | View stock movement details | View | Purchase / supplier scope | View | — | — |
| UC-102 | Trace a product lot through source documents | View | Purchase / supplier scope | View | — | — |
| UC-103 | View and Select Shortage Fulfilment Options | View | — | View / select stock option | View / confirm customer fulfilment | — |
| UC-104 | Inspect and Post Transfer Receipt | — | — | Destination receive/post; independent from dispatcher | — | — |
| UC-105 | Export or Print Stocktake Count Sheet | Export / print | — | Export / print assigned scope | — | — |
| UC-107 | Record Supplier Agreement and Receipt Acknowledgement | — | Record / verify external evidence | — | — | — |
| UC-108 | Record External Document References | — | Record / verify external evidence | — | — | — |
| UC-109 | Manage Linked Warehouse Issue Request | View | Reconciliation scope | Related execution view | Manage net WIR/reopened demand; cancel eligible remainder | — |
| UC-110 | Confirm Customer Delivery with Photo Evidence | View | Reconciliation scope | Confirm / correct POD in assigned warehouse | Related progress view | — |
| UC-111 | Confirm Full External Payment Receipt | View | Reconciliation scope; no confirmation | Related progress view; no confirmation | Confirm / correct full external receipt after DELIVERED | — |

5. System Functionalities
5.1 Screen Inventory and Navigation
Sign in→scoped worklists. RR→PO→inspection/GR→put-away; copied SO→linked WIR→options→OD→pick→PGI→photo POD/DELIVERED→Sales PAY-CFM/COMPLETED; TR→TD→independent MWTR→variance; defect→disposition→supplier return; CR→custody/inspection→Sales ordinary or Owner eligible exception→GR-CR/handback; failed-delivery GI-S→ARR/INS→GR-FD/net reopening; stocktake→freeze/count/hold→direct explanation or recount→B1 plan/execution→UC-92/93 batch. Supplier return agreement/dispatch/ACK/reconcile/closure has no Owner approval. Documents link external evidence to SC-28. Retired screens absent from active navigation.
| Screen | Name | State | Linked UC |
|---|---|---|---|
| SC-01 | Sign In | ACTIVE | UC-94 |
| SC-02 | Accounts and Permissions | ACTIVE | UC-95, UC-96, UC-97, UC-98 |
| SC-03 | Products and Packaging | ACTIVE | UC-11, UC-12, UC-13 |
| SC-04 | Product Lots | ACTIVE | UC-14, UC-15, UC-16 |
| SC-05 | Suppliers | ACTIVE | UC-17, UC-18, UC-19 |
| SC-06 | Replenishment Requests | ACTIVE | UC-01, UC-02, UC-03, UC-04 |
| SC-07 | Purchase Orders | ACTIVE | UC-05, UC-06, UC-07 |
| SC-08 | Goods Receipt, Inspection and Put-away | ACTIVE | UC-08, UC-09, UC-10, UC-26, UC-32, UC-33 |
| SC-09 | Warehouse Locations | ACTIVE | UC-27, UC-28, UC-29 |
| SC-10 | Inventory and Shortage Options | ACTIVE | UC-30, UC-31, UC-103 |
| SC-11 | Defective Goods and Disposition | ACTIVE | UC-63, UC-64, UC-65, UC-66, UC-67 |
| SC-12 | Location Movements | ACTIVE | UC-34, UC-35, UC-36, UC-37 |
| SC-13 | Warehouse Transfers, Dispatch and Receipt | ACTIVE | UC-38, UC-39, UC-40, UC-41, UC-43, UC-44, UC-104 |
| SC-14 | Stocktake Sessions, Count Sheet and Counts | ACTIVE | UC-84, UC-85, UC-86, UC-87, UC-88, UC-105 |
| SC-15 | Stocktake Resolution and Clear Difference | ACTIVE | UC-89, UC-90, UC-91, UC-92, UC-93 |
| SC-16 | Copied Sales Orders and Progress | ACTIVE | UC-45, UC-46, UC-47, UC-48, UC-103 |
| SC-17 | Goods Issue and Actual Handover | ACTIVE | UC-56, UC-57, UC-58 |
| SC-18 | Customer Return and Failed-Delivery Intake | ACTIVE | UC-68, UC-69, UC-70, UC-71, UC-72, UC-73 |
| SC-19 | Supplier Return, Agreement and Acknowledgement | ACTIVE | UC-79, UC-80, UC-81, UC-82, UC-83, UC-107 |
| SC-20 | Operational Reports | ACTIVE | UC-99 |
| SC-21 | Stock Movement and Lot Trace | ACTIVE | UC-100, UC-101, UC-102 |
| SC-22 | Outbound Deliveries | ACTIVE | UC-49, UC-50, UC-51 |
| SC-23 | Picking Tasks | ACTIVE | UC-52, UC-53, UC-54, UC-55 |
| SC-24 | Customer Delivery References | ACTIVE | UC-20, UC-21, UC-22 |
| SC-28 | External Document References | ACTIVE | UC-108 |
| SC-29 | Linked Warehouse Issue Requests | ACTIVE | UC-109 |
| SC-30 | Customer Delivery and Photo Evidence | ACTIVE | UC-110 |
| SC-31 | External Payment Receipt Confirmation | ACTIVE | UC-111 |

5.2 External API Inventory
| ID | Interface | Contract |
|---|---|---|
| API-01 | Server-side SMTP | Queued warehouse status→delivery/failure after commit; no invoice/refund workflow email. |
| API-02 | Controlled evidence storage | Authorized upload/fetch→private asset reference/hash/result; document/warehouse scope and server-side credentials. Provider not fixed. Missing mandatory evidence blocks confirmation. |
No MISA, Zalo, payment or tax-authority API in selected scope.

5.3 Background Job Inventory
JOB-01 processes committed warehouse-notification outbox: event key, delivery/failure/attempts/retry. Deduplicate events and do not deliberately resend recorded success. SMTP uncertain timeout requires reconciliation; end-to-end exactly-once email delivery cannot be assumed. Notification retry never repeats inventory.
Finite minimum-stock evaluation occurs on authorized query or committed balance/reservation changes; no automatic PO or duplicate proposal. Monthly stocktake manually planned by Owner; no auto-session job.
