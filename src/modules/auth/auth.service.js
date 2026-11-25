import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User, Warehouse } from "../../models/runtime.js";
import { ApiError, ERROR_CODES, validationError } from "../../shared/utils/ApiError.js";
import { rolePermissions, userRoleDto } from "../../shared/utils/userRole.js";
import { displayRoleName } from "../../shared/utils/roleNames.js";
import { generateRefreshToken } from "../../config/jwt.js";
import { escapeRegex } from "../../shared/utils/domain.js";
import { appendAudit, changedFields } from "../../shared/utils/audit.js";
import { generatePassword, sendMail, passwordMail } from "../../shared/utils/mailer.js";
import { issueEmailChange, confirmEmailChange, maskEmail } from "../../shared/utils/emailChange.js";
import { OTP_RESEND_SECONDS, OTP_TTL_MINUTES, createChallenge, fingerprint, invalidOtp, markUsed, recordIssued, resendWait, verifyChallenge } from "../../shared/utils/otpChallenge.js";

const JWT_SECRET =
  process.env.JWT_SECRET || "wmsd_default_super_secret_jwt_key_2026";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const rolePopulation = { path: "roleId", populate: { path: "permissionIds" } };

function profile(user) {
  if (!user || !user.isActive)
    throw new ApiError(401, "Người dùng không tồn tại hoặc đã bị vô hiệu hóa");
  return {
    id: user._id,
    username: user.username,
    fullName: user.fullName,
    phone: user.phone,
    warehouseIds: (user.warehouseIds || []).map(String),
    ...userRoleDto(user),
    permissions: rolePermissions(user),
  };
}

function sessionResult(user) {
  const dto = profile(user);
  const accessToken = jwt.sign(
    {
      userId: user._id,
      username: dto.username,
      fullName: dto.fullName,
      role: dto.role,
      roles: dto.roles,
      permissions: dto.permissions,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
  return { accessToken, user: dto };
}

const exactCaseInsensitive = (value) => new RegExp("^" + escapeRegex(value) + "$", "i");

async function findLoginAccount(identifier) {
  const account = await User.findOne({ username: identifier }).select("+passwordHash").populate(rolePopulation);
  if (account) return account;

  const field = identifier.includes("@") ? "email" : "username";
  const candidates = await User.find({ [field]: exactCaseInsensitive(identifier) })
    .select("+passwordHash")
    .populate(rolePopulation)
    .limit(2);
  return candidates.length === 1 ? candidates[0] : null;
}

export const loginUser = async (username, password) => {
  const user = await findLoginAccount(username.trim().toLowerCase());
  if (
    !user ||
    !user.isActive ||
    !(await bcrypt.compare(password, user.passwordHash))
  ) {
    throw new ApiError(401, "Tên đăng nhập hoặc mật khẩu không chính xác");
  }
  // Record the sign-in without touching updatedAt, so profile timestamps stay meaningful.
  const signedInAt = new Date();
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: signedInAt } }, { timestamps: false });
  await appendAudit({ actorId: user._id, action: "LOGIN", entityType: "users", entityId: user._id, details: { reason: "Đăng nhập thành công" } }).catch(() => undefined);
  return {
    ...sessionResult(user),
    refreshToken: generateRefreshToken(user._id),
  };
};

const RESET_COOLDOWN_MS = 60 * 1000;
const lastReset = new Map();

// Forgot password: set a new random password and email it. Unknown, locked or ambiguous addresses are ignored silently.
export const forgotPassword = async (rawEmail) => {
  const email = rawEmail.trim().toLowerCase();
  const matches = await User.find({ email: exactCaseInsensitive(email) }).select("+passwordHash").limit(2);
  if (matches.length !== 1 || !matches[0].isActive) return;
  // One request per minute per address keeps strangers from locking someone out by spamming the form.
  const last = lastReset.get(email) ?? 0;
  if (Date.now() - last < RESET_COOLDOWN_MS) return;
  lastReset.set(email, Date.now());
  const user = matches[0];
  const previousHash = user.passwordHash;
  const password = generatePassword();
  let passwordHash;
  let changed = false;
  try {
    passwordHash = await bcrypt.hash(password, 10);
    const result = await User.updateOne(
      { _id: user._id, email: user.email, isActive: true, passwordHash: previousHash },
      { $set: { passwordHash } },
    );
    changed = result.modifiedCount === 1;
    if (!changed) return;
    await sendMail({ to: email, ...passwordMail({ fullName: user.fullName, username: user.username, password, reason: "reset" }) });
  } catch (error) {
    lastReset.delete(email);
    // Only restore the hash written by this request. A later change must win.
    if (changed) await User.updateOne({ _id: user._id, passwordHash }, { $set: { passwordHash: previousHash } });
    throw error;
  }
  await appendAudit({ actorId: user._id, action: "RESET_PASSWORD", entityType: "users", entityId: user._id, details: { channel: "email" } }).catch(() => undefined);
};


