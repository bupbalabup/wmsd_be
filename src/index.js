import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app.js';
import { connectDatabase } from './config/database.js';
import { startNotificationWorker } from './modules/notifications/worker.js';
import { startBackgroundJobs } from './modules/notifications/background.js';
import { recordError } from './shared/utils/errorLog.js';

// Unexpected process-level failures are logged for the administrator's monitoring screen.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection', reason);
  void recordError({ source: 'PROCESS', error: reason instanceof Error ? reason : new Error(String(reason)) });
});

async function startServer() {
  await connectDatabase();

  const port = Number(process.env.PORT) || 3000;
  if (process.env.NOTIFICATIONS_START_AT) {
    const cutoff = new Date(process.env.NOTIFICATIONS_START_AT);
    if (!Number.isFinite(+cutoff)) throw new Error('NOTIFICATIONS_START_AT must be an ISO date');
    if (mongoose.connection.readyState === 1) startNotificationWorker(cutoff);
  }
  // Low-stock alerts and notification emails (23/11/2026).
  if (mongoose.connection.readyState === 1) startBackgroundJobs();
  app.listen(port, () => {
    console.info(`API server listening on port ${port}.`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start API server.', error);
  process.exitCode = 1;
});
