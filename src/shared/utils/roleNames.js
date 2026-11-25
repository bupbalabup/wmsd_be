// Vietnamese display names for the built-in roles (25/11/2026). Older databases store English seed names
// ("Store Owner", "Accountant"...) or earlier Vietnamese titles; those are replaced only when shown, the stored
// role and its code are unchanged. A name an administrator typed for a custom role is returned as stored.
export const SYSTEM_ROLE_NAMES = Object.freeze({
  ADMIN: 'Quản trị viên',
  OWNER: 'Chủ cửa hàng',
  SALES: 'Nhân viên bán hàng',
  WAREHOUSE: 'Nhân viên kho',
  ACCOUNTANT: 'Kế toán',
});

const LEGACY_NAMES = new Set([
  'administrator', 'admin', 'store owner', 'owner', 'sales staff', 'sales', 'warehouse staff', 'warehouse',
  'accountant', 'nhân viên bán hàng', 'thủ kho & điều phối', 'kế toán công nợ',
]);

export function displayRoleName(code, name) {
  const fallback = SYSTEM_ROLE_NAMES[code];
  if (!fallback) return name || code;
  const stored = String(name ?? '').trim();
  return !stored || LEGACY_NAMES.has(stored.toLowerCase()) ? fallback : stored;
}
