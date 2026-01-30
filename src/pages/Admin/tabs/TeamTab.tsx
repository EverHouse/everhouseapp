import React, { useState, useEffect, useMemo } from 'react';
import { useData } from '../../../contexts/DataContext';
import ModalShell from '../../../components/ModalShell';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';
import FloatingActionButton from '../../../components/FloatingActionButton';
import { formatPhoneNumber } from '../../../utils/formatting';
import { AnimatedPage } from '../../../components/motion';

type StaffRole = 'staff' | 'admin' | 'golf_instructor';

interface TeamMember {
  id: number;
  email: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  job_title: string | null;
  role: StaffRole | null;
  is_active: boolean;
  created_at: string;
  created_by: string | null;
}

const RoleBadge: React.FC<{ role: StaffRole | null }> = ({ role }) => {
  if (role === 'admin') {
    return (
      <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-bold bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
        Admin
      </span>
    );
  }
  if (role === 'golf_instructor') {
    return (
      <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        Golf Instructor
      </span>
    );
  }
  return (
    <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-bold bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400">
      Staff
    </span>
  );
};

interface TeamFieldErrors {
  email?: string;
  phone?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[\d\s\-\+\(\)\.]+$/;

const validateEmail = (value: string): string | undefined => {
  if (!value.trim()) return 'Email is required';
  if (!EMAIL_REGEX.test(value)) return 'Please enter a valid email address';
  if (value.length > 255) return 'Email must be 255 characters or less';
  return undefined;
};

const validatePhone = (value: string): string | undefined => {
  if (!value.trim()) return undefined;
  if (!PHONE_REGEX.test(value)) return 'Please enter a valid phone number';
  const digitsOnly = value.replace(/\D/g, '');
  if (digitsOnly.length > 0 && digitsOnly.length < 10) return 'Phone number must have at least 10 digits';
  if (digitsOnly.length > 15) return 'Phone number is too long';
  return undefined;
};

const TeamTab: React.FC = () => {
  const { actualUser } = useData();
  const isAdmin = actualUser?.role === 'admin';
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isViewingDetails, setIsViewingDetails] = useState(false);
  const [selectedMember, setSelectedMember] = useState<TeamMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddingPerson, setIsAddingPerson] = useState(false);
  const [newPerson, setNewPerson] = useState({ firstName: '', lastName: '', email: '', phone: '', jobTitle: '', role: 'staff' as StaffRole });
  const [addError, setAddError] = useState<string | null>(null);
  const [editFieldErrors, setEditFieldErrors] = useState<TeamFieldErrors>({});
  const [addFieldErrors, setAddFieldErrors] = useState<TeamFieldErrors>({});

  useEffect(() => {
    fetchTeamMembers();
  }, []);

  useEffect(() => {
    if (isViewingDetails || isEditing || isAddingPerson) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isViewingDetails, isEditing, isAddingPerson]);

  const fetchTeamMembers = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetch('/api/staff-users?include_all=true', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setTeamMembers(data);
      } else {
        const errorData = await res.json().catch(() => ({}));
        setError(errorData.message || `Failed to load team (${res.status})`);
      }
    } catch (err) {
      console.error('Error fetching team members:', err);
      setError('Failed to connect to server');
    } finally {
      setIsLoading(false);
    }
  };

  const filteredMembers = useMemo(() => {
    if (!searchQuery.trim()) return teamMembers;
    const query = searchQuery.toLowerCase().trim();
    return teamMembers.filter(member => {
      const name = member.name?.toLowerCase() || '';
      const email = member.email.toLowerCase();
      const role = member.role?.toLowerCase() || 'staff';
      const firstName = member.first_name?.toLowerCase() || '';
      const lastName = member.last_name?.toLowerCase() || '';
      return name.includes(query) || email.includes(query) || role.includes(query) || firstName.includes(query) || lastName.includes(query);
    });
  }, [teamMembers, searchQuery]);

  const openDetailsModal = (member: TeamMember) => {
    setSelectedMember({...member});
    setIsViewingDetails(true);
  };

  const handleRemoveMember = async (member: TeamMember) => {
    if (member.role === 'admin') {
      const adminCount = teamMembers.filter(m => m.role === 'admin' && m.is_active).length;
      if (adminCount <= 1) {
        setError('Cannot remove the last active admin');
        setTimeout(() => setError(null), 3000);
        return;
      }
    }

    if (!window.confirm(`Remove ${member.name || member.email} from team?`)) return;

    try {
      const res = await fetch(`/api/staff-users/${member.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (res.ok) {
        setTeamMembers(prev => prev.filter(m => m.id !== member.id));
        setSuccess('Team member removed');
        setTimeout(() => setSuccess(null), 3000);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to remove team member');
        setTimeout(() => setError(null), 3000);
      }
    } catch (err) {
      console.error('Error removing team member:', err);
      setError('Failed to remove team member');
      setTimeout(() => setError(null), 3000);
    }
  };

  const openEditModal = (member: TeamMember) => {
    setSelectedMember({...member});
    setIsEditing(true);
    setError(null);
    setEditFieldErrors({});
  };

  const handleEditEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (selectedMember) {
      setSelectedMember({ ...selectedMember, email: value });
    }
    if (editFieldErrors.email) {
      setEditFieldErrors(prev => ({ ...prev, email: validateEmail(value) }));
    }
  };

  const handleEditPhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (selectedMember) {
      setSelectedMember({ ...selectedMember, phone: value || null });
    }
    if (editFieldErrors.phone) {
      setEditFieldErrors(prev => ({ ...prev, phone: validatePhone(value) }));
    }
  };

  const handleEditSave = async () => {
    if (!selectedMember) return;

    const errors: TeamFieldErrors = {
      email: validateEmail(selectedMember.email),
      phone: validatePhone(selectedMember.phone || '')
    };
    setEditFieldErrors(errors);
    
    if (Object.values(errors).some(e => e !== undefined)) {
      return;
    }

    try {
      setError(null);
      const res = await fetch(`/api/staff-users/${selectedMember.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: selectedMember.name,
          email: selectedMember.email,
          first_name: selectedMember.first_name,
          last_name: selectedMember.last_name,
          phone: selectedMember.phone,
          job_title: selectedMember.job_title,
          role: selectedMember.role
        })
      });

      if (res.ok) {
        const updated = await res.json();
        setTeamMembers(prev => prev.map(m => m.id === updated.id ? updated : m));
        setIsEditing(false);
        setSelectedMember(null);
        setSuccess('Team member updated');
        setTimeout(() => setSuccess(null), 3000);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to update team member');
      }
    } catch (err) {
      setError('Failed to update team member');
    }
  };

  const handleAddEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setNewPerson({ ...newPerson, email: value });
    if (addFieldErrors.email) {
      setAddFieldErrors(prev => ({ ...prev, email: validateEmail(value) }));
    }
  };

  const handleAddPhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setNewPerson({ ...newPerson, phone: value });
    if (addFieldErrors.phone) {
      setAddFieldErrors(prev => ({ ...prev, phone: validatePhone(value) }));
    }
  };

  const handleAddPerson = async () => {
    const errors: TeamFieldErrors = {
      email: validateEmail(newPerson.email),
      phone: validatePhone(newPerson.phone)
    };
    setAddFieldErrors(errors);
    
    if (Object.values(errors).some(e => e !== undefined)) {
      return;
    }

    try {
      setAddError(null);
      const fullName = `${newPerson.firstName.trim()} ${newPerson.lastName.trim()}`.trim();
      
      const res = await fetch('/api/staff-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: newPerson.email.trim(),
          name: fullName || null,
          first_name: newPerson.firstName.trim() || null,
          last_name: newPerson.lastName.trim() || null,
          phone: newPerson.phone.trim() || null,
          job_title: newPerson.jobTitle.trim() || null,
          role: newPerson.role,
          created_by: actualUser?.email
        })
      });

      if (!res.ok) {
        const data = await res.json();
        setAddError(data.error || 'Failed to add team member');
        return;
      }

      const newMember = await res.json();
      setTeamMembers(prev => [newMember, ...prev]);
      setNewPerson({ firstName: '', lastName: '', email: '', phone: '', jobTitle: '', role: 'staff' });
      setIsAddingPerson(false);
      setSuccess('Team member added');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setAddError('Failed to add team member');
    }
  };

  return (
    <AnimatedPage>
      <div className="bg-white dark:bg-surface-dark rounded-2xl p-6 border border-gray-200 dark:border-white/25 animate-content-enter-delay-1">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold text-primary dark:text-white">Team Directory</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {isAdmin ? 'Manage team members and portal access' : 'View team contact information'}
            </p>
          </div>
        </div>

        <div className="mb-4">
          <div className="relative">
            <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">search</span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, email, or role..."
              className="w-full pl-10 pr-4 py-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white placeholder-gray-400"
            />
          </div>
        </div>

        {success && (
          <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg text-green-700 dark:text-green-400 text-sm">
            {success}
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="py-8 flex flex-col items-center gap-2">
            <WalkingGolferSpinner size="md" variant="dark" />
            <p className="text-sm text-gray-500">Loading team...</p>
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="py-8 text-center text-gray-500 dark:text-gray-400">
            {searchQuery ? 'No team members match your search.' : (isAdmin ? 'No team members added yet. Add an email to grant portal access.' : 'No team members to display.')}
          </div>
        ) : (
          <div className="space-y-3 animate-content-enter-delay-2">
            {filteredMembers.map((member, index) => (
              <div 
                key={member.id}
                onClick={() => openDetailsModal(member)}
                className={`flex items-center justify-between p-4 rounded-xl border transition-colors animate-list-item-delay-${Math.min(index, 10)} cursor-pointer hover:border-primary/50 ${
                  member.is_active 
                    ? 'bg-white dark:bg-surface-dark border-gray-200 dark:border-white/25 hover:bg-gray-50 dark:hover:bg-surface-dark' 
                    : 'bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-white/20 opacity-60'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center flex-wrap">
                    <p className="font-medium text-primary dark:text-white">{member.name || member.email}</p>
                    <RoleBadge role={member.role} />
                  </div>
                  {member.name && <p className="text-sm text-gray-500 dark:text-gray-400">{member.email}</p>}
                  {member.job_title && <p className="text-sm text-gray-500 dark:text-gray-400">{member.job_title}</p>}
                  {member.phone && <p className="text-sm text-gray-500 dark:text-gray-400">{formatPhoneNumber(member.phone)}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ModalShell isOpen={isViewingDetails && !!selectedMember} onClose={() => { setIsViewingDetails(false); setSelectedMember(null); }} title={selectedMember?.name || selectedMember?.email || 'Team Member Details'}>
        <div className="p-6 space-y-3">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="material-symbols-outlined text-gray-600">email</span>
            <span className="text-gray-700 dark:text-gray-300">{selectedMember?.email}</span>
          </div>
          {selectedMember?.phone && (
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="material-symbols-outlined text-gray-600">phone</span>
              <span className="text-gray-700 dark:text-gray-300">{formatPhoneNumber(selectedMember.phone)}</span>
            </div>
          )}
          {selectedMember?.job_title && (
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="material-symbols-outlined text-gray-600">work</span>
              <span className="text-gray-700 dark:text-gray-300">{selectedMember.job_title}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="material-symbols-outlined text-gray-600">badge</span>
            <span className={`px-2 py-1 rounded-full text-xs font-bold ${
              selectedMember?.role === 'admin' 
                ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' 
                : selectedMember?.role === 'golf_instructor'
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
            }`}>
              {selectedMember?.role === 'admin' ? 'Admin' : selectedMember?.role === 'golf_instructor' ? 'Golf Instructor' : 'Staff'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="material-symbols-outlined text-gray-600">toggle_on</span>
            <span className={`px-2 py-1 rounded-full text-xs font-bold ${selectedMember?.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'}`}>
              {selectedMember?.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>

          {isAdmin && selectedMember && (
            <div className="flex gap-3 pt-4 border-t border-gray-200 dark:border-white/25">
              <button
                onClick={() => { setIsViewingDetails(false); openEditModal(selectedMember); }}
                className="flex-1 py-3 px-4 rounded-lg bg-brand-green text-white font-medium hover:opacity-90 flex items-center justify-center gap-2"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-lg">edit</span>
                Edit
              </button>
              <button
                onClick={() => { setIsViewingDetails(false); handleRemoveMember(selectedMember); }}
                className="flex-1 py-3 px-4 rounded-lg bg-red-500 text-white font-medium hover:opacity-90 flex items-center justify-center gap-2"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-lg">delete</span>
                Delete
              </button>
            </div>
          )}
        </div>
      </ModalShell>

      {isAdmin && <ModalShell isOpen={isEditing && !!selectedMember} onClose={() => { setIsEditing(false); setSelectedMember(null); setError(null); }} title="Edit Team Member" showCloseButton={false}>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                First Name
              </label>
              <input
                type="text"
                value={selectedMember?.first_name || ''}
                onChange={(e) => selectedMember && setSelectedMember({...selectedMember, first_name: e.target.value || null})}
                placeholder="Jane"
                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Last Name
              </label>
              <input
                type="text"
                value={selectedMember?.last_name || ''}
                onChange={(e) => selectedMember && setSelectedMember({...selectedMember, last_name: e.target.value || null})}
                placeholder="Doe"
                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
              />
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Email *
            </label>
            <input
              type="email"
              value={selectedMember?.email || ''}
              onChange={handleEditEmailChange}
              placeholder="email@example.com"
              className={`w-full p-3 rounded-lg border bg-gray-50 dark:bg-black/30 text-primary dark:text-white ${
                editFieldErrors.email ? 'border-red-500' : 'border-gray-200 dark:border-white/25'
              }`}
            />
            {editFieldErrors.email && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{editFieldErrors.email}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Phone
            </label>
            <input
              type="tel"
              value={selectedMember?.phone || ''}
              onChange={handleEditPhoneChange}
              placeholder="+1 (555) 123-4567"
              className={`w-full p-3 rounded-lg border bg-gray-50 dark:bg-black/30 text-primary dark:text-white ${
                editFieldErrors.phone ? 'border-red-500' : 'border-gray-200 dark:border-white/25'
              }`}
            />
            {editFieldErrors.phone && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{editFieldErrors.phone}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Job Title
            </label>
            <input
              type="text"
              value={selectedMember?.job_title || ''}
              onChange={(e) => selectedMember && setSelectedMember({...selectedMember, job_title: e.target.value || null})}
              placeholder="Manager"
              className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Role
            </label>
            <select
              value={selectedMember?.role || 'staff'}
              onChange={(e) => selectedMember && setSelectedMember({...selectedMember, role: e.target.value as StaffRole})}
              className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
            >
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
              <option value="golf_instructor">Golf Instructor</option>
            </select>
          </div>

          {error && (
            <p className="text-red-600 text-sm">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => { setIsEditing(false); setSelectedMember(null); setError(null); }}
              className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleEditSave}
              className="flex-1 py-3 px-4 rounded-lg bg-brand-green text-white font-medium hover:opacity-90"
            >
              Save
            </button>
          </div>
        </div>
      </ModalShell>}

      <ModalShell isOpen={isAddingPerson} onClose={() => { setIsAddingPerson(false); setAddError(null); setAddFieldErrors({}); setNewPerson({ firstName: '', lastName: '', email: '', phone: '', jobTitle: '', role: 'staff' as StaffRole }); }} title="Add Team Member" showCloseButton={false}>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                First Name
              </label>
              <input
                type="text"
                value={newPerson.firstName}
                onChange={(e) => setNewPerson({...newPerson, firstName: e.target.value})}
                placeholder="Jane"
                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Last Name
              </label>
              <input
                type="text"
                value={newPerson.lastName}
                onChange={(e) => setNewPerson({...newPerson, lastName: e.target.value})}
                placeholder="Doe"
                className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Email Address *
            </label>
            <input
              type="email"
              value={newPerson.email}
              onChange={handleAddEmailChange}
              placeholder="email@example.com"
              className={`w-full p-3 rounded-lg border bg-gray-50 dark:bg-black/30 text-primary dark:text-white ${
                addFieldErrors.email ? 'border-red-500' : 'border-gray-200 dark:border-white/25'
              }`}
            />
            {addFieldErrors.email && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{addFieldErrors.email}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Phone
            </label>
            <input
              type="tel"
              value={newPerson.phone}
              onChange={handleAddPhoneChange}
              placeholder="+1 (555) 123-4567"
              className={`w-full p-3 rounded-lg border bg-gray-50 dark:bg-black/30 text-primary dark:text-white ${
                addFieldErrors.phone ? 'border-red-500' : 'border-gray-200 dark:border-white/25'
              }`}
            />
            {addFieldErrors.phone && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{addFieldErrors.phone}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Job Title
            </label>
            <input
              type="text"
              value={newPerson.jobTitle}
              onChange={(e) => setNewPerson({...newPerson, jobTitle: e.target.value})}
              placeholder="Manager"
              className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Role *
            </label>
            <select
              value={newPerson.role}
              onChange={(e) => setNewPerson({...newPerson, role: e.target.value as StaffRole})}
              className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
            >
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
              <option value="golf_instructor">Golf Instructor</option>
            </select>
          </div>

          {addError && (
            <p className="text-red-600 text-sm">{addError}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => { setIsAddingPerson(false); setAddError(null); setAddFieldErrors({}); setNewPerson({ firstName: '', lastName: '', email: '', phone: '', jobTitle: '', role: 'staff' as StaffRole }); }}
              className="flex-1 py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleAddPerson}
              className="flex-1 py-3 px-4 rounded-lg bg-brand-green text-white font-medium hover:opacity-90"
            >
              Add Team Member
            </button>
          </div>
        </div>
      </ModalShell>

      {isAdmin && <FloatingActionButton onClick={() => setIsAddingPerson(true)} color="brand" label="Add team member" />}
    </AnimatedPage>
  );
};

export default TeamTab;
