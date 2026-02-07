import React, { useEffect, useRef } from 'react';

interface PinnedNote {
  content: string;
  createdBy: string;
}

interface CheckInConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  memberName: string;
  pinnedNotes: PinnedNote[];
  tier?: string | null;
  membershipStatus?: string | null;
}

const CheckInConfirmationModal: React.FC<CheckInConfirmationModalProps> = ({
  isOpen,
  onClose,
  memberName,
  pinnedNotes,
  tier,
  membershipStatus
}) => {
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isOpen) {
      timerRef.current = setTimeout(() => {
        onClose();
      }, 4000);
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isExpired = membershipStatus === 'Expired' || membershipStatus === 'expired';

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-gradient-to-br from-primary via-primary/95 to-primary/85 p-6 text-center">
          <div className="flex justify-end mb-2">
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-full flex items-center justify-center bg-white/20 hover:bg-white/30 transition-colors text-white"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>

          <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-3">
            <span className="material-symbols-outlined text-3xl text-white">check_circle</span>
          </div>

          <h2 className="text-xl font-bold text-white mb-1">{memberName}</h2>
          <p className="text-white/80 text-sm font-medium">Checked In</p>

          {tier && (
            <div className="mt-2 inline-flex items-center px-3 py-1 rounded-full bg-white/15 text-white/90 text-xs font-semibold uppercase tracking-wider">
              {tier}
            </div>
          )}

          {isExpired && (
            <div className="mt-2 inline-flex items-center px-3 py-1 rounded-full bg-red-500/30 text-red-200 text-xs font-bold uppercase tracking-wider">
              Expired Membership
            </div>
          )}
        </div>

        {pinnedNotes.length > 0 && (
          <div className="bg-white p-4 space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-sm text-amber-500">push_pin</span>
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Pinned Notes</span>
            </div>
            {pinnedNotes.map((note, i) => (
              <div key={i} className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-sm text-gray-800">{note.content}</p>
                <p className="text-xs text-gray-400 mt-1">— {note.createdBy}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default CheckInConfirmationModal;
