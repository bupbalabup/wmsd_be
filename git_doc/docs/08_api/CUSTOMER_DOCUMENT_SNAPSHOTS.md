# Customer details on sales and return documents

## Customer details on documents — 17 November 2026

User decision: customers are not managed as catalogue records. New sales orders require `customerName` (1–160 characters) and allow `customerPhone` (up to 30 characters); the delivery address remains on the order. Creating an order does not query or create a Customer. Sales options return an empty compatibility `customers` array.

Customer-return creation sends warehouse and source lines only, without `customerId` or a customer selector. The server resolves name/phone from the source sales order or verified historical delivery and saves a snapshot on the return. Each new request is limited to one source document, while allowing multiple lines and split parts from that document. Warehouse access, source ownership/permissions, confirmed received quantity, claims, evidence, versions and idempotency remain enforced. Direct goods issues retain the sales-order link and no longer require a customer catalogue ID.

Historical verification requires customer name text and optional phone from the external document; verification/evidence remains mandatory. New historical sources with customer snapshots use the current inspection/acceptance/receipt flow without custody. Previously stored sources and custody ledgers retain their legacy behavior. Optional legacy customerId fields and the Customer collection remain readable; no records or collections are deleted or backfilled. Deploy FE and BE together; old clients sending customerId to new creation endpoints must update.

Validation: focused sales/return contract tests and the local direct-sales transaction test passed using an isolated database on the local rs0 replica set (port 27017). The transaction fixture creates a new sale and return with no Customer record, and separately verifies legacy custody compatibility. No Atlas write or migration was performed.
