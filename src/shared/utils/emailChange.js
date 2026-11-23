import { User } from '../../models/runtime.js';
import { ApiError, ERROR_CODES, validationError } from './ApiError.js';
import { escapeRegex } from './domain.js';
import { appendAudit } from './audit.js';
import { sendMail } from './mailer.js';
import { OTP_RESEND_SECONDS, OTP_TTL_MINUTES, createChallenge, invalidOtp, markUsed, recordIssued, resendWait, resetOtpState, verifyChallenge } from './otpChallenge.js';

// Email change with a one-time code sent to the NEW address (user decision 23/11/2026).
// Applies to self-service and to an administrator changing another account's email.
// The challenge is bound to the actor, the target account and the email the target had when the code was issued,
// so it cannot be replayed after the change and cannot be used by anyone else.

export { OTP_TTL_MINUTES, OTP_RESEND_SECONDS };
const PURPOSE = 'email-change';
const normalize = (email) => email.trim().toLowerCase();

export function maskEmail(email) {
  const [name, domain] = email.split('@');
  const visible = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, name.length - visible.length))}@${domain}`;
}

const emailTaken = async (email, exceptId) => Boolean(await User.exists({ email: new RegExp(`^${escapeRegex(email)}$`, 'i'), _id: { $ne: exceptId } }));

const otpMail = ({ fullName, code, byAdmin }) => ({
  subject: 'Mã xác thực đổi email tài khoản Tân Thương',
  text: [
    `Xin chào ${fullName},`, '',
    byAdmin
      ? 'Quản trị viên đang cập nhật địa chỉ email này cho tài khoản Tân Thương của bạn.'
      : 'Bạn đang đổi email đăng nhập của tài khoản Tân Thương sang địa chỉ này.',
    `Mã xác thực: ${code}`,
    `Mã có hiệu lực trong ${OTP_TTL_MINUTES} phút và chỉ dùng được một lần.`, '',
    byAdmin ? 'Chỉ đọc mã này cho quản trị viên khi bạn đồng ý đổi email.' : 'Không chia sẻ mã này cho bất kỳ ai.',
    'Nếu bạn không yêu cầu đổi email, hãy bỏ qua thư này.',
  ].join('\n'),
});

const changedMail = ({ fullName, newEmail, byAdmin }) => ({
  subject: 'Email tài khoản Tân Thương đã được thay đổi',
  text: [
    `Xin chào ${fullName},`, '',
    `Email của tài khoản Tân Thương đã được đổi sang ${maskEmail(newEmail)}${byAdmin ? ' bởi quản trị viên' : ''}.`,
    'Từ nay mật khẩu mới và thông báo sẽ được gửi tới địa chỉ mới.', '',
    'Nếu bạn không thực hiện hoặc không đồng ý thay đổi này, hãy liên hệ quản trị viên ngay.',
  ].join('\n'),
});

/** Step 1: validate the new address and email it a 6-digit code. Returns the challenge for step 2. */
export async function issueEmailChange({ actorId, targetId, newEmail: rawEmail }) {
  const newEmail = normalize(rawEmail);
  const target = await User.findById(targetId).lean();
  if (!target) throw new ApiError(404, 'Không tìm thấy người dùng', { code: ERROR_CODES.NOT_FOUND });
  if (newEmail === (target.email ?? '').toLowerCase()) throw validationError('Email mới trùng với email hiện tại', [{ path: 'body.newEmail', message: 'Email mới trùng với email hiện tại' }]);
  if (await emailTaken(newEmail, target._id)) throw validationError('Email đã được sử dụng cho tài khoản khác', [{ path: 'body.newEmail', message: 'Email đã được sử dụng cho tài khoản khác' }]);

  const rateKey = `${PURPOSE}:${actorId}:${targetId}`;
  const wait = resendWait(rateKey);
  if (wait > 0) throw new ApiError(429, `Vui lòng chờ ${wait} giây trước khi gửi lại mã`, { details: { retryAfterSeconds: wait } });

  const { code, challengeToken, expiresAt } = createChallenge(PURPOSE, { act: String(actorId), tgt: String(targetId), email: newEmail, old: (target.email ?? '').toLowerCase() });
  await sendMail({ to: newEmail, ...otpMail({ fullName: target.fullName, code, byAdmin: String(actorId) !== String(targetId) }) });
  recordIssued(rateKey);
  return { challengeToken, maskedEmail: maskEmail(newEmail), expiresAt, resendAfterSeconds: OTP_RESEND_SECONDS };
}

/** Step 2: check the code and apply the change atomically. Returns the updated user id. */
export async function confirmEmailChange({ actorId, targetId, challengeToken, otp }) {
  const claims = verifyChallenge(PURPOSE, challengeToken, otp);
  if (claims.act !== String(actorId) || claims.tgt !== String(targetId)) throw invalidOtp('Phiên xác thực không hợp lệ. Vui lòng gửi lại mã.');

  const target = await User.findById(targetId).lean();
  if (!target) throw new ApiError(404, 'Không tìm thấy người dùng', { code: ERROR_CODES.NOT_FOUND });
  if ((target.email ?? '').toLowerCase() !== claims.old) throw new ApiError(409, 'Email của tài khoản vừa thay đổi. Vui lòng gửi lại mã.', { code: ERROR_CODES.OPERATION_CONFLICT });
  if (await emailTaken(claims.email, target._id)) throw validationError('Email đã được sử dụng cho tài khoản khác', [{ path: 'body.otp', message: 'Email đã được sử dụng cho tài khoản khác' }]);

  const versionBefore = target.version ?? 1;
  const updated = await User.findOneAndUpdate(
    { _id: target._id, email: target.email ?? { $in: [null, ''] } },
    { $set: { email: claims.email, version: versionBefore + 1 } },
    { new: true, runValidators: true },
  );
  if (!updated) throw new ApiError(409, 'Email của tài khoản vừa thay đổi. Vui lòng gửi lại mã.', { code: ERROR_CODES.OPERATION_CONFLICT });
  markUsed(claims);

  const byAdmin = String(actorId) !== String(targetId);
  await appendAudit({
    actorId, action: 'CHANGE_EMAIL', entityType: 'users', entityId: target._id,
    changes: [{ field: 'email', before: target.email ?? null, after: claims.email }],
    details: { reason: byAdmin ? 'Quản trị viên đổi email, đã xác thực OTP gửi tới email mới' : 'Chủ tài khoản đổi email, đã xác thực OTP gửi tới email mới' },
    versionBefore, versionAfter: versionBefore + 1,
  }).catch(() => undefined);
  // Tell the previous address; failure must not undo a verified change.
  if (target.email) await sendMail({ to: target.email, ...changedMail({ fullName: target.fullName, newEmail: claims.email, byAdmin }) }).catch(() => undefined);
  return target._id;
}

/** Test helper kept for existing tests. */
export const resetEmailChangeState = resetOtpState;