// Session fields plus the read-only account details shown on the "Thông tin tài khoản" screen.
async function accountDetails(user) {
  const dto = profile(user);
  const role = user.roleId;
  const warehouses = dto.warehouseIds.length
    ? await Warehouse.find({ _id: { $in: dto.warehouseIds } }).select("code name isActive").lean()
    : [];
  return {
    ...dto,
    email: user.email,
    roleCode: role.code,
    roleName: displayRoleName(role.code, role.name),
    warehouses: warehouses.map((w) => ({ id: String(w._id), code: w.code, name: w.name, isActive: w.isActive !== false })),
    version: user.version ?? 1,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// Forgot password, OTP option (user decision 23/11/2026): the account's email receives a 6-digit code and the
// user chooses the new password. The random-password option (forgotPassword above) stays available.
const RESET_PURPOSE = "password-reset";

const resetOtpMail = ({ fullName, code }) => ({
  subject: "Mã xác thực đặt lại mật khẩu Tân Thương",
  text: [
    `Xin chào ${fullName},`, "",
    "Bạn vừa yêu cầu đặt lại mật khẩu cho tài khoản Tân Thương.",
    `Mã xác thực: ${code}`,
    `Mã có hiệu lực trong ${OTP_TTL_MINUTES} phút và chỉ dùng được một lần. Không chia sẻ mã này cho bất kỳ ai.`, "",
    "Nếu bạn không yêu cầu, hãy bỏ qua thư này; mật khẩu hiện tại vẫn giữ nguyên.",
  ].join("\n"),
});

const passwordResetMail = ({ fullName }) => ({
  subject: "Mật khẩu tài khoản Tân Thương đã được đặt lại",
  text: [
    `Xin chào ${fullName},`, "",
    "Mật khẩu tài khoản Tân Thương của bạn vừa được đặt lại bằng mã xác thực gửi qua email.",
    "Nếu bạn không thực hiện, hãy liên hệ quản trị viên ngay.",
  ].join("\n"),
});

// Public. Always answers with the same shape (a challenge token) so the form cannot reveal which emails exist;
// a code is emailed only when the address belongs to exactly one active account.
export const requestPasswordResetOtp = async (rawEmail) => {
  const email = rawEmail.trim().toLowerCase();
  const rateKey = `${RESET_PURPOSE}:${email}`;
  // The cooldown is keyed by the typed address, existing or not, so it reveals nothing either.
  const wait = resendWait(rateKey);
  if (wait > 0) throw new ApiError(429, `Vui lòng chờ ${wait} giây trước khi gửi lại mã`, { details: { retryAfterSeconds: wait } });
  recordIssued(rateKey);
  const matches = await User.find({ email: exactCaseInsensitive(email) }).select("+passwordHash").limit(2);
  const user = matches.length === 1 && matches[0].isActive ? matches[0] : null;
  const { code, challengeToken, expiresAt } = createChallenge(RESET_PURPOSE, {
    tgt: user ? String(user._id) : null,
    email,
    // Binds the challenge to the current password: once any reset succeeds, older challenges stop working.
    pwd: user ? fingerprint(RESET_PURPOSE, user.passwordHash) : null,
  });
  if (user) await sendMail({ to: email, ...resetOtpMail({ fullName: user.fullName, code }) });
  return { challengeToken, maskedEmail: maskEmail(email), expiresAt, resendAfterSeconds: OTP_RESEND_SECONDS };
};

export const resetPasswordWithOtp = async ({ challengeToken, otp, newPassword }) => {
  const claims = verifyChallenge(RESET_PURPOSE, challengeToken, otp);
  const stale = () => invalidOtp("Phiên xác thực không còn hiệu lực. Vui lòng gửi lại mã.");
  if (!claims.tgt) throw stale();
  const user = await User.findById(claims.tgt).select("+passwordHash");
  if (!user || !user.isActive || (user.email ?? "").toLowerCase() !== claims.email) throw stale();
  if (fingerprint(RESET_PURPOSE, user.passwordHash) !== claims.pwd) throw stale();
  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await User.findOneAndUpdate(
    { _id: user._id, isActive: true, passwordHash: user.passwordHash },
    { $set: { passwordHash } },
    { new: true },
  );
  if (!updated) throw stale();
  markUsed(claims);
  await appendAudit({ actorId: user._id, action: "RESET_PASSWORD", entityType: "users", entityId: user._id, details: { reason: "Đặt lại mật khẩu bằng mã OTP gửi qua email" } }).catch(() => undefined);
  await sendMail({ to: user.email, ...passwordResetMail({ fullName: user.fullName }) }).catch(() => undefined);
};

export const getCurrentUser = async (userId) =>
  accountDetails(await User.findById(userId).populate(rolePopulation));

const PROFILE_FIELDS = ["fullName", "phone"];
const profileConflict = () => new ApiError(409, "Thông tin tài khoản đã được cập nhật ở nơi khác. Vui lòng tải lại trang.", { code: ERROR_CODES.VERSION_CONFLICT });

// Self-service edit: only personal contact fields. Email changes go through the OTP flow; role, warehouses and status stay admin-managed.
export const updateCurrentUser = async (userId, { version, ...changes }) => {
  const before = await User.findById(userId).lean();
  if (!before || !before.isActive) throw new ApiError(401, "Người dùng không tồn tại hoặc đã bị vô hiệu hóa");
  const set = {};
  if (changes.fullName !== undefined) set.fullName = changes.fullName.trim();
  if (changes.phone !== undefined) set.phone = changes.phone.trim() || undefined;
  const diff = changedFields(before, { ...before, ...set }, PROFILE_FIELDS);
  if ((before.version ?? 1) !== version) throw profileConflict();
  if (!diff.length) return getCurrentUser(userId);
  const unset = Object.fromEntries(Object.entries(set).filter(([, v]) => v === undefined).map(([k]) => [k, 1]));
  for (const key of Object.keys(unset)) delete set[key];
  const updated = await User.findOneAndUpdate(
    // Older user records may predate the version field; treat a missing value as version 1.
    { _id: userId, isActive: true, version: version === 1 ? { $in: [1, null] } : version },
    { $set: { ...set, version: version + 1 }, ...(Object.keys(unset).length && { $unset: unset }) },
    { new: true, runValidators: true },
  );
  if (!updated) throw profileConflict();
  await appendAudit({ actorId: userId, action: "UPDATE_PROFILE", entityType: "users", entityId: userId, changes: diff, versionBefore: version, versionAfter: version + 1 }).catch(() => undefined);
  return getCurrentUser(userId);
};

// Owner-only password change (user decision 23/11/2026): the logged-in user must prove the current password.
export const changeOwnPassword = async (userId, { currentPassword, newPassword }) => {
  const user = await User.findById(userId).select("+passwordHash");
  if (!user || !user.isActive) throw new ApiError(401, "Người dùng không tồn tại hoặc đã bị vô hiệu hóa");
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw validationError("Mật khẩu hiện tại không chính xác", [{ path: "body.currentPassword", message: "Mật khẩu hiện tại không chính xác" }]);
  if (await bcrypt.compare(newPassword, user.passwordHash)) throw validationError("Mật khẩu mới phải khác mật khẩu hiện tại", [{ path: "body.newPassword", message: "Mật khẩu mới phải khác mật khẩu hiện tại" }]);
  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await User.findOneAndUpdate(
    { _id: userId, isActive: true, passwordHash: user.passwordHash },
    { $set: { passwordHash } },
    { new: true },
  );
  if (!updated) throw new ApiError(409, "Mật khẩu vừa được thay đổi ở nơi khác. Vui lòng thử lại.", { code: ERROR_CODES.OPERATION_CONFLICT });
  await appendAudit({ actorId: userId, action: "CHANGE_PASSWORD", entityType: "users", entityId: userId, details: { reason: "Chủ tài khoản tự đổi mật khẩu" } }).catch(() => undefined);
};

// Self-service email change: OTP goes to the new address; the target is always the signed-in user.
export const requestOwnEmailOtp = (userId, { newEmail }) => issueEmailChange({ actorId: userId, targetId: userId, newEmail });

export const confirmOwnEmail = async (userId, { challengeToken, otp }) => {
  await confirmEmailChange({ actorId: userId, targetId: userId, challengeToken, otp });
  return getCurrentUser(userId);
};

export const refreshToken = async (userId) =>
  sessionResult(await User.findById(userId).populate(rolePopulation));
