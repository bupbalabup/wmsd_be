import * as m from '../../models/runtime.js';
import { isOwner } from './access.js';

const none = () => ({ locations: new Set(), balances: new Set(), has: () => false });

export async function blindLockedLocationIds(user, locks, session) {
    const stocktakeIds = [...new Set(locks.map(row => row.stocktakeId).filter(Boolean).map(String))];
    if (isOwner(user) || !stocktakeIds.length) return new Set();
    const counting = await m.Stocktake.find({ _id: { $in: stocktakeIds }, workflowStatus: 'COUNTING' }).select('_id').session(session).lean();
    const countingIds = new Set(counting.map(row => String(row._id)));
    return new Set(locks.filter(row => countingIds.has(String(row.stocktakeId))).map(row => String(row.locationId)));
}

/**
 * Blind count outside the stocktake screen (decision 18 Nov 2026): while a stocktake is COUNTING,
 * current balances of its locked locations equal the frozen book quantity, so every non-Owner reader
 * gets those quantities as null. `has(locationId | balanceId)` answers for either identifier.
 */
export async function blindCountScope(user, session) {
    if (isOwner(user)) return none();
    const counting = (await m.Stocktake.find({ workflowStatus: 'COUNTING' }).select('_id').session(session).lean()).map(row => row._id);
    if (!counting.length) return none();
    const locationIds = (await m.StocktakeLocationLock.find({ status: 'LOCKED', stocktakeId: { $in: counting } }).select('locationId').session(session).lean()).map(row => row.locationId);
    if (!locationIds.length) return none();
    const pointIds = (await m.StockHoldingPoint.find({ locationId: { $in: locationIds } }).select('_id').session(session).lean()).map(row => row._id);
    const balanceIds = (await m.InventoryBalance.find({ holdingPointId: { $in: pointIds } }).select('_id').session(session).lean()).map(row => row._id);
    const locations = new Set(locationIds.map(String)), balances = new Set(balanceIds.map(String));
    return { locations, balances, has: id => id != null && (locations.has(String(id)) || balances.has(String(id))) };
}

/**
 * Withholds a stock movement's quantities when either endpoint is a blind-counted balance: the moved
 * quantity (summing history rebuilds the book) and the before/after of both endpoints.
 */
export function redactMovement(blind, row) {
    const hideFrom = blind.has(row.fromBalanceId), hideTo = blind.has(row.toBalanceId);
    if (!hideFrom && !hideTo) return row;
    // Both endpoints lose before/after: on a visible endpoint their difference is the moved quantity.
    return { ...row, quantityBase: null, blindCount: true, fromBefore: null, fromAfter: null, toBefore: null, toAfter: null };
}
