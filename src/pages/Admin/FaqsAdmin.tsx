import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import Toggle from '../../components/Toggle';
import { usePageReady } from '../../contexts/PageReadyContext';
import FloatingActionButton from '../../components/FloatingActionButton';
import ModalShell from '../../components/ModalShell';
import { haptic } from '../../utils/haptics';
import { useDragAutoScroll } from '../../hooks/useDragAutoScroll';

interface FAQ {
    id: number;
    question: string;
    answer: string;
    category: string | null;
    sortOrder: number;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}

const FaqsAdmin: React.FC = () => {
    const { setPageReady } = usePageReady();
    const [faqs, setFaqs] = useState<FAQ[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isEditing, setIsEditing] = useState(false);
    const [editId, setEditId] = useState<number | null>(null);
    const [newItem, setNewItem] = useState<Partial<FAQ>>({ category: 'General', sortOrder: 0, isActive: true });
    const [isSaving, setIsSaving] = useState(false);
    const [isSeeding, setIsSeeding] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
    const [draggedItemId, setDraggedItemId] = useState<number | null>(null);
    const [previewOrder, setPreviewOrder] = useState<FAQ[] | null>(null);
    const originalOrderRef = useRef<FAQ[] | null>(null);
    const { startAutoScroll, updatePosition, stopAutoScroll } = useDragAutoScroll();
    const [faqsRef] = useAutoAnimate();

    useEffect(() => {
        if (!isLoading) {
            setPageReady(true);
        }
    }, [isLoading, setPageReady]);

    const fetchFaqs = async () => {
        try {
            const res = await fetch('/api/admin/faqs', { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setFaqs(data);
            }
        } catch (err) {
            console.error('Failed to fetch FAQs:', err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchFaqs();
    }, []);

    const openEdit = (faq: FAQ) => {
        setNewItem(faq);
        setEditId(faq.id);
        setIsEditing(true);
    };

    const openCreate = () => {
        const maxSortOrder = faqs.length > 0 ? Math.max(...faqs.map(f => f.sortOrder)) : 0;
        setNewItem({ category: 'General', sortOrder: maxSortOrder + 1, isActive: true });
        setEditId(null);
        setIsEditing(true);
    };

    const handleSave = async () => {
        if (!newItem.question?.trim() || !newItem.answer?.trim()) {
            setMessage({ type: 'error', text: 'Question and answer are required' });
            return;
        }

        setIsSaving(true);
        setMessage(null);

        try {
            const payload = {
                question: newItem.question.trim(),
                answer: newItem.answer.trim(),
                category: newItem.category || null,
                sortOrder: newItem.sortOrder ?? 0,
                isActive: newItem.isActive ?? true,
            };

            const res = editId
                ? await fetch(`/api/admin/faqs/${editId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(payload),
                })
                : await fetch('/api/admin/faqs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(payload),
                });

            if (res.ok) {
                setMessage({ type: 'success', text: editId ? 'FAQ updated' : 'FAQ created' });
                await fetchFaqs();
                setIsEditing(false);
            } else {
                const data = await res.json();
                setMessage({ type: 'error', text: data.error || 'Failed to save' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Network error' });
        } finally {
            setIsSaving(false);
            setTimeout(() => setMessage(null), 3000);
        }
    };

    const handleDelete = async (id: number) => {
        try {
            const res = await fetch(`/api/admin/faqs/${id}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (res.ok) {
                setMessage({ type: 'success', text: 'FAQ deleted' });
                setFaqs(prev => prev.filter(f => f.id !== id));
            } else {
                const data = await res.json();
                setMessage({ type: 'error', text: data.error || 'Failed to delete' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Network error' });
        } finally {
            setDeleteConfirm(null);
            setTimeout(() => setMessage(null), 3000);
        }
    };

    const handleSeedFaqs = async () => {
        if (isSeeding) return;
        setIsSeeding(true);
        setMessage(null);
        try {
            const res = await fetch('/api/admin/faqs/seed', {
                method: 'POST',
                credentials: 'include',
            });
            const data = await res.json();
            if (res.ok) {
                setMessage({ type: 'success', text: `Seeded ${data.count} FAQs` });
                await fetchFaqs();
            } else {
                setMessage({ type: 'error', text: data.error || 'Failed to seed FAQs' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Network error' });
        } finally {
            setIsSeeding(false);
            setTimeout(() => setMessage(null), 5000);
        }
    };

    const displayFaqs = useMemo(() => previewOrder ?? faqs, [previewOrder, faqs]);

    const handleDragStart = (e: React.DragEvent, faqId: number) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', faqId.toString());
        setDraggedItemId(faqId);
        originalOrderRef.current = [...faqs];
        setPreviewOrder([...faqs]);
        startAutoScroll();
        haptic.medium();
    };

    const handleDragOver = (e: React.DragEvent, targetId: number) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        updatePosition(e.clientY);
        
        if (draggedItemId === null || draggedItemId === targetId) return;

        setPreviewOrder(prev => {
            if (!prev) return prev;
            const currentDraggedIndex = prev.findIndex(f => f.id === draggedItemId);
            const targetIndex = prev.findIndex(f => f.id === targetId);
            if (currentDraggedIndex === -1 || targetIndex === -1 || currentDraggedIndex === targetIndex) return prev;
            
            const newOrder = [...prev];
            const [movedItem] = newOrder.splice(currentDraggedIndex, 1);
            newOrder.splice(targetIndex, 0, movedItem);
            return newOrder;
        });
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        stopAutoScroll();
        
        const finalOrder = previewOrder;
        const originalOrder = originalOrderRef.current;
        
        setDraggedItemId(null);
        setPreviewOrder(null);
        originalOrderRef.current = null;
        
        if (!finalOrder || !originalOrder) return;

        const orderChanged = finalOrder.some((faq, index) => faq.id !== originalOrder[index].id);
        if (!orderChanged) return;

        const orderUpdates = finalOrder.map((faq, index) => ({
            id: faq.id,
            sortOrder: index + 1
        }));

        setFaqs(finalOrder.map((faq, index) => ({ ...faq, sortOrder: index + 1 })));

        try {
            const res = await fetch('/api/admin/faqs/reorder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ order: orderUpdates }),
            });
            if (!res.ok) {
                throw new Error('Server rejected reorder');
            }
            haptic.success();
        } catch (err) {
            console.error('Failed to reorder:', err);
            setMessage({ type: 'error', text: 'Failed to save new order' });
            await fetchFaqs();
            setTimeout(() => setMessage(null), 3000);
        }
    };

    const handleDragEnd = () => {
        stopAutoScroll();
        setDraggedItemId(null);
        setPreviewOrder(null);
        originalOrderRef.current = null;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <span className="material-symbols-outlined animate-spin text-4xl text-primary/70" aria-hidden="true">progress_activity</span>
            </div>
        );
    }

    return (
        <div className="animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
            <div className="flex justify-between items-center mb-4 animate-slide-up-stagger" style={{ '--stagger-index': 1 } as React.CSSProperties}>
                <h2 className="text-xl font-bold text-primary dark:text-white">FAQs ({faqs.length})</h2>
                {faqs.length === 0 && (
                    <button
                        onClick={handleSeedFaqs}
                        disabled={isSeeding}
                        className="bg-accent text-primary px-3 py-2 min-h-[44px] rounded-lg font-bold flex items-center gap-1 shadow-md text-xs whitespace-nowrap disabled:opacity-50"
                    >
                        <span className="material-symbols-outlined text-sm" aria-hidden="true">{isSeeding ? 'sync' : 'database'}</span>
                        {isSeeding ? 'Seeding...' : 'Seed FAQs'}
                    </button>
                )}
            </div>

            {message && (
                <div className={`mb-4 px-4 py-3 rounded-lg text-sm font-medium ${
                    message.type === 'success'
                        ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800'
                        : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800'
                }`}>
                    {message.text}
                </div>
            )}

            <ModalShell isOpen={isEditing} onClose={() => setIsEditing(false)} title={editId ? 'Edit FAQ' : 'Add FAQ'} size="lg">
                <div className="p-6">
                    <div className="space-y-4 mb-6">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Question</label>
                            <input
                                className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                                placeholder="Enter the question"
                                value={newItem.question || ''}
                                onChange={e => setNewItem({ ...newItem, question: e.target.value })}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Answer</label>
                            <textarea
                                className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast resize-none"
                                placeholder="Enter the answer"
                                rows={4}
                                value={newItem.answer || ''}
                                onChange={e => setNewItem({ ...newItem, answer: e.target.value })}
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
                                <select
                                    className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                                    value={newItem.category || 'General'}
                                    onChange={e => setNewItem({ ...newItem, category: e.target.value })}
                                >
                                    <option>General</option>
                                    <option>Membership</option>
                                    <option>Booking</option>
                                    <option>Amenities</option>
                                    <option>Events</option>
                                    <option>Policies</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Sort Order</label>
                                <input
                                    type="number"
                                    className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                                    value={newItem.sortOrder ?? 0}
                                    onChange={e => setNewItem({ ...newItem, sortOrder: parseInt(e.target.value) || 0 })}
                                />
                            </div>
                        </div>
                        <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25">
                            <span className="text-sm text-gray-700 dark:text-gray-300">Active (visible on public FAQ page)</span>
                            <Toggle
                                checked={newItem.isActive ?? true}
                                onChange={(val) => setNewItem({ ...newItem, isActive: val })}
                                label="Toggle FAQ active status"
                            />
                        </div>
                    </div>
                    <div className="flex gap-3 justify-end">
                        <button
                            onClick={() => setIsEditing(false)}
                            className="px-5 py-2.5 min-h-[44px] text-gray-600 dark:text-white/80 font-bold hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="px-6 py-2.5 min-h-[44px] bg-primary text-white rounded-xl font-bold shadow-md hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
                        >
                            {isSaving && <span className="material-symbols-outlined animate-spin text-sm" aria-hidden="true">progress_activity</span>}
                            Save
                        </button>
                    </div>
                </div>
            </ModalShell>

            <ModalShell isOpen={deleteConfirm !== null} onClose={() => setDeleteConfirm(null)} title="Delete FAQ?" size="sm">
                <div className="p-6">
                    <p className="text-gray-600 dark:text-gray-300 text-sm mb-6">
                        This action cannot be undone. Are you sure you want to delete this FAQ?
                    </p>
                    <div className="flex gap-3 justify-end">
                        <button
                            onClick={() => setDeleteConfirm(null)}
                            className="px-5 py-2.5 min-h-[44px] text-gray-600 dark:text-white/80 font-bold hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => deleteConfirm !== null && handleDelete(deleteConfirm)}
                            className="px-6 py-2.5 min-h-[44px] bg-red-600 text-white rounded-xl font-bold shadow-md hover:bg-red-700 transition-colors"
                        >
                            Delete
                        </button>
                    </div>
                </div>
            </ModalShell>

            {faqs.length === 0 ? (
                <div className="bg-white dark:bg-surface-dark rounded-2xl p-8 text-center shadow-sm border border-gray-200 dark:border-white/20">
                    <span className="material-symbols-outlined text-5xl text-gray-500 dark:text-gray-500 mb-3 block" aria-hidden="true">help_outline</span>
                    <h3 className="text-lg font-bold text-primary dark:text-white mb-2">No FAQs Yet</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-4">Get started by seeding default FAQs or adding your own.</p>
                    <button
                        onClick={handleSeedFaqs}
                        disabled={isSeeding}
                        className="bg-accent text-primary px-4 py-2 min-h-[44px] rounded-lg font-bold text-sm disabled:opacity-50"
                    >
                        {isSeeding ? 'Seeding...' : 'Seed Default FAQs'}
                    </button>
                </div>
            ) : (
                <div ref={faqsRef} className="space-y-3 animate-slide-up-stagger" style={{ '--stagger-index': 2 } as React.CSSProperties}>
                    {displayFaqs.map((faq) => {
                        const isDragging = faq.id === draggedItemId;
                        return (
                            <div
                                key={faq.id}
                                draggable="true"
                                onDragStart={(e) => handleDragStart(e, faq.id)}
                                onDragOver={(e) => handleDragOver(e, faq.id)}
                                onDrop={handleDrop}
                                onDragEnd={handleDragEnd}
                                className={`bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border select-none cursor-grab active:cursor-grabbing ${
                                    faq.isActive 
                                        ? 'border-gray-200 dark:border-white/20' 
                                        : 'border-amber-200 dark:border-amber-800/30 opacity-60'
                                } ${isDragging ? 'opacity-80 scale-[0.95] shadow-xl z-10 relative' : 'transition-all duration-fast ease-out'}`}
                            >
                                <div className="flex items-start gap-3">
                                    <div className="w-11 h-11 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 touch-manipulation" role="img" aria-label="Drag to reorder">
                                        <span className="material-symbols-outlined text-xl" aria-hidden="true">drag_indicator</span>
                                    </div>
                                    <button 
                                        type="button"
                                        className="flex-1 min-w-0 cursor-pointer text-left" 
                                        onClick={() => openEdit(faq)}
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <h4 className="font-bold text-gray-900 dark:text-white line-clamp-1 flex-1">{faq.question}</h4>
                                            {!faq.isActive && (
                                                <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded">
                                                    Hidden
                                                </span>
                                            )}
                                        </div>
                                        {faq.category && (
                                            <span className="inline-block text-[10px] font-bold uppercase tracking-wider bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/80 px-1.5 py-0.5 rounded mb-1">
                                                {faq.category}
                                            </span>
                                        )}
                                        <p className="text-xs text-gray-600 dark:text-gray-300 line-clamp-2">{faq.answer}</p>
                                    </button>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => openEdit(faq)}
                                            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 hover:text-primary hover:bg-primary/10 rounded-full transition-colors"
                                            aria-label="Edit FAQ"
                                        >
                                            <span className="material-symbols-outlined text-lg" aria-hidden="true">edit</span>
                                        </button>
                                        <button
                                            onClick={() => setDeleteConfirm(faq.id)}
                                            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                                            aria-label="Delete FAQ"
                                        >
                                            <span className="material-symbols-outlined text-lg" aria-hidden="true">delete</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
            <FloatingActionButton onClick={openCreate} color="brand" label="Add FAQ" />
        </div>
    );
};

export default FaqsAdmin;
