import React, { useMemo } from 'react';
import { DirectoryTabSkeleton } from '../../../../components/skeletons';
import EmptyState from '../../../../components/EmptyState';
import { formatPhoneNumber } from '../../../../utils/formatting';
import type { TeamMember, StaffRole } from './directoryTypes';

const RoleBadge: React.FC<{ role: StaffRole | null }> = ({ role }) => {
    if (role === 'golf_instructor') {
        return (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                Instructor
            </span>
        );
    }
    if (role === 'admin') {
        return (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                Admin
            </span>
        );
    }
    return (
        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400">
            Staff
        </span>
    );
};

interface TeamListProps {
    teamMembers: TeamMember[];
    teamLoading: boolean;
    teamError: boolean;
    refetchTeam: () => void;
    teamSearchQuery: string;
    openTeamMemberDetails: (member: TeamMember) => void;
}

const TeamList: React.FC<TeamListProps> = ({
    teamMembers,
    teamLoading,
    teamError,
    refetchTeam,
    teamSearchQuery,
    openTeamMemberDetails,
}) => {
    const filteredTeamMembers = useMemo(() => {
        if (!teamSearchQuery.trim()) return teamMembers;
        const query = teamSearchQuery.toLowerCase().trim();
        return teamMembers.filter(member => {
            const name = [member.first_name, member.last_name].filter(Boolean).join(' ').toLowerCase();
            const email = member.email?.toLowerCase() || '';
            const role = member.role?.toLowerCase() || 'staff';
            const jobTitle = member.job_title?.toLowerCase() || '';
            return name.includes(query) || email.includes(query) || role.includes(query) || jobTitle.includes(query);
        });
    }, [teamMembers, teamSearchQuery]);

    if (teamLoading) {
        return <DirectoryTabSkeleton />;
    }

    if (teamError) {
        return (
            <div className="flex flex-col items-center justify-center py-16 px-6 rounded-xl border-2 border-dashed border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/5">
                <span aria-hidden="true" className="material-symbols-outlined text-6xl mb-4 text-red-400 dark:text-red-400/70">cloud_off</span>
                <h3 className="text-2xl leading-tight font-bold mb-2 text-red-600 dark:text-red-400" style={{ fontFamily: 'var(--font-headline)' }}>
                    Failed to load team
                </h3>
                <p className="text-sm text-red-500 dark:text-red-400/80 max-w-sm mx-auto text-center mb-4">
                    There was a problem connecting to the server. Please try again.
                </p>
                <button
                    onClick={() => refetchTeam()}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-bold transition-colors"
                >
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">refresh</span>
                    Retry
                </button>
            </div>
        );
    }

    if (teamMembers.length === 0) {
        return (
            <EmptyState
                icon="group"
                title="No team members found"
                description="Staff and admin accounts will appear here"
                variant="compact"
            />
        );
    }

    if (filteredTeamMembers.length === 0) {
        return (
            <EmptyState
                icon="search_off"
                title="No results found"
                description="Try adjusting your search to find team members"
                variant="compact"
            />
        );
    }

    return (
        <div className="flex-1 min-h-0 relative">
            <div className="h-full overflow-y-auto">
                <div className="md:hidden space-y-3 px-1 pt-2 pb-24">
                    {filteredTeamMembers.map((member, index) => (
                        <div
                            key={member.staff_id}
                            role="button"
                            tabIndex={0}
                            onClick={() => openTeamMemberDetails(member)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTeamMemberDetails(member); } }}
                            className={`bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.98] ${index < 10 ? `animate-list-item-delay-${index}` : 'animate-list-item'}`}
                        >
                            <div className="flex justify-between items-start mb-2">
                                <div className="flex-1">
                                    <h4 className="font-bold text-lg text-primary dark:text-white">
                                        {[member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown'}
                                    </h4>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">{member.email}</p>
                                    {member.phone && <p className="text-xs text-gray-500 dark:text-gray-400">{formatPhoneNumber(member.phone)}</p>}
                                </div>
                                <RoleBadge role={member.role} />
                            </div>
                            <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-gray-50 dark:border-white/20">
                                <p className="text-xs text-gray-500 dark:text-gray-400">{member.job_title || '-'}</p>
                                <span className="material-symbols-outlined text-gray-400 text-[16px]">chevron_right</span>
                            </div>
                        </div>
                    ))}
                </div>
                <table className="hidden md:table w-full" style={{ tableLayout: 'fixed' }}>
                    <colgroup>
                        <col style={{ width: '18%' }} />
                        <col style={{ width: '25%' }} />
                        <col style={{ width: '14%' }} />
                        <col style={{ width: '30%' }} />
                        <col style={{ width: '13%' }} />
                    </colgroup>
                    <thead className="sticky top-0 z-10">
                        <tr>
                            <td colSpan={5} className="p-0">
                                <div className="flex items-center bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
                                    <div style={{ width: '18%' }} className="px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Name</div>
                                    <div style={{ width: '25%' }} className="px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Email</div>
                                    <div style={{ width: '14%' }} className="px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Phone</div>
                                    <div style={{ width: '30%' }} className="px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Job Title</div>
                                    <div style={{ width: '13%' }} className="px-3 py-3 text-left text-xs font-bold text-gray-600 dark:text-gray-400 uppercase">Role</div>
                                </div>
                            </td>
                        </tr>
                    </thead>
                    <tbody >
                        {filteredTeamMembers.map(member => (
                            <tr
                                key={member.staff_id}
                                tabIndex={0}
                                role="button"
                                onClick={() => openTeamMemberDetails(member)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTeamMemberDetails(member); } }}
                                className="border-b border-gray-100 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
                            >
                                <td style={{ width: '18%' }} className="p-3 font-medium text-primary dark:text-white truncate">{[member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown'}</td>
                                <td style={{ width: '25%' }} className="p-3 text-sm text-gray-600 dark:text-gray-400 truncate">{member.email}</td>
                                <td style={{ width: '14%' }} className="p-3 text-sm text-gray-600 dark:text-gray-400 truncate">{member.phone ? formatPhoneNumber(member.phone) : '-'}</td>
                                <td style={{ width: '30%' }} className="p-3 text-sm text-gray-600 dark:text-gray-400 truncate">{member.job_title || '-'}</td>
                                <td style={{ width: '13%' }} className="p-3"><RoleBadge role={member.role} /></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export { RoleBadge };
export default TeamList;
