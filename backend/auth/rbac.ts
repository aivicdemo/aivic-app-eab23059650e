export type Role = 'admin' | 'operator' | 'viewer';

export interface Permission {
  read: boolean;
  write: boolean;
  delete: boolean;
}

export const rolePermissions: Record<Role, Permission> = {
  admin: { read: true, write: true, delete: true },
  operator: { read: true, write: true, delete: false },
  viewer: { read: true, write: false, delete: false }
};

export function hasPermission(role: Role, action: 'read' | 'write' | 'delete'): boolean {
  const permission = rolePermissions[role];
  return permission[action];
}

export function extractRoleFromEvent(event: any): Role {
  const role = event.requestContext?.authorizer?.role || event.headers?.['x-user-role'] || 'viewer';
  if (!['admin', 'operator', 'viewer'].includes(role)) {
    return 'viewer';
  }
  return role as Role;
}