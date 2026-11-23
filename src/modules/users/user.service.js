import bcrypt from 'bcryptjs';
import { User, Role, Warehouse } from '../../models/runtime.js';
import { ApiError } from '../../shared/utils/ApiError.js';
import { escapeRegex } from '../../shared/utils/domain.js';
import { userRoleDto, rolePermissions } from '../../shared/utils/userRole.js';
import { appendAudit } from '../../shared/utils/audit.js';
import { generatePassword, sendMail, passwordMail } from '../../shared/utils/mailer.js';
import { issueEmailChange, confirmEmailChange } from '../../shared/utils/emailChange.js';

const normalizeEmail = (value) => value.trim().toLowerCase();
const emailTaken = async (email, exceptId) => Boolean(await User.exists({ email: new RegExp(`^${escapeRegex(email)}$`, 'i'), ...(exceptId && { _id: { $ne: exceptId } }) }));

export const listUsers = async ({ page = 1, limit = 10, search = '', role = '', status = 'all' }) => {
  const query = {};

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search.trim()), 'i');
    query.$or = [{ username: searchRegex }, { fullName: searchRegex }, { phone: searchRegex }];
  }

  if (status === 'active') {
    query.isActive = true;
  } else if (status === 'inactive') {
    query.isActive = false;
  }

  let roleFilterId = null;
  if (role) {
    const roleDoc = await Role.findOne({ code: role.toUpperCase() });
    if (roleDoc) {
      roleFilterId = roleDoc._id;
      query.roleId = roleFilterId;
    } else {
      return { items: [], total: 0, page: Number(page), limit: Number(limit) };
    }
  }

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.max(1, Number(limit));
  const skip = (pageNum - 1) * limitNum;

  const [items, total] = await Promise.all([
    User.find(query)
      .populate('roleId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    User.countDocuments(query),
  ]);

  const mapped = items.map((u) => {
    return {
      id: u._id.toString(),
      username: u.username,
      fullName: u.fullName,
      phone: u.phone, email:u.email, warehouseIds:(u.warehouseIds||[]).map(String),
      ...userRoleDto(u),
      status: u.isActive ? 'active' : 'inactive', lockReason: u.lockReason,
      createdAt: u.createdAt,
      lastLogin: u.updatedAt,
    };
  });

  return { items: mapped, total, page: pageNum, limit: limitNum };
};

export const getUserById = async (id) => {
  const user = await User.findById(id).populate({ path: 'roleId', populate: { path: 'permissionIds' } }).lean();
  if (!user) {
    throw new ApiError(404, 'Không tìm thấy người dùng');
  }

  return {
    id: user._id.toString(),
    username: user.username,
    fullName: user.fullName,
    phone: user.phone, email:user.email, warehouseIds:(user.warehouseIds||[]).map(String),
    ...userRoleDto(user),
    permissions: rolePermissions(user),
    status: user.isActive ? 'active' : 'inactive', lockReason: user.lockReason,
    createdAt: user.createdAt,
    lastLogin: user.updatedAt,
  };
};

export const createUser = async ({ username, fullName, roleCode, phone, email: rawEmail, warehouseIds = [], isActive = true }) => {
  const email = normalizeEmail(rawEmail);
  const normalizedUsername = username.trim().toLowerCase();
  const existing = await User.findOne({ username: normalizedUsername });
  if (existing) {
    throw new ApiError(400, 'Tên đăng nhập đã được sử dụng');
  }

  const roleDoc = await Role.findOne({ code: roleCode.toUpperCase(), isActive:true });
  if (!roleDoc) {
    throw new ApiError(400, 'Vai trò không hợp lệ');
  }

  if(await Warehouse.countDocuments({_id:{$in:warehouseIds},isActive:true})!==warehouseIds.length)throw new ApiError(400,'Kho phân công không hợp lệ');
  if (await emailTaken(email)) throw new ApiError(400, 'Email đã được sử dụng cho tài khoản khác');
  // Nobody (not even an admin) chooses the password: a random one is generated and emailed to the account.
  const password = generatePassword();
  const passwordHash = await bcrypt.hash(password, 10);
  const created = await User.create({
    username: normalizedUsername,
    fullName: fullName.trim(),
    passwordHash,
    roleId: roleDoc._id,
    phone, email, warehouseIds,
    isActive,
  });

  try {
    await sendMail({ to: email, ...passwordMail({ fullName: created.fullName, username: created.username, password, reason: 'created' }) });
  } catch (error) {
    // Without the email nobody could ever log in, so do not leave a half-created account behind.
    await User.deleteOne({ _id: created._id });
    throw error;
  }
  return getUserById(created._id);
};

export const updateUser = async (id, updates) => {
  const user = await User.findById(id);
  if (!user) {
    throw new ApiError(404, 'Không tìm thấy người dùng');
  }

  if(updates.warehouseIds){if(await Warehouse.countDocuments({_id:{$in:updates.warehouseIds},isActive:true})!==updates.warehouseIds.length)throw new ApiError(400,'Kho phân công không hợp lệ');user.warehouseIds=updates.warehouseIds;}
  if (updates.fullName) user.fullName = updates.fullName.trim();
  if (updates.phone !== undefined) user.phone = updates.phone;

  if (updates.roleCode) {
    const roleDoc = await Role.findOne({ code: updates.roleCode.toUpperCase(), isActive:true });
    if (!roleDoc) {
      throw new ApiError(400, 'Vai trò không hợp lệ');
    }
    user.roleId = roleDoc._id;
  }

  // Admin edits bump the version so a concurrent self-service profile edit (PATCH /auth/me) gets 409 instead of overwriting.
  user.version = (user.version ?? 1) + 1;
  await user.save();
  return getUserById(user._id);
};

// Admin email change: the OTP goes to the new address, so the account holder must read it out to the admin.
export const requestUserEmailOtp = (actorId, id, { newEmail }) => issueEmailChange({ actorId, targetId: id, newEmail });

export const confirmUserEmail = async (actorId, id, { challengeToken, otp }) => {
  await confirmEmailChange({ actorId, targetId: id, challengeToken, otp });
  return getUserById(id);
};

export const toggleUserStatus = async (id, isActive, currentUserId, reason) => {
  if (String(id) === String(currentUserId) && !isActive) {
    throw new ApiError(400, 'Không thể tự vô hiệu hóa tài khoản của chính mình');
  }

  const user = await User.findById(id);
  if (!user) {
    throw new ApiError(404, 'Không tìm thấy người dùng');
  }

  const trimmedReason = reason?.trim();
  if (!isActive && !trimmedReason) throw new ApiError(400, 'Cần nhập lý do khóa tài khoản');
  const needsAudit = user.isActive !== isActive || (!isActive && user.lockReason !== trimmedReason);
  user.isActive = isActive;
  user.lockReason = isActive ? undefined : trimmedReason;
  await user.save();
  if (needsAudit) await appendAudit({ actorId: currentUserId, action: isActive ? 'UNLOCK_USER' : 'LOCK_USER', entityType: 'users', entityId: user._id, details: { reason: trimmedReason || 'Kích hoạt tài khoản' } });
  return getUserById(user._id);
};

