import { Permission, Role } from '../models/runtime.js';
import { transaction } from '../shared/utils/persistence.js';

// Add only the new grant; preserve every existing system and custom permission.
export function grantGoodsIssueUpdatePermission() {
  return transaction(async session => {
    const grants = [
      ['goods_issue:update', 'Cập nhật phiếu xuất', ['SALES', 'WAREHOUSE']],
      ['goods_issue:approve', 'Duyệt phiếu xuất Sales gửi', ['OWNER']],
    ];
    let modifiedRoles = 0;
    for (const [code, name, roles] of grants) {
      const permission = await Permission.findOneAndUpdate({ code }, { $setOnInsert: { code, name, description: name, isActive: true } }, { upsert: true, returnDocument: 'after', session });
      const result = await Role.updateMany({ code: { $in: roles }, permissionIds: { $ne: permission._id } }, { $addToSet: { permissionIds: permission._id } }, { session });
      modifiedRoles += result.modifiedCount;
    }
    return { permission: 'goods_issue:update', modifiedRoles };
  });
}
