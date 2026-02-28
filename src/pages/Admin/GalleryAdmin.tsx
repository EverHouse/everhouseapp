import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import Toggle from '../../components/Toggle';
import { usePageReady } from '../../contexts/PageReadyContext';
import FloatingActionButton from '../../components/FloatingActionButton';
import ModalShell from '../../components/ModalShell';
import { haptic } from '../../utils/haptics';
import { useDragAutoScroll } from '../../hooks/useDragAutoScroll';

interface GalleryImage {
    id: number;
    title: string | null;
    imageUrl: string;
    category: string;
    sortOrder: number;
    isActive: boolean;
}

const GalleryAdmin: React.FC = () => {
    const { setPageReady } = usePageReady();
    const [images, setImages] = useState<GalleryImage[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isEditing, setIsEditing] = useState(false);
    const [editId, setEditId] = useState<number | null>(null);
    const [newItem, setNewItem] = useState<Partial<GalleryImage>>({ category: 'venue', isActive: true });
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [draggedItemId, setDraggedItemId] = useState<number | null>(null);
    const [previewOrder, setPreviewOrder] = useState<GalleryImage[] | null>(null);
    const originalOrderRef = useRef<GalleryImage[] | null>(null);
    const [reorderError, setReorderError] = useState<string | null>(null);
    const [togglingId, setTogglingId] = useState<number | null>(null);
    const { startAutoScroll, updatePosition, stopAutoScroll } = useDragAutoScroll();
    const [galleryRef] = useAutoAnimate();

    useEffect(() => {
        if (!isLoading) {
            setPageReady(true);
        }
    }, [isLoading, setPageReady]);

    const fetchImages = async () => {
        try {
            const res = await fetch('/api/gallery?include_inactive=true', { credentials: 'include' });
            const data = await res.json();
            setImages(data);
        } catch (err: unknown) {
            console.error('Failed to fetch gallery images:', err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchImages();
    }, []);

    const openEdit = (image: GalleryImage) => {
        setNewItem(image);
        setEditId(image.id);
        setIsEditing(true);
        setError(null);
        setUploadProgress('');
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const openCreate = () => {
        setNewItem({ category: 'venue', isActive: true, sortOrder: 0 });
        setEditId(null);
        setIsEditing(true);
        setError(null);
        setUploadProgress('');
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const handleFileUpload = async (file: File) => {
        setUploading(true);
        setUploadProgress('Converting to WebP...');
        try {
            const formData = new FormData();
            formData.append('image', file);
            const res = await fetch('/api/admin/upload-image', {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });
            if (!res.ok) throw new Error('Upload failed');
            const data = await res.json();
            setNewItem({ ...newItem, imageUrl: data.imageUrl });
            setUploadProgress(`Optimized: ${Math.round(data.originalSize/1024)}KB → ${Math.round(data.optimizedSize/1024)}KB`);
        } catch (err: unknown) {
            setUploadProgress('Upload failed. Please try again.');
        } finally {
            setUploading(false);
        }
    };

    const handleSave = async () => {
        setError(null);
        
        if (!newItem.imageUrl?.trim()) {
            setError('Image URL is required');
            return;
        }

        setIsSaving(true);
        try {
            const payload = {
                title: newItem.title || null,
                imageUrl: newItem.imageUrl,
                category: newItem.category || 'venue',
                sortOrder: newItem.sortOrder || 0,
                isActive: newItem.isActive !== false
            };

            const url = editId ? `/api/admin/gallery/${editId}` : '/api/admin/gallery';
            const method = editId ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                credentials: 'include'
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to save');
            }

            await fetchImages();
            setIsEditing(false);
        } catch (err: unknown) {
            setError((err instanceof Error ? err.message : String(err)) || 'Failed to save image');
        } finally {
            setIsSaving(false);
        }
    };

    const handleToggleActive = async (image: GalleryImage) => {
        setTogglingId(image.id);
        try {
            const res = await fetch(`/api/admin/gallery/${image.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isActive: !image.isActive }),
                credentials: 'include'
            });

            if (res.ok) {
                await fetchImages();
            }
        } catch (err: unknown) {
            console.error('Failed to toggle status:', err);
        } finally {
            setTogglingId(null);
        }
    };

    const handleDelete = async (id: number) => {
        try {
            const res = await fetch(`/api/admin/gallery/${id}`, {
                method: 'DELETE',
                credentials: 'include'
            });

            if (res.ok) {
                await fetchImages();
            }
        } catch (err: unknown) {
            console.error('Failed to delete image:', err);
        } finally {
            setDeleteConfirm(null);
        }
    };

    const displayImages = useMemo(() => previewOrder ?? images, [previewOrder, images]);

    const handleDragStart = (e: React.DragEvent, imageId: number) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', imageId.toString());
        setDraggedItemId(imageId);
        originalOrderRef.current = [...images];
        setPreviewOrder([...images]);
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
            const currentDraggedIndex = prev.findIndex(img => img.id === draggedItemId);
            const targetIndex = prev.findIndex(img => img.id === targetId);
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

        const orderChanged = finalOrder.some((img, index) => img.id !== originalOrder[index].id);
        if (!orderChanged) return;

        const orderUpdates = finalOrder.map((img, index) => ({
            id: img.id,
            sortOrder: index + 1
        }));

        setImages(finalOrder.map((img, index) => ({ ...img, sortOrder: index + 1 })));

        try {
            const res = await fetch('/api/admin/gallery/reorder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ order: orderUpdates }),
            });
            if (!res.ok) {
                throw new Error('Server rejected reorder');
            }
            haptic.success();
        } catch (err: unknown) {
            console.error('Failed to reorder:', err);
            setReorderError('Failed to save new order');
            await fetchImages();
            setTimeout(() => setReorderError(null), 3000);
        }
    };

    const handleDragEnd = () => {
        stopAutoScroll();
        setDraggedItemId(null);
        setPreviewOrder(null);
        originalOrderRef.current = null;
    };

    const categories = ['venue', 'events', 'food', 'golf', 'wellness', 'outdoor'];

    return (
        <div className="animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
            <div className="flex justify-between items-center mb-4 animate-slide-up-stagger" style={{ '--stagger-index': 1 } as React.CSSProperties}>
                <h2 className="text-2xl leading-tight text-primary dark:text-white" style={{ fontFamily: 'var(--font-headline)' }}>Gallery Images</h2>
            </div>

            {reorderError && (
                <div className="mb-4 px-4 py-3 rounded-lg text-sm font-medium bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800">
                    {reorderError}
                </div>
            )}

            <ModalShell isOpen={isEditing} onClose={() => setIsEditing(false)} title={editId ? 'Edit Image' : 'Add Image'}>
                <div className="p-6">
                    {error && (
                        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
                            {error}
                        </div>
                    )}
                    <div className="space-y-4 mb-6">
                        <input 
                            className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
                            placeholder="Title (Optional)" 
                            aria-label="Title"
                            value={newItem.title || ''} 
                            onChange={e => setNewItem({...newItem, title: e.target.value})} 
                        />
                        <div className="space-y-2">
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Upload Image</label>
                            <div className="flex gap-2">
                                <input 
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*"
                                    className="flex-1 border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-white hover:file:bg-primary/90 file:cursor-pointer"
                                    disabled={uploading}
                                />
                                <button
                                    type="button"
                                    onClick={() => {
                                        const file = fileInputRef.current?.files?.[0];
                                        if (file) handleFileUpload(file);
                                    }}
                                    disabled={uploading}
                                    className="tactile-btn px-4 py-2.5 min-h-[44px] bg-primary text-white rounded-xl font-bold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 whitespace-nowrap"
                                >
                                    {uploading ? 'Uploading...' : 'Upload'}
                                </button>
                            </div>
                            {uploadProgress && (
                                <p className={`text-sm ${uploadProgress.includes('failed') ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
                                    {uploadProgress}
                                </p>
                            )}
                            <p className="text-xs text-gray-600 dark:text-gray-300">Images are automatically optimized to WebP format</p>
                        </div>
                        <div className="relative">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-gray-200 dark:border-white/25"></div>
                            </div>
                            <div className="relative flex justify-center text-xs uppercase">
                                <span className="bg-white dark:bg-[#1a1d15] px-2 text-gray-600 dark:text-gray-300">or paste URL</span>
                            </div>
                        </div>
                        <input 
                            className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
                            placeholder="Image URL *" 
                            aria-label="Image URL"
                            value={newItem.imageUrl || ''} 
                            onChange={e => setNewItem({...newItem, imageUrl: e.target.value})} 
                        />
                        {newItem.imageUrl && (
                            <div className="w-full h-32 rounded-lg overflow-hidden bg-gray-100 dark:bg-white/10">
                                <img src={newItem.imageUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} aria-hidden="true" />
                            </div>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                            <select 
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
                                value={newItem.category || 'venue'} 
                                onChange={e => setNewItem({...newItem, category: e.target.value})}
                            >
                                {categories.map(cat => (
                                    <option key={cat} value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
                                ))}
                            </select>
                            <input 
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/40 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
                                type="number" 
                                placeholder="Sort Order" 
                                value={newItem.sortOrder || 0} 
                                onChange={e => setNewItem({...newItem, sortOrder: parseInt(e.target.value) || 0})} 
                            />
                        </div>
                        <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25">
                            <span className="text-primary dark:text-white font-medium">Active (visible on public gallery)</span>
                            <Toggle
                                checked={newItem.isActive !== false}
                                onChange={(val) => setNewItem({...newItem, isActive: val})}
                                label="Toggle image active status"
                            />
                        </div>
                    </div>
                    <div className="flex gap-3 justify-end">
                        <button onClick={() => setIsEditing(false)} className="tactile-btn px-5 py-2.5 min-h-[44px] text-gray-600 dark:text-white/80 font-bold hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors">Cancel</button>
                        <button onClick={handleSave} disabled={isSaving} className="tactile-btn px-6 py-2.5 min-h-[44px] bg-primary text-white rounded-xl font-bold shadow-md hover:bg-primary/90 transition-colors disabled:opacity-50">
                            {isSaving ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </div>
            </ModalShell>

            <ModalShell isOpen={deleteConfirm !== null} onClose={() => setDeleteConfirm(null)} title="Delete Image?" size="sm">
                <div className="p-6">
                    <p className="text-gray-600 dark:text-gray-300 mb-6">This action cannot be undone.</p>
                    <div className="flex gap-3 justify-end">
                        <button onClick={() => setDeleteConfirm(null)} className="tactile-btn px-5 py-2.5 min-h-[44px] text-gray-600 dark:text-white/80 font-bold hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors">Cancel</button>
                        <button onClick={() => deleteConfirm !== null && handleDelete(deleteConfirm)} className="tactile-btn px-6 py-2.5 min-h-[44px] bg-red-600 text-white rounded-xl font-bold shadow-md hover:bg-red-700 transition-colors">Delete</button>
                    </div>
                </div>
            </ModalShell>

            {isLoading ? (
                <div className="flex items-center justify-center py-12">
                    <span className="material-symbols-outlined animate-spin text-3xl text-gray-500 dark:text-gray-400" aria-hidden="true">progress_activity</span>
                </div>
            ) : images.length === 0 ? (
                <div className="bg-white dark:bg-surface-dark rounded-xl p-8 text-center shadow-sm border border-gray-200 dark:border-white/20">
                    <span className="material-symbols-outlined text-5xl text-gray-500 dark:text-gray-500 mb-3 block" aria-hidden="true">photo_library</span>
                    <h3 className="text-lg font-bold text-primary dark:text-white mb-2">No Images</h3>
                    <p className="text-gray-600 dark:text-gray-300">Add images to the gallery to get started.</p>
                </div>
            ) : (
                <div ref={galleryRef} className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 animate-slide-up-stagger" style={{ '--stagger-index': 2 } as React.CSSProperties}>
                    {displayImages.map((image) => {
                        const isDragging = image.id === draggedItemId;
                        return (
                            <div 
                                key={image.id}
                                draggable="true"
                                onDragStart={(e) => handleDragStart(e, image.id)}
                                onDragOver={(e) => handleDragOver(e, image.id)}
                                onDrop={handleDrop}
                                onDragEnd={handleDragEnd}
                                className={`relative group bg-white dark:bg-surface-dark rounded-xl shadow-sm border overflow-hidden select-none cursor-grab active:cursor-grabbing ${
                                    image.isActive 
                                        ? 'border-gray-200 dark:border-white/20' 
                                        : 'border-orange-200 dark:border-orange-800/30 opacity-60'
                                } ${isDragging ? 'opacity-80 scale-[0.95] shadow-xl z-10 relative' : 'transition-all duration-fast ease-out'}`}
                            >
                                <div className="aspect-square bg-gray-100 dark:bg-white/5 overflow-hidden relative">
                                    <img 
                                        src={image.imageUrl} 
                                        alt={image.title || 'Gallery image'} 
                                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-normal pointer-events-none"
                                        draggable={false}
                                    />
                                    <div className="absolute top-2 left-2 w-11 h-11 flex items-center justify-center bg-black/50 hover:bg-black/70 text-white rounded-lg touch-manipulation transition-colors" aria-label="Drag to reorder">
                                        <span className="material-symbols-outlined text-xl" aria-hidden="true">drag_indicator</span>
                                    </div>
                                </div>
                                <div className="p-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <h4 className="font-bold text-gray-900 dark:text-white text-sm truncate">{image.title || 'Untitled'}</h4>
                                            <span className="inline-block text-[10px] font-bold uppercase tracking-wider bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/80 px-1.5 py-0.5 rounded mt-1">{image.category}</span>
                                        </div>
                                        <span className="text-[10px] text-gray-600 dark:text-gray-400 whitespace-nowrap">#{image.sortOrder}</span>
                                    </div>
                                    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-200 dark:border-white/25">
                                        <button 
                                            onClick={() => handleToggleActive(image)}
                                            disabled={togglingId === image.id}
                                            className={`tactile-btn flex-1 py-1.5 min-h-[44px] rounded-lg text-xs font-semibold transition-colors ${
                                                togglingId === image.id ? 'opacity-60 animate-pulse pointer-events-none' : ''
                                            } ${
                                                image.isActive 
                                                    ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30' 
                                                    : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/15'
                                            }`}
                                        >
                                            {togglingId === image.id ? 'Updating...' : image.isActive ? 'Active' : 'Inactive'}
                                        </button>
                                        <button 
                                            onClick={() => openEdit(image)}
                                            className="tactile-btn min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 hover:text-primary hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg transition-colors"
                                            aria-label="Edit image"
                                        >
                                            <span className="material-symbols-outlined text-lg" aria-hidden="true">edit</span>
                                        </button>
                                        <button
                                            onClick={() => setDeleteConfirm(image.id)}
                                            className="tactile-btn min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                                            aria-label="Delete image"
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

            <FloatingActionButton 
                onClick={openCreate}
                color="brand"
                label="Add new image"
                extended
                text="Add Image"
            />
        </div>
    );
};

export default GalleryAdmin;
