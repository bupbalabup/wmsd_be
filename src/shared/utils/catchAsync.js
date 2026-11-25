import { formatApiResponse } from "./ApiResponse.js";

export const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export const respondWithData = (getData) =>
  catchAsync(async (req, res) => {
    const data = await getData(req);
    formatApiResponse(res, { data });
  });
