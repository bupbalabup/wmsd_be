# WHMS Goods Issue, Return and Notification Verification

Updated 25 November 2026. Work was performed on the existing `trungph` branches in the frontend and backend repositories. Existing user data and unrelated changes were left intact.

## Current workflow contract

- New sales use a Sales Order and a direct posted Goods Issue. Sales records the customer's receipt on that Goods Issue, including recipient, time, quantity and evidence. A Customer Return from this flow is limited by confirmed customer-received quantity and outstanding claims.
- Return-source options use active stock transactions to show the actual issued lot or lots and remaining quantity per lot. Sales may split one source across lots. The selected lot is retained through inspection, decision and Goods Receipt.
- Legacy warehouse-created standalone `SALE` Goods Issues do not have customer-receipt confirmation. They remain eligible as Customer Return sources up to posted quantity less undelivered claims and existing returns. New standalone manual Sale issue creation is rejected.
- A Supplier Return links to a posted Purchase Receipt. `GI_SUPPLIER_RETURN` records the outbound stock dispatch. The Accountant records the supplier's response as `ACK_SR` on the Supplier Return; Goods Issue has no vendor confirmation field. Closing the return does not move stock.

## Automated verification

| Repository | Check | Result |
|---|---|---|
| Backend | `npm test` | 302 passed, 139 skipped, 0 failed (441 total). |
| Backend | `RUN_HIEUDT_TESTS=1 npm run test:returns` | 26 passed, 0 failed on the isolated `hieudt-test` replica set. |
| Backend | `RUN_GOODS_ISSUE_TESTS=1 RUN_HIEUDT_TESTS=1 node --test test/direct-sales.integration.test.js` | 1 passed. Covers direct and legacy sources, lot caps, multi-lot Customer Return receipt, stock and notifications. |
| Backend | `RUN_GOODS_ISSUE_TESTS=1 MONGODB_TEST_PORT=27020 MONGODB_TEST_REPLICA_SET=whmsRehearsal node --test test/goods-issues.integration.test.js` | 4 passed. The legacy Goods Issue test now seeds its historical pre-schedule Sales Order directly and covers request-based issue, role scope, once-only posting and manual issue approval. |
| Backend | Local evidence provider tests | Passed in `npm test`; the Cloudinary live test is skipped without credentials. |
| Backend | `npm run docs:check` | Passed: 3 instruction files identical, 62 collections, 1094 local links and change-log signals. |
| Frontend | `pnpm exec vitest run src/features/goods-issues src/features/return-workflows` | 60 passed across 8 files. |
| Frontend | Focused ESLint, `pnpm typecheck`, `pnpm build` | Passed. |
| Frontend | `pnpm test` | 760 passed, 9 failed across 5 files (769 total). The failures are the same unrelated baseline failures: 4 Create Account tests, 1 profile email-OTP timeout, 1 replenishment table test, 1 transfer-receipt test and 2 transfer-flow tests. |

## Browser rehearsal and isolated fixtures

All rehearsal records are synthetic and explicitly marked as demo-only. Supplier actions were simulated; no customer or supplier was contacted.

| Flow | Fixture and observed result |
|---|---|
| Customer Return | `ĐTK-K-GACH-01-261125-000002` completed at version 5. Warehouse inspected one piece of lot `AP6601-260928-B`; Sales approved one; Warehouse posted `PNKT-K-GACH-01-261125-000001` to `G-01-2` as good stock. The original lot is visible on both the return and receipt. The lot balance moved from 104 to 105 exactly once. |
| Supplier Return | `ĐTNCC-K-GACH-01-261125-000002` completed at version 9 after agreement, dispatch, simulated supplier acknowledgement and close. Source lot balance `AP6601-261001-A` moved from 330 to 329 on dispatch; acknowledgement and close added no stock movement. |

Warehouse, Sales and Accountant roles completed their applicable browser actions. Each stage produced the expected in-app notification for the other responsible role; the worker's per-user event keys prevent duplicate deliveries. Supplier notifications after acknowledgement and closure returned to the Warehouse requester. Customer Return inspection, approval and receipt notifications reached Sales/Warehouse as expected.

The earlier open rehearsal fixtures remain available for another demo: `ĐTK-K-GACH-01-261125-000001` (open Customer Return) and `ĐTNCC-K-GACH-01-261125-000001` (Supplier Return awaiting agreement).

## Data and runtime

- Atlas `wmsd_database` was connected and queried read-only for database/collection metadata (60 collections). No Atlas documents, stock, indexes or permissions were changed.
- All writes and browser rehearsal actions used local database `wmsd_trung_rehearsal_20261125` on `127.0.0.1:27020` (`whmsRehearsal`). Test suites used separate isolated local databases.
- The local backend ran with `EVIDENCE_STORAGE_PROVIDER=local`, private evidence under the ignored `.local/evidence-storage` directory, and outbound email disabled. Cloudinary remains the default provider for other environments; the live Cloudinary integration was not exercised.
- Frontend and backend rehearsal servers use `127.0.0.1:3342` and `127.0.0.1:3341`. The browser was left signed out after completing role checks.

## GitHub status

Changes are committed and pushed only to the existing `trungph` branches. Merge state and required-check results are reported in the task handoff after the existing PR checks finish.
