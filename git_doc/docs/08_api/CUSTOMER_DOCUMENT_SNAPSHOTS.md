# Customer details on sales and return documents

## Customer details on documents — 18 November 2026

User decision: customers are not managed as catalogue records. New sales orders require `customerName` (1–160 characters) and allow `customerPhone` (up to 30 characters); the delivery address remains on the order. Creating an order does not query or create a Customer. Sales options return an empty compatibility `customers` array.

Customer-return creation uses a posted SALE Goods Issue line or a verified historical delivery, without a `customerId` or customer catalogue lookup. It works when no Sales Order exists. The server uses customer details on the source when available; otherwise the requester supplies `customerName` (1–160 characters). An order-linked return can combine issue lines from the same purchase request, handling warehouse and intake mode. Standalone and verified historical returns each use one source document. For SO-linked issues, the cap is confirmed customer-received quantity; standalone issues use the effective posted issue quantity less posted undelivered receipts and outstanding failed-delivery claims. CR claims reduce both caps. Warehouse access, source ownership/permissions, evidence, versions and idempotency remain enforced.

Historical verification requires customer name text and optional phone from the external document; verification/evidence remains mandatory. New historical sources with customer snapshots use the current inspection/acceptance/receipt flow without custody. Previously stored sources and custody ledgers retain their legacy behavior. Optional legacy customerId fields and the Customer collection remain readable; no records or collections are deleted or backfilled. Deploy FE and BE together; old clients sending customerId to new creation endpoints must update.

Validation: focused sales/return contract tests and the local direct-sales transaction test passed using an isolated database on the local rs0 replica set (port 27017). The transaction fixture creates a new sale and return with no Customer record, and separately verifies legacy custody compatibility. No Atlas write or migration was performed.
