import { useState, useEffect, useRef } from 'react';
import { ModalShell } from '../../ModalShell';
import TrackmanIcon from '../../icons/TrackmanIcon';
import { useToast } from '../../Toast';
import TierBadge from '../../TierBadge';

interface TrackmanNotesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface MemberSearchResult {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name?: string;
  tier?: string | null;
  userType?: 'visitor' | 'member' | 'staff' | 'instructor';
}

export function TrackmanNotesModal({ isOpen, onClose }: TrackmanNotesModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemberSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSearchResults([]);
      setCopiedEmail(null);
    } else {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    const searchMembers = async () => {
      if (!searchQuery || searchQuery.length < 2) {
        setSearchResults([]);
        return;
      }
      setIsSearching(true);
      try {
        const res = await fetch(
          `/api/visitors/search?query=${encodeURIComponent(searchQuery)}&limit=10&includeMembers=true`,
          { credentials: 'include' }
        );
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data.filter((r: MemberSearchResult) => {
            const email = r.email?.toLowerCase() || '';
            return !email.includes('@visitors.evenhouse.club') &&
                   !email.includes('@trackman.local') &&
                   !email.startsWith('unmatched-');
          }));
        }
      } catch (err) {
        console.error('Search error:', err);
      } finally {
        setIsSearching(false);
      }
    };
    const timeoutId = setTimeout(searchMembers, 300);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  const generateTrackmanNotes = (member: MemberSearchResult): string => {
    const firstName = member.firstName || '';
    const lastName = member.lastName || '';
    return `M|${member.email}|${firstName}|${lastName}`;
  };

  const handleCopyNotes = async (member: MemberSearchResult) => {
    const notes = generateTrackmanNotes(member);
    try {
      await navigator.clipboard.writeText(notes);
      setCopiedEmail(member.email);
      showToast('Trackman notes copied to clipboard!', 'success');
      setTimeout(() => setCopiedEmail(null), 2000);
    } catch (err) {
      showToast('Failed to copy to clipboard', 'error');
    }
  };

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} showCloseButton>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center">
            <TrackmanIcon className="w-6 h-6 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-primary dark:text-white">
              Trackman Notes Generator
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Generate customer_notes for Trackman bookings
            </p>
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Search Member
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-gray-400 text-lg">
              search
            </span>
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name or email..."
              className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 dark:border-white/20 bg-white dark:bg-black/20 text-primary dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/30 dark:focus:ring-lavender/30"
            />
            {isSearching && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-gray-400 text-lg animate-spin">
                progress_activity
              </span>
            )}
          </div>
        </div>

        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3 mb-4">
          <div className="flex gap-2">
            <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-sm flex-shrink-0 mt-0.5">info</span>
            <div className="text-xs text-amber-800 dark:text-amber-300">
              <p className="font-medium">Format: M|email|firstName|lastName</p>
              <p className="mt-1 text-amber-700 dark:text-amber-400">
                Paste this into the "Customer Notes" field when creating a booking in Trackman
              </p>
            </div>
          </div>
        </div>

        <div className="min-h-[200px] max-h-[300px] overflow-y-auto">
          {searchQuery.length < 2 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500 dark:text-gray-400">
              <span className="material-symbols-outlined text-4xl mb-2 opacity-50">person_search</span>
              <p className="text-sm">Type at least 2 characters to search</p>
            </div>
          ) : isSearching ? (
            <div className="flex items-center justify-center py-12">
              <span className="material-symbols-outlined text-primary dark:text-white animate-spin">progress_activity</span>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500 dark:text-gray-400">
              <span className="material-symbols-outlined text-4xl mb-2 opacity-50">search_off</span>
              <p className="text-sm">No members found</p>
            </div>
          ) : (
            <div className="space-y-2">
              {searchResults.map((member) => {
                const isCopied = copiedEmail === member.email;
                const notes = generateTrackmanNotes(member);
                return (
                  <div
                    key={member.id || member.email}
                    className={`p-3 rounded-lg border transition-all ${
                      isCopied
                        ? 'border-green-500 bg-green-50 dark:bg-green-500/10'
                        : 'border-gray-200 dark:border-white/10 hover:border-primary/30 dark:hover:border-white/30 hover:bg-gray-50 dark:hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="font-medium text-primary dark:text-white truncate">
                            {member.name || `${member.firstName} ${member.lastName}`.trim() || 'Unknown'}
                          </p>
                          {member.tier && <TierBadge tier={member.tier} size="xs" />}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {member.email}
                        </p>
                        <div className="mt-2 px-2 py-1.5 bg-gray-100 dark:bg-black/30 rounded font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
                          {notes}
                        </div>
                      </div>
                      <button
                        onClick={() => handleCopyNotes(member)}
                        className={`flex-shrink-0 px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-1.5 transition-all ${
                          isCopied
                            ? 'bg-green-500 text-white'
                            : 'bg-primary dark:bg-white/10 text-white dark:text-white hover:bg-primary/90 dark:hover:bg-white/20'
                        }`}
                      >
                        <span className="material-symbols-outlined text-base">
                          {isCopied ? 'check' : 'content_copy'}
                        </span>
                        {isCopied ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-6 pt-4 border-t border-gray-200 dark:border-white/10">
          <button
            onClick={onClose}
            className="w-full py-3 px-4 rounded-lg border border-gray-200 dark:border-white/25 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
