import { respondWithData } from '../../shared/utils/catchAsync.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { databaseId } from '../../models/document-identity.js';
import { previewBody, createBody, actionBody } from './validation.js';
import * as service from './service.js';

const parseBody = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error.issues[0].message);
  return result.data;
};

export const options = respondWithData(req => service.options(req.user));
export const list = respondWithData(req => service.list(req.user));
export const get = respondWithData(req => service.get(req.user, databaseId(req.validated.params.id)));

export const preview = respondWithData(req => {
  const parsed = previewBody.safeParse(req.body);
  if (!parsed.success) {
    if (parsed.error.issues.every(issue => issue.path[0] === 'rows' && typeof issue.path[1] === 'number')) {
      return service.previewRowErrors(req.user, parsed.error.issues);
    }
    throw validationError(parsed.error.issues[0].message);
  }
  return service.preview(req.user, parsed.data);
});

export const create = respondWithData(req => service.create(req.user, parseBody(createBody, req.body)));
export const post = respondWithData(req =>
  service.act(req.user, databaseId(req.validated.params.id), 'post', parseBody(actionBody, req.body)));
export const cancel = respondWithData(req =>
  service.act(req.user, databaseId(req.validated.params.id), 'cancel', parseBody(actionBody, req.body)));
