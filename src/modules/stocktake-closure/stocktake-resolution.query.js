import mongoose from 'mongoose';
import { z } from 'zod';
import { escapeRegex } from '../../shared/utils/movement-list.js';
import { databaseId } from '../../models/document-identity.js';
import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { isOwner, requireWarehouseAccess } from '../../shared/utils/access.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i).transform(value => value.toLowerCase());

export const RESOLUTION_PLAN_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTED', 'CLOSED', 'CANCELLED'];

// Strict on purpose: unknown keys are rejected instead of silently ignored.
export const resolutionListQuery = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  warehouseId: objectId.optional(),
  stocktakeId: documentIdentifier.optional(),
  lotId: objectId.optional(),
  locationId: objectId.optional(),
  status: z.enum(RESOLUTION_PLAN_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

// Aggregation pipelines do not cast values, so identifiers are cast here.
const castId = value => (value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value)));

/**
 * Stocktake-level match for the resolution-plan list: the actor's warehouse scope plus
 * the filters that can be answered from the stocktake document itself.
 * A foreign `warehouseId` is refused (403) instead of returning an empty list.
 */
export function buildResolutionScope(user, query) {
  const scope = { 'resolutionPlans.0': { $exists: true } };
  if (!isOwner(user)) scope['header.warehouseId'] = { $in: (user.warehouseIds || []).map(castId) };
  if (query.warehouseId) {
    requireWarehouseAccess(user, query.warehouseId);
    scope['header.warehouseId'] = castId(query.warehouseId);
  }
  if (query.stocktakeId) scope._id = databaseId(query.stocktakeId);
  if (query.locationId) scope['header.scopeLocationIds'] = castId(query.locationId);
  if (query.status) scope['resolutionPlans.workflowStatus'] = query.status;
  return scope;
}

/**
 * Plan-level match applied after the plans are unwound. Lot and location must hold on one
 * plan line: the lot is the line's own `lotId`; the location resolves through the snapshots
 * the line refers to (`details.countId` or either balance endpoint), supplied as `locationRefs`.
 */
export function buildResolutionPlanFilter(query, locationRefs) {
  const filter = {};
  if (query.status) filter['resolutionPlans.workflowStatus'] = query.status;
  if (query.q) {
    const text = { $regex: escapeRegex(query.q), $options: 'i' };
    filter.$or = [{ 'resolutionPlans.documentNo': text }, { documentNo: text }];
  }
  const line = {};
  if (query.lotId) line.lotId = castId(query.lotId);
  if (locationRefs) {
    line.$or = [
      { 'details.countId': { $in: locationRefs.countIds.map(castId) } },
      { 'details.fromBalanceId': { $in: locationRefs.balanceIds.map(castId) } },
      { 'details.toBalanceId': { $in: locationRefs.balanceIds.map(castId) } },
    ];
  }
  if (Object.keys(line).length) filter['resolutionPlans.items'] = { $elemMatch: line };
  return filter;
}
