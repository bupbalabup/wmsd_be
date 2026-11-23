import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app.js';
import { connectDatabase } from './config/database.js';
import { startNotificationWorker } from './modules/notifications/worker.js';

async function startServer() {
  await connectDatabase();

  const port = Number(process.env.PORT) || 3000;
  if (process.env.NOTIFICATIONS_START_AT) {
    const cutoff = new Date(process.env.NOTIFICATIONS_START_AT);
    if (!Number.isFinite(+cutoff)) throw new Error('NOTIFICATIONS_START_AT must be an ISO date');
    if (mongoose.connection.readyState === 1) startNotificationWorker(cutoff);
  }
  app.listen(port, () => {
    console.info(`API server listening on port ${port}.`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start API server.', error);
  process.exitCode = 1;
});
