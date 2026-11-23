import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import apiRoutes from "./routes.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { ApiError } from "./shared/utils/ApiError.js";
import morgan from "morgan";

export function createApp({ logRequests = true, secureCookies = false } = {}) {
  const app = express();
  app.locals.secureCookies = secureCookies;

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  if (logRequests) app.use(morgan("dev"));

  app.use("/api", apiRoutes);

  app.use((_req, _res, next) => {
    next(new ApiError(404, "Route not found"));
  });

  app.use(errorHandler);

  return app;
}

export default createApp();
