import { useData } from '../contexts/DataContext';

export interface StaffUser {
  email: string;
  name: string;
  role: 'staff' | 'admin';
}

export function useEffectiveStaffUser(): StaffUser | null {
  const { actualUser } = useData();
  
  if (!actualUser) return null;
  if (actualUser.role !== 'staff' && actualUser.role !== 'admin') return null;
  
  return {
    email: actualUser.email,
    name: actualUser.name || actualUser.email,
    role: actualUser.role as 'staff' | 'admin'
  };
}

export function isStaffOrAdmin(role: string | undefined): boolean {
  return role === 'staff' || role === 'admin';
}
