import { AppSetting } from "../../models/runtime.js";
import { recordError } from "../../shared/utils/errorLog.js";
import { processNotificationEvent } from "./worker.js";
import { processNotificationEmails } from "./email.js";
import { scanLowStock } from "../stock-alerts/stock-alert.service.js";

// Background jobs shared by the Node server loop and the Cloudflare cron (user decision 23/11/2026):
// business notifications (only when NOTIFICATIONS_START_AT is set), notification emails and the low-stock scan.

export const LOW_STOCK_INTERVAL_MS = Number(process.env.LOW_STOCK_SCAN_MINUTES || 15) * 60 * 1000;
const LAST_SCAN_KEY = "LOW_STOCK_LAST_SCAN";

/** Runs the low-stock scan when the interval has passed; the claim is atomic so parallel runners scan once. */
export async function maybeScanLowStock(now = new Date()) {
  const due = new Date(now.getTime() - LOW_STOCK_INTERVAL_MS);
  const claimed = await AppSetting.findOneAndUpdate(
    { key: LAST_SCAN_KEY, $or: [{ "value.at": { $lte: due } }, { "value.at": { $exists: false } }] },
    { $set: { value: { at: now } }, $inc: { version: 1 } },
    { returnDocument: "after" },
  ).lean().catch(() => null);
  if (!claimed) {
    if (await AppSetting.exists({ key: LAST_SCAN_KEY })) return null;
    // First run ever: create the marker (a duplicate-key race just means another runner got it).
    const created = await AppSetting.create({ key: LAST_SCAN_KEY, value: { at: now } }).then(() => true, () => false);
    if (!created) return null;
  }
  return scanLowStock(now);
}

async function step(name, job) {
  try {
    return await job();
  } catch (error) {
    console.error(`[background] ${name} failed`, error);
    await recordError({ source: "WORKER", error, path: `job:${name}` });
    return null;
  }
}

export async function runBackgroundJobs({ cutoff = null, now = new Date() } = {}) {
  if (cutoff) {
    await step("notifications", async () => {
      for (let i = 0; i < 25; i += 1) if (!(await processNotificationEvent(cutoff))) break;
    });
  }
  await step("low-stock", () => maybeScanLowStock(now));
  await step("notification-email", () => processNotificationEmails());
}

/** Node server: low-stock scan and emails every 30 seconds (business events keep their own 2-second loop). */
export function startBackgroundJobs() {
  async function run() {
    await runBackgroundJobs({ cutoff: null });
    setTimeout(run, 30_000).unref();
  }
  void run();
}
