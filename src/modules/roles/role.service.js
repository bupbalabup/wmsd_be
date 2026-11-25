import { Role, Permission, User } from '../../models/runtime.js';
import { ApiError, duplicateError } from '../../shared/utils/ApiError.js';
import { appendAudit } from '../../shared/utils/audit.js';
import { displayRoleName } from '../../shared/utils/roleNames.js';
import { PERMISSION_CATALOGUE } from '../../seeds/data/permissions.data.js';

// Only catalogue codes are offered or listed: a permission removed from the catalogue (e.g. sales_policy:*,
// 25/11/2026) may still exist in older databases but grants nothing (see rolePermissions).
const catalogueCodes = new Set(PERMISSION_CATALOGUE.map((permission) => permission.code));
// The catalogue's Vietnamese description is shown even when an older database stored an empty or English one
// ("UOM activate", or only the code such as opening_stock:post) — 25/11/2026.
const catalogueDescriptions = new Map(PERMISSION_CATALOGUE.map((permission) => [permission.code, permission.description]));

export const listRoles = async () => {
  const roles = await Role.find().populate('permissionIds').lean();

  // Count each account once under its single assigned role
  const userCounts = await User.aggregate([
    { $group: { _id: '$roleId', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(userCounts.map((c) => [c._id.toString(), c.count]));

  return roles.map((r) => ({
    id: r._id.toString(),
    code: r.code, name: displayRoleName(r.code, r.name), description:r.description, isActive:r.isActive, isSystemRole:r.isSystemRole,
    roleKey: r.code.toLowerCase(),
    userCount: countMap.get(r._id.toString()) || 0,
    permissions: (r.permissionIds || []).map((p) => p?.code).filter((code) => catalogueCodes.has(code)),
  }));
};

export const updateRolePermissions = async (roleCode, permissionCodes = [], actorId) => {
  const role = await Role.findOne({ code: roleCode.toUpperCase() });
  if (!role) {
    throw new ApiError(404, `Không tìm thấy vai trò ${roleCode}`);
  }

  // Ensure permissions exist in database
  const permissionDocs = await Promise.all(
    permissionCodes.map(async (code) => {
      const p = await Permission.findOne({ code, isActive: { $ne: false } });
      if (!p) {
        throw new ApiError(400, `Quyền không thuộc danh mục: ${code}`);
      }
      return p;
    })
  );

  const before = (await Permission.find({ _id: { $in: role.permissionIds } }).select('code').lean()).map((p) => p.code).sort();
  role.permissionIds = permissionDocs.map((p) => p._id);
  if (!role.name) role.name = displayRoleName(role.code, role.name);
  await role.save();
  // Access changes are audited like account lock/unlock so the Administrator screen shows who changed which rights.
  await appendAudit({ actorId, action: 'UPDATE_ROLE_PERMISSIONS', entityType: 'roles', entityId: role._id, changes: [{ field: 'permissions', before, after: [...new Set(permissionCodes)].sort() }] });

  return {
    id: role._id.toString(),
    code: role.code,
    roleKey: role.code.toLowerCase(),
    permissions: permissionCodes,
  };
};

export async function createRole(input, actorId){
 const codes=[...new Set(input.permissionCodes)];const permissions=await Permission.find({code:{$in:codes},isActive:{$ne:false}});if(permissions.length!==codes.length)throw new ApiError(400,'Chỉ chọn quyền đang hoạt động trong danh mục');
 let role;
 try{role=await Role.create({code:input.code,name:input.name,description:input.description,isSystemRole:false,permissionIds:permissions.map(p=>p._id)});}
 // The unique index on code is the guard (also against concurrent creates); answer 409 instead of leaking the raw E11000 as a 500.
 catch(error){if(error?.code===11000)throw duplicateError('Mã vai trò đã tồn tại');throw error;}
 await appendAudit({actorId,action:'CREATE_ROLE',entityType:'roles',entityId:role._id,changes:[{field:'code',before:null,after:role.code},{field:'permissions',before:null,after:[...codes].sort()}]});
 return {id:String(role._id),code:role.code,name:role.name,permissions:codes};
}
// A stored name with no Vietnamese text (empty, the code itself, "UOM activate") is replaced by the catalogue description.
const permissionName = (p) => (p.name && /[^\x00-\x7F]/.test(p.name) ? p.name : catalogueDescriptions.get(p.code) || p.name || p.code);
export async function listPermissions(){return (await Permission.find({isActive:{$ne:false}}).select('code name description').lean()).filter(p=>catalogueCodes.has(p.code)).map(p=>({id:String(p._id),code:p.code,name:permissionName(p),description:catalogueDescriptions.get(p.code)||p.description}));}

