import { exact } from '../../models/model-utils.js';
import { validationError } from '../../shared/utils/ApiError.js';

/**
 * Plans a storekeeper's bin (ô) re-allocation when confirming a PICK task.
 *
 * `groups` maps a request line id to `{ planned, rows: [{ balanceId, qty }] }` (what the task currently holds per bin).
 * `allocations` is the full replacement for every group it mentions: `{ requestLineId, sourceBalanceId, qtyBase }`.
 * A bin that is not listed for a mentioned group drops to 0. Groups that are not mentioned stay untouched.
 * The picked total of a group may not exceed what the order planned; a lower total is a short pick.
 * Returns `{ changes, short }` where changes lists `{ requestLineId, balanceId, current, next }` for every bin whose quantity differs.
 */
export function planPickAllocations(groups, allocations) {
  const wanted = new Map();
  for (const row of allocations) {
    if (!groups.has(row.requestLineId)) throw validationError('Dòng lấy hàng không thuộc TO');
    const bins = wanted.get(row.requestLineId) ?? new Map();
    if (bins.has(row.sourceBalanceId)) throw validationError('Một ô chỉ được phân bổ một lần cho mỗi dòng hàng');
    bins.set(row.sourceBalanceId, exact(row.qtyBase));
    wanted.set(row.requestLineId, bins);
  }
  const changes = [];
  let short = false;
  for (const [requestLineId, bins] of wanted) {
    const group = groups.get(requestLineId);
    const total = [...bins.values()].reduce((sum, qty) => sum.plus(qty), exact('0'));
    if (total.gt(group.planned)) throw validationError('Tổng lượng lấy theo ô vượt lượng trong lệnh');
    if (total.lt(group.planned)) short = true;
    const current = new Map(group.rows.map((row) => [row.balanceId, exact(row.qty)]));
    for (const balanceId of new Set([...current.keys(), ...bins.keys()])) {
      const before = current.get(balanceId) ?? exact('0'), next = bins.get(balanceId) ?? exact('0');
      if (!before.eq(next)) changes.push({ requestLineId, balanceId, current: before, next });
    }
  }
  return { changes, short };
}
