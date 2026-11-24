# WHMS Goods Issue and Returns verification

Updated 25 November 2026. Verification is on the existing `trungph` frontend and backend branches after syncing `main`.

## Backend

| Check | Result |
|---|---|
| `npm test` | 301 passed, 139 skipped, 0 failed (440 total). |
| `RUN_HIEUDT_TESTS=1 npm run test:returns` | 26 passed, 0 failed. Uses random `returns_test_<ObjectId>` database on the isolated `hieudt-test` replica set. |
| `RUN_GOODS_ISSUE_TESTS=1 RUN_HIEUDT_TESTS=1 node --test test/direct-sales.integration.test.js` | 1 passed, 0 failed. Includes issue receipt, return-source eligibility, stock and notification checks. |
| `npm run docs:check` | Passed: 3 instruction files identical, 62 collections, 1094 local links, change-log signals. |

`npm run test:returns` defaults to `127.0.0.1:27017` (`rs0`), which was not listening in this environment; the same suite passed with `RUN_HIEUDT_TESTS=1` on `127.0.0.1:27018` (`hieudt-test`). Both use unique isolated test databases and never read `MONGODB_URI`.

## Frontend

| Check | Result |
|---|---|
| `pnpm exec vitest run src/features/goods-issues src/features/return-workflows` | 59 passed across 8 files. |
| Focused ESLint for Goods Issue and return workflows | Passed. |
| `pnpm typecheck` | Passed. |
| `pnpm build` | Passed. |
| `pnpm test` | 759 passed, 9 failed across 5 files (768 total). |

The full-suite failures are four Create Account tests, one profile email OTP timeout, one replenishment table test, one receipt-create test, and two transfer-flow tests. None is in the Customer Return, Supplier Return, or notification path.

## Browser smoke and local fixture

Sales signed in, selected a Warehouse-created standalone SALE Goods Issue, and created a one-piece Customer Return. Warehouse opened it and saw the inspection action and a deduplicated `CREATE_CR` notice in the notification bell. The request is `ĐTK-K-GACH-01-261125-000001` and remains `OPEN` in the isolated `wmsd_trung_rehearsal_20261125` database. Accountant opened `ĐTNCC-K-GACH-01-261125-000001` at `AGREEMENT_PENDING`; the agreement action was visible and the close action stayed hidden. Browser checks reported no page errors.

The browser smoke did not submit inspection evidence. The end-to-end backend tests cover inspection, Sales decision, receipt, lot/stock effects, duplicate prevention and supplier-return notifications using isolated synthetic attachments; no real Cloudinary upload was run.

## Atlas and scope limits

Atlas `wmsd_database` was queried read-only for relevant collection counts and embedded customer receipt confirmations. No Atlas documents, indexes, permissions, or stock were written. Demo fixture creation and workflow tests used isolated local databases only.
