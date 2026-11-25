# Sales order delivery schedule

The 25 November 2026 user decision applies to new sales orders. Enter the customer name and optional phone on the order itself. Upload the source evidence first, then submit the signed receipt and the external order reference. Sales order creation and schedule edits use these customer fields directly.

`POST /api/sales-orders` requires a verified lot on every line and at least one entry in `deliveries`. Each delivery supplies `plannedOn`, `warehouseId`, and `lines` with `lineKey` and `quantity`. Use the sales line's `sourceLineKey` and sales unit. The total across deliveries must match the order quantity after conversion to base units. The date uses the Vietnam business day.

The order, external reference, attachment metadata, schedule, and FIFO stock reservations commit together. Reservations point to the `LG` schedule ID paired with the order number. One schedule belongs to each new order. Existing orders with no schedule still use their direct goods issues or legacy issue requests. Requests to issue directly, edit the remainder, or cancel the remainder of a scheduled order are rejected.

`PUT /api/sales-orders/:id` updates a scheduled order and its editable deliveries. `POST /api/sales-orders/:id/cancel` cancels an eligible scheduled order and releases its holds. The delivery schedule list is at `GET /api/delivery-schedules`, and delivery order commands are under `/api/delivery-orders`. Store workers see deliveries and item quantities in their assigned warehouses. Orders and historical sources keep their existing access checks.

For an existing database, deploy the backend and the updated sales order form together. Provision `delivery_schedules` and its declared indexes, and sync the new permissions before opening the workflow. Existing orders and historical customer references require no backfill.
