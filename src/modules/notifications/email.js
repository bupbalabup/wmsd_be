import { Notification, User } from "../../models/runtime.js";
import { sendMail } from "../../shared/utils/mailer.js";
import { sources } from "./sources.js";

// Email copies of in-app notifications (user decision 23/11/2026).
// Enabled when mail is configured (SMTP_HOST or MAIL_TRANSPORT=console) unless NOTIFICATION_EMAIL=off.
// Each notification is emailed at most once to its recipient's account email; up to 5 attempts, then FAILED.

export const MAX_EMAIL_ATTEMPTS = 5;

export function notificationEmailEnabled(env = process.env) {
  if (String(env.NOTIFICATION_EMAIL ?? "").toLowerCase() === "off") return false;
  return env.MAIL_TRANSPORT === "console" || Boolean(env.SMTP_HOST);
}

/** emailDelivery for a new notification: PENDING only when email is enabled and the user has an address. */
export const initialEmailDelivery = (user) => ({
  status: notificationEmailEnabled() && user?.email ? "PENDING" : "SKIPPED",
  attempts: 0,
});

const linkFor = (notification) => {
  const base = process.env.APP_URL?.replace(/\/$/, "");
  const path = sources[notification.sourceType]?.[0];
  return base && path ? `${base}${path}/${encodeURIComponent(String(notification.sourceId))}` : null;
};

export const notificationMail = (notification, user) => ({
  subject: `[Tân Thương] ${notification.title}`,
  text: [
    `Xin chào ${user.fullName},`, "",
    notification.title,
    notification.message !== notification.title ? notification.message : "",
    linkFor(notification) ? `Xem chi tiết: ${linkFor(notification)}` : "Đăng nhập hệ thống Tân Thương để xem chi tiết.", "",
    "Thư này được gửi tự động từ thông báo trong hệ thống; vui lòng không trả lời.",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n"),
});

/** Sends up to `limit` pending notification emails. Returns how many were attempted. */
export async function processNotificationEmails(limit = 20) {
  if (!notificationEmailEnabled()) return 0;
  let attempted = 0;
  for (; attempted < limit; attempted += 1) {
    // Claim one row by bumping its attempt counter; a concurrent worker cannot claim the same attempt.
    const notification = await Notification.findOneAndUpdate(
      { "emailDelivery.status": "PENDING", "emailDelivery.attempts": { $lt: MAX_EMAIL_ATTEMPTS }, archivedAt: null },
      { $inc: { "emailDelivery.attempts": 1 } },
      { sort: { occurredAt: 1 }, returnDocument: "after", timestamps: false },
    ).lean();
    if (!notification) break;
    const user = await User.findById(notification.recipientId).select("fullName email isActive").lean();
    if (!user?.isActive || !user.email) {
      await Notification.updateOne({ _id: notification._id }, { $set: { "emailDelivery.status": "SKIPPED" } }, { timestamps: false });
      continue;
    }
    try {
      await sendMail({ to: user.email, ...notificationMail(notification, user) });
      await Notification.updateOne({ _id: notification._id }, { $set: { "emailDelivery.status": "SENT", "emailDelivery.sentAt": new Date() }, $unset: { "emailDelivery.lastError": 1 } }, { timestamps: false });
    } catch (error) {
      const failed = notification.emailDelivery.attempts >= MAX_EMAIL_ATTEMPTS;
      await Notification.updateOne(
        { _id: notification._id },
        { $set: { "emailDelivery.lastError": String(error?.message ?? error).slice(0, 500), ...(failed && { "emailDelivery.status": "FAILED" }) } },
        { timestamps: false },
      );
      // Mail server trouble affects every message; stop this round and retry on the next run.
      break;
    }
  }
  return attempted;
}
