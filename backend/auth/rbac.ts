export interface User {
  id: string;
  role: 'admin' | 'operator' | 'viewer';
}

export interface Permission {
  resource: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'bulk';
}

const rolePermissions: Record<string, Permission[]> = {
  admin: [
    { resource: '*', action: 'create' },
    { resource: '*', action: 'read' },
    { resource: '*', action: 'update' },
    { resource: '*', action: 'delete' },
    { resource: '*', action: 'bulk' }
  ],
  operator: [
    { resource: '*', action: 'create' },
    { resource: '*', action: 'read' },
    { resource: '*', action: 'update' },
    { resource: '*', action: 'bulk' }
  ],
  viewer: [
    { resource: '*', action: 'read' }
  ]
};

export function hasPermission(user: User, resource: string, action: string): boolean {
  const permissions = rolePermissions[user.role] || [];
  return permissions.some(p => 
    (p.resource === '*' || p.resource === resource) && p.action === action
  );
}

export function extractUserFromEvent(event: any): User {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return {
      id: payload.sub || 'unknown',
      role: payload.role || 'viewer'
    };
  } catch {
    return { id: 'anonymous', role: 'viewer' };
  }
}