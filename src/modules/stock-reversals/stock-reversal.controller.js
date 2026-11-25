import { respondWithData } from '../../shared/utils/catchAsync.js';
import * as service from './stock-reversal.service.js';

export const getReversal = respondWithData(req =>
  service.getReversal(req.user, req.validated.params.id));
