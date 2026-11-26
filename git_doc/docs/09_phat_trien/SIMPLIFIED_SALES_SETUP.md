# Sales and returns — local setup and verification

Updated 26 November 2026. Current contracts: [Goods Issue](../08_api/GOODS_ISSUES.md), [scheduled Sales Order delivery](../08_api/SALES_DELIVERY_SCHEDULE.md), and [native return workflows](../08_api/RETURN_WORKFLOWS_NATIVE.md). Use the [25 November demo guide](TRUNG_DEMO_LOCAL.md#nghiệm-thu-kế-hoạch-xuất-bán-và-trả-hàng--25112026) for fixture inputs and the 8 → 4 → 4 acceptance scenario.

## Current workflow

- **Scheduled Sales Order:** create the order, allocate its delivery through the schedule, and let the scheduled flow manage FIFO reservations and Goods Issue posting.
- **Standalone SALE:** Sales selects **Xuất bán**, enters the external order reference and product quantities, then submits. A different Store Owner approves the same issue. Warehouse picks the actual source lot and posts; approval does not move stock.
- **Customer Return:** start from the posted Goods Issue and select the actual source lot with remaining return allowance. Sales requests the return; Warehouse records actual quantity, condition and evidence without changing stock; Sales accepts or rejects; Warehouse posts only the accepted quantity.
- **Supplier Return:** create the agreement from its purchase source, then Warehouse dispatches the agreed quantity. Dispatch reduces stock once. Accountant records the supplier's `ACK_SR` response and reconciles/closes; acknowledgement and closure do not post stock again. Use the separate source lot shown in the demo guide.

## Local setup

1. Review the current contracts linked above and use an isolated local database configured through the existing environment setup.
2. If the local role records lack the current receipt permission, run `npm run seed:sync-permissions` against that local database to grant `delivery_confirmation:confirm` to SALES. Do not point setup or tests at shared data.
3. Start the API and frontend with the repository's existing development commands. Sales starts at `/orders` for scheduled orders. For a standalone external-reference sale, open `/goods-issues/create`, submit the SALE, sign in as a different Owner to approve, then sign in as Warehouse to pick and post.
4. For the return walkthrough, find the posted issue by its external reference, choose its actual lot, and check the remaining allowance. Complete inspection, Sales decision and Warehouse receipt in that order; inspection alone must not change stock.
5. For the supplier walkthrough, use the agreement and separate lot in the demo guide. Record the dispatch, supplier ACK and closure as separate milestones, and compare the stock ledger before and after each action.

## Current verification — 25 November 2026

The backend direct-sales HTTP test passed 1/1 and native return-workflow integration passed 22/22 on the isolated `27018/hieudt-test` replica set. Focused frontend tests passed 27/32; five failures were jsdom/Ant Design event handling in warehouse-change and staged-return interactions. No browser visual run or remote rollout was completed. The complete acceptance cases and limitations are recorded in [TRUNG_DEMO_LOCAL](TRUNG_DEMO_LOCAL.md#nghiệm-thu-kế-hoạch-xuất-bán-và-trả-hàng--25112026).

## Historical verification — 17 November 2026

This earlier verification covered the then-current SO-linked direct issue flow and remains for history; it does not describe the 25 November standalone SALE workflow. It used isolated throwaway databases named `direct_sales_test_<random>` on `mongodb://127.0.0.1:27018/?replicaSet=hieudt-test`. The direct and legacy Goods Issue integration tests covered direct issue/post without WIR/OD/picking, exact stock, replay, role checks, source lookup/evidence access, customer receipt versus undelivered race, source caps, CR inspection without custody, acceptance/receipt, SO detail links and legacy issue regressions.

At that run, standard backend tests were 153 passed / 109 opt-in skipped; direct plus legacy Goods Issue integration was 5 passed; focused frontend workspace/auth/navigation/return tests were 60 passed; the Excel/opening and Goods Issue/return subset was 27 passed; TypeScript and production build passed. Browser checks used synthetic intercepted API data and exercised the then-current issue/return screens. They do not replace transaction tests or live evidence-storage verification.

The whole frontend suite at that run failed in inventory/lots/replenishments/old issue-request screens after relevant source/permission expectations and missing Excel mocks were fixed. Whole-repository lint reported 46 errors and 13 warnings in other files. Broad return-workflow integration setup was blocked by duplicate POSTED opening-stock rows in the legacy demo fixture. These are dated results, not claims about the current 25 November build.
