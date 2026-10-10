export type DataVisibility = 'private' | 'internal' | 'public';

export interface DataPermission {
  entityId: string;
  visibility: DataVisibility;
}

export function canReadData(permission: DataPermission, requested: DataVisibility): boolean {
  const levels: Record<DataVisibility, number> = { private: 3, internal: 2, public: 1 };
  return levels[requested] <= levels[permission.visibility];
}
