import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../../models/runtime.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { rolePermissions, userRoleDto } from "../../shared/utils/userRole.js";
import { generateRefreshToken } from "../../config/jwt.js";
import { escapeRegex } from "../../shared/utils/domain.js";
import { appendAudit } from "../../shared/utils/audit.js";
import { generatePassword, sendMail, passwordMail } from "../../shared/utils/mailer.js";

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

export const loginUser = async (username, password) => {
  const user = await User.findOne({ username: username.trim().toLowerCase() })
    .select("+passwordHash")
    .populate(rolePopulation);
  if (
    !user ||
    !user.isActive ||
    !(await bcrypt.compare(password, user.passwordHash))
  ) {
    throw new ApiError(401, "Tên đăng nhập hoặc mật khẩu không chính xác");
  }
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
  const matches = await User.find({ email: new RegExp(`^${escapeRegex(email)}$`, "i") }).select("+passwordHash").limit(2);
  if (matches.length !== 1 || !matches[0].isActive) return;
  // One request per minute per address keeps strangers from locking someone out by spamming the form.
  const last = lastReset.get(email) ?? 0;
  if (Date.now() - last < RESET_COOLDOWN_MS) return;
  lastReset.set(email, Date.now());
  const user = matches[0];
  const previousHash = user.passwordHash;
  const password = generatePassword();
  user.passwordHash = await bcrypt.hash(password, 10);
  await user.save();
  try {
    await sendMail({ to: email, ...passwordMail({ fullName: user.fullName, username: user.username, password, reason: "reset" }) });
  } catch (error) {
    // The mail never left: put the old password back so the account is not locked out.
    user.passwordHash = previousHash;
    await user.save();
    lastReset.delete(email);
    throw error;
  }
  await appendAudit({ actorId: user._id, action: "RESET_PASSWORD", entityType: "users", entityId: user._id, details: { channel: "email" } }).catch(() => undefined);
};

export const getCurrentUser = async (userId) =>
  profile(await User.findById(userId).populate(rolePopulation));

export const refreshToken = async (userId) =>
  sessionResult(await User.findById(userId).populate(rolePopulation));
