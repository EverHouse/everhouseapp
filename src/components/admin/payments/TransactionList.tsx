import React, { useState, useEffect, useImperativeHandle, forwardRef } from 'react';
import EmptyState from '../../EmptyState';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';
import { useRefundPayment } from '../../../hooks/queries/useFinancialsQueries';

export interface Transaction {
  id: string;
  amount: number;
  status: string;
  description: string;
  memberEmail: string;
  memberName: string;
  createdAt: string;
  type: string;
}

export interface SectionProps {
  onClose?: () => void;
  variant?: 'modal' | 'card';
}

export interface TransactionListRef {
  addTransaction: (tx: Transaction) => void;
  refresh: () => void;
}

interface TransactionNote {
  id: number;
  note: string;
  performedByName: string;
  createdAt: string;
}

const RecentTransactionsSection = forwardRef<TransactionListRef, SectionProps>(({ onClose, variant = 'modal' }, ref) => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
  const [notes, setNotes] = useState<TransactionNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const [refundTarget, setRefundTarget] = useState<Transaction | null>(null);
  const [isPartialRefund, setIsPartialRefund] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundError, setRefundError] = useState<string | null>(null);
  const [refundSuccess, setRefundSuccess] = useState(false);
  const refundPaymentMutation = useRefundPayment();
  const isRefunding = refundPaymentMutation.isPending;

  const handleRefund = async () => {
    if (!refundTarget) return;
    setRefundError(null);
    try {
      const amountCents = isPartialRefund && refundAmount
        ? Math.round(parseFloat(refundAmount) * 100)
        : null;
      if (isPartialRefund && amountCents && amountCents > refundTarget.amount) {
        setRefundError('Refund amount cannot exceed original payment amount');
        return;
      }
      await refundPaymentMutation.mutateAsync({
        paymentIntentId: refundTarget.id,
        amountCents,
        reason: refundReason || 'No reason provided'
      });
      setRefundSuccess(true);
      setTimeout(() => {
        setRefundTarget(null);
        setIsPartialRefund(false);
        setRefundAmount('');
        setRefundReason('');
        setRefundSuccess(false);
        fetchTransactions();
      }, 2000);
    } catch (err: unknown) {
      setRefundError((err instanceof Error ? err.message : String(err)) || 'Failed to process refund');
    }
  };

  const reasonOptions = ['Customer request', 'Duplicate charge', 'Service not provided', 'Billing error', 'Other'];

  const fetchTransactions = async () => {
    try {
      const res = await fetch('/api/stripe/transactions/today', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setTransactions(data);
      }
    } catch (err: unknown) {
      console.error('Failed to fetch transactions:', err);
    } finally {
      setLoading(false);
    }
  };

  useImperativeHandle(ref, () => ({
    addTransaction: (tx: Transaction) => {
      setTransactions(prev => [tx, ...prev.filter(t => t.id !== tx.id)]);
    },
    refresh: () => {
      fetchTransactions();
    }
  }));

  useEffect(() => {
    fetchTransactions();
  }, []);

  const fetchNotes = async (txId: string) => {
    setNotesLoading(true);
    try {
      const res = await fetch(`/api/payments/${txId}/notes`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setNotes(data.notes || []);
      }
    } catch (err: unknown) {
      console.error('Failed to fetch notes:', err);
    } finally {
      setNotesLoading(false);
    }
  };

  const handleOpenNotes = (txId: string) => {
    setSelectedTxId(txId);
    setNewNote('');
    fetchNotes(txId);
  };

  const handleCloseNotes = () => {
    setSelectedTxId(null);
    setNotes([]);
    setNewNote('');
  };

  const handleSaveNote = async () => {
    if (!selectedTxId || !newNote.trim()) return;
    
    setSavingNote(true);
    try {
      const res = await fetch('/api/payments/add-note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          transactionId: selectedTxId,
          note: newNote.trim()
        })
      });

      if (res.ok) {
        setNewNote('');
        await fetchNotes(selectedTxId);
      }
    } catch (err: unknown) {
      console.error('Failed to save note:', err);
    } finally {
      setSavingNote(false);
    }
  };

  const content = loading ? (
    <div className="flex items-center justify-center py-8">
      <WalkingGolferSpinner size="sm" variant="auto" />
    </div>
  ) : transactions.length === 0 ? (
    <EmptyState icon="receipt_long" title="No transactions today" description="Payments will appear here as they're processed" variant="compact" />
  ) : (
    <div className="space-y-2 max-h-[300px] overflow-y-auto">
      {transactions.map(tx => (
        <div key={tx.id} className="tactile-row flex items-center gap-3 p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/5 dark:border-white/10">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
            tx.status === 'succeeded' ? 'bg-green-100 dark:bg-green-900/30' : 
            tx.status === 'pending' ? 'bg-amber-100 dark:bg-amber-900/30' : 
            'bg-red-100 dark:bg-red-900/30'
          }`}>
            <span className={`material-symbols-outlined ${
              tx.status === 'succeeded' ? 'text-green-600' : 
              tx.status === 'pending' ? 'text-amber-600' : 
              'text-red-600'
            }`}>
              {tx.status === 'succeeded' ? 'check_circle' : tx.status === 'pending' ? 'schedule' : 'error'}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm text-primary dark:text-white truncate">{tx.memberName}</p>
            <p className="text-xs text-primary/60 dark:text-white/60 truncate">{tx.description || tx.type}</p>
          </div>
          <button
            type="button"
            onClick={() => handleOpenNotes(tx.id)}
            className="tactile-btn p-1.5 rounded-full hover:bg-primary/10 dark:hover:bg-white/10 transition-colors flex-shrink-0"
            title="View/Add Notes"
          >
            <span className="material-symbols-outlined text-primary/60 dark:text-white/60 text-lg">sticky_note_2</span>
          </button>
          {tx.status === 'succeeded' && tx.id.startsWith('pi_') && (
            <button
              type="button"
              onClick={() => {
                setRefundTarget(tx);
                setRefundError(null);
                setRefundSuccess(false);
              }}
              className="tactile-btn px-2.5 py-1 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-xs font-medium hover:bg-purple-200 dark:hover:bg-purple-900/50 transition-colors flex-shrink-0"
              title="Refund"
            >
              Refund
            </button>
          )}
          <div className="text-right flex-shrink-0">
            <p className="font-bold text-primary dark:text-white">${(tx.amount / 100).toFixed(2)}</p>
            <p className="text-xs text-primary/50 dark:text-white/50">
              {new Date(tx.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })}
            </p>
          </div>
        </div>
      ))}

      {selectedTxId && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={handleCloseNotes} aria-hidden="true">
          <div 
            className="bg-white dark:bg-surface-dark rounded-xl w-full max-w-md shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-primary/10 dark:border-white/10">
              <h3 className="font-bold text-primary dark:text-white">Payment Notes</h3>
              <button
                onClick={handleCloseNotes}
                className="tactile-btn p-2 rounded-full hover:bg-primary/10 dark:hover:bg-white/10"
              >
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
              </button>
            </div>
            
            <div className="p-4 space-y-4">
              <div className="max-h-48 overflow-y-auto space-y-2">
                {notesLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
                  </div>
                ) : notes.length === 0 ? (
                  <p className="text-sm text-primary/50 dark:text-white/50 text-center py-4">No notes yet</p>
                ) : (
                  notes.map(note => (
                    <div key={note.id} className="p-3 rounded-lg bg-primary/5 dark:bg-white/5">
                      <p className="text-sm text-primary dark:text-white">{note.note}</p>
                      <p className="text-xs text-primary/50 dark:text-white/50 mt-1">
                        {note.performedByName} · {new Date(note.createdAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}
                      </p>
                    </div>
                  ))
                )}
              </div>

              <div className="space-y-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  rows={2}
                  className="w-full px-3 py-2 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm resize-none"
                />
                <button
                  onClick={handleSaveNote}
                  disabled={!newNote.trim() || savingNote}
                  className="tactile-btn w-full py-2.5 rounded-full bg-primary dark:bg-lavender text-white dark:text-primary font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {savingNote ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-lg">add</span>
                      Add Note
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {refundTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => { setRefundTarget(null); setRefundError(null); }}>
          <div
            className="bg-white dark:bg-surface-dark rounded-xl w-full max-w-md shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-primary/10 dark:border-white/10">
              <h3 className="font-bold text-primary dark:text-white">Refund Payment</h3>
              <button
                type="button"
                onClick={() => { setRefundTarget(null); setRefundError(null); }}
                className="tactile-btn p-2 rounded-full hover:bg-primary/10 dark:hover:bg-white/10"
              >
                <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
              </button>
            </div>

            <div className="p-4 space-y-4">
              {refundSuccess ? (
                <div className="flex flex-col items-center justify-center py-8 gap-3">
                  <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
                    <span className="material-symbols-outlined text-4xl text-green-600">check_circle</span>
                  </div>
                  <p className="text-lg font-semibold text-primary dark:text-white">Refund Processed!</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800/30">
                    <div className="w-10 h-10 rounded-full bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center">
                      <span className="text-purple-600 dark:text-purple-400 font-semibold">
                        {refundTarget.memberName?.charAt(0)?.toUpperCase() || '?'}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-primary dark:text-white truncate">{refundTarget.memberName}</p>
                      <p className="text-xs text-primary/60 dark:text-white/60 truncate">{refundTarget.description}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-primary dark:text-white">${(refundTarget.amount / 100).toFixed(2)}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/10 dark:border-white/10">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" checked={!isPartialRefund} onChange={() => { setIsPartialRefund(false); setRefundAmount(''); }} className="w-4 h-4 accent-purple-500" />
                      <span className="text-sm text-primary dark:text-white">Full Refund</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" checked={isPartialRefund} onChange={() => setIsPartialRefund(true)} className="w-4 h-4 accent-purple-500" />
                      <span className="text-sm text-primary dark:text-white">Partial Refund</span>
                    </label>
                  </div>

                  {isPartialRefund && (
                    <div>
                      <label className="block text-sm font-medium text-primary dark:text-white mb-2">Refund Amount</label>
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60 dark:text-white/60 font-medium">$</span>
                        <input
                          type="number"
                          value={refundAmount}
                          onChange={(e) => setRefundAmount(e.target.value)}
                          placeholder="0.00"
                          step="0.01"
                          min="0.01"
                          max={(refundTarget.amount / 100).toFixed(2)}
                          className="w-full pl-8 pr-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-purple-400 text-lg font-semibold"
                        />
                      </div>
                      <p className="text-xs text-primary/50 dark:text-white/50 mt-1">Maximum: ${(refundTarget.amount / 100).toFixed(2)}</p>
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-primary dark:text-white mb-2">Reason</label>
                    <select
                      value={refundReason}
                      onChange={(e) => setRefundReason(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-400"
                    >
                      <option value="">Select a reason...</option>
                      {reasonOptions.map(reason => (
                        <option key={reason} value={reason}>{reason}</option>
                      ))}
                    </select>
                  </div>

                  {refundError && (
                    <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
                      <p className="text-sm text-red-700 dark:text-red-400">{refundError}</p>
                    </div>
                  )}

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => { setRefundTarget(null); setIsPartialRefund(false); setRefundAmount(''); setRefundReason(''); setRefundError(null); }}
                      className="flex-1 py-3 rounded-full bg-white dark:bg-white/10 text-primary dark:text-white font-medium border border-primary/20 dark:border-white/20 hover:bg-primary/5 dark:hover:bg-white/20 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleRefund}
                      disabled={isRefunding || (isPartialRefund && (!refundAmount || parseFloat(refundAmount) <= 0))}
                      className="flex-1 py-3 rounded-full bg-purple-500 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {isRefunding ? (
                        <>
                          <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                          Processing...
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-outlined text-lg">undo</span>
                          Confirm Refund
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">receipt_long</span>
          <h3 className="font-bold text-primary dark:text-white">Today's Transactions</h3>
          {transactions.length > 0 && (
            <span className="px-2 py-0.5 text-xs font-bold bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded-full">
              {transactions.length}
            </span>
          )}
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">receipt_long</span>
          <h3 className="font-bold text-primary dark:text-white">Today's Transactions</h3>
        </div>
        <button type="button" onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
});

export default RecentTransactionsSection;
