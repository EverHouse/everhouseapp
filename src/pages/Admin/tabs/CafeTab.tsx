import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useData, CafeItem } from '../../../contexts/DataContext';
import { usePageReady } from '../../../contexts/PageReadyContext';
import ModalShell from '../../../components/ModalShell';
import FloatingActionButton from '../../../components/FloatingActionButton';

const CafeTab: React.FC = () => {
    const { setPageReady } = usePageReady();
    const { cafeMenu, addCafeItem, updateCafeItem, deleteCafeItem, refreshCafeMenu } = useData();
    const categories = useMemo(() => ['All', ...Array.from(new Set(cafeMenu.map(item => item.category)))], [cafeMenu]);
    const [activeCategory, setActiveCategory] = useState('All');
    const [isEditing, setIsEditing] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [newItem, setNewItem] = useState<Partial<CafeItem>>({ category: 'Coffee & Drinks' });
    const [isSeeding, setIsSeeding] = useState(false);
    const [seedMessage, setSeedMessage] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadResult, setUploadResult] = useState<{ originalSize: number; optimizedSize: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        window.scrollTo(0, 0);
        setPageReady(true);
    }, [setPageReady]);

    const filteredMenu = activeCategory === 'All' ? cafeMenu : cafeMenu.filter(item => item.category === activeCategory);

    const openEdit = (item: CafeItem) => {
        setNewItem(item);
        setEditId(item.id);
        setIsEditing(true);
    };

    const openCreate = () => {
        setNewItem({ category: 'Coffee & Drinks' });
        setEditId(null);
        setIsEditing(true);
        setUploadResult(null);
    };

    const handleImageUpload = async (file: File) => {
        setIsUploading(true);
        setUploadResult(null);
        try {
            const formData = new FormData();
            formData.append('image', file);
            const res = await fetch('/api/admin/upload-image', {
                method: 'POST',
                credentials: 'include',
                body: formData
            });
            if (!res.ok) throw new Error('Upload failed');
            const data = await res.json();
            setNewItem(prev => ({ ...prev, image: data.url }));
            setUploadResult({ originalSize: data.originalSize, optimizedSize: data.optimizedSize });
        } catch (err) {
            console.error('Upload error:', err);
        } finally {
            setIsUploading(false);
        }
    };

    const handleSeedMenu = async () => {
        if (isSeeding) return;
        setIsSeeding(true);
        setSeedMessage(null);
        try {
            const res = await fetch('/api/admin/seed-cafe', { method: 'POST', credentials: 'include' });
            const data = await res.json();
            if (res.ok) {
                setSeedMessage(`${data.message}`);
                if (refreshCafeMenu) refreshCafeMenu();
            } else {
                setSeedMessage(data.error || 'Failed to seed menu');
            }
        } catch (err) {
            setSeedMessage('Network error');
        } finally {
            setIsSeeding(false);
        }
    };

    const handleSave = () => {
        if (!newItem.name || newItem.price === undefined || newItem.price === null) return;
        
        const item: CafeItem = {
            id: editId || Math.random().toString(36).substr(2, 9),
            name: newItem.name,
            price: Number(newItem.price),
            desc: newItem.desc || '',
            category: newItem.category || 'Coffee & Drinks',
            icon: newItem.icon || 'coffee',
            image: newItem.image || ''
        };

        if (editId) {
            updateCafeItem(item);
        } else {
            addCafeItem(item);
        }
        setIsEditing(false);
    };

    return (
        <div className="animate-pop-in">
            <div className="flex justify-between items-center mb-4 animate-pop-in" style={{animationDelay: '0.05s'}}>
                <h2 className="text-xl font-bold text-primary dark:text-white">Menu Items</h2>
                {cafeMenu.length === 0 && (
                    <button 
                        onClick={handleSeedMenu} 
                        disabled={isSeeding}
                        className="bg-accent text-primary px-3 py-2 rounded-lg font-bold flex items-center gap-2 shadow-md text-xs whitespace-nowrap disabled:opacity-50"
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-sm">{isSeeding ? 'sync' : 'database'}</span> 
                        {isSeeding ? 'Seeding...' : 'Seed Menu'}
                    </button>
                )}
            </div>
            {seedMessage && (
                <div className="mb-4 p-3 bg-accent/20 text-primary dark:text-white rounded-lg text-sm">
                    {seedMessage}
                </div>
            )}
            <div className="flex gap-2 overflow-x-auto pb-4 scrollbar-hide -mx-1 px-1 mb-4 animate-pop-in scroll-fade-right" style={{animationDelay: '0.1s'}}>
                {categories.map(cat => (
                    <button
                        key={cat}
                        onClick={() => setActiveCategory(cat)}
                        className={`flex-shrink-0 px-4 py-2 rounded-full text-xs font-semibold transition-all ${activeCategory === cat ? 'bg-primary dark:bg-lavender text-white shadow-md' : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/15'}`}
                    >
                        {cat}
                    </button>
                ))}
            </div>

            <ModalShell isOpen={isEditing} onClose={() => setIsEditing(false)} title={editId ? 'Edit Item' : 'Add Item'} showCloseButton={false}>
                <div className="p-6 space-y-4">
                    <input className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" placeholder="Item Name" value={newItem.name || ''} onChange={e => setNewItem({...newItem, name: e.target.value})} />
                    <div className="grid grid-cols-2 gap-3">
                        <input className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" type="number" placeholder="Price" value={newItem.price || ''} onChange={e => setNewItem({...newItem, price: Number(e.target.value)})} />
                        <select className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" value={newItem.category} onChange={e => setNewItem({...newItem, category: e.target.value})}>
                            <option>Coffee & Drinks</option>
                            <option>Breakfast</option>
                            <option>Lunch</option>
                            <option>Sides</option>
                            <option>Kids</option>
                            <option>Dessert</option>
                            <option>Shareables</option>
                        </select>
                    </div>
                    <div className="space-y-2">
                        <label className="block text-sm font-medium text-gray-700 dark:text-white/70">Image (Optional)</label>
                        <div className="flex gap-2">
                            <input
                                type="file"
                                ref={fileInputRef}
                                accept="image/*"
                                className="hidden"
                                onChange={e => {
                                    const file = e.target.files?.[0];
                                    if (file) handleImageUpload(file);
                                }}
                            />
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isUploading}
                                className="flex items-center gap-2 px-4 py-2.5 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-white rounded-xl font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors disabled:opacity-50"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-lg">{isUploading ? 'sync' : 'upload'}</span>
                                {isUploading ? 'Uploading...' : 'Upload'}
                            </button>
                            <input
                                className="flex-1 border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all text-sm"
                                placeholder="Or paste image URL"
                                value={newItem.image || ''}
                                onChange={e => setNewItem({...newItem, image: e.target.value})}
                            />
                        </div>
                        {uploadResult && (
                            <p className="text-xs text-green-600 dark:text-green-400">
                                Optimized: {(uploadResult.originalSize / 1024).toFixed(0)}KB → {(uploadResult.optimizedSize / 1024).toFixed(0)}KB
                            </p>
                        )}
                        {newItem.image && (
                            <div className="mt-2 relative w-20 h-20 rounded-lg overflow-hidden bg-gray-100 dark:bg-white/5">
                                <img src={newItem.image} alt="Preview" className="w-full h-full object-cover" />
                                <button
                                    type="button"
                                    onClick={() => { setNewItem({...newItem, image: ''}); setUploadResult(null); }}
                                    className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center text-xs"
                                >
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm">close</span>
                                </button>
                            </div>
                        )}
                    </div>
                    <textarea className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all resize-none" placeholder="Description" rows={3} value={newItem.desc || ''} onChange={e => setNewItem({...newItem, desc: e.target.value})} />
                    <div className="flex gap-3 justify-end pt-2">
                        <button onClick={() => setIsEditing(false)} className="px-5 py-2.5 text-gray-500 dark:text-white/80 font-bold hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors">Cancel</button>
                        <button onClick={handleSave} className="px-6 py-2.5 bg-primary text-white rounded-xl font-bold shadow-md hover:bg-primary/90 transition-colors">Save</button>
                    </div>
                </div>
            </ModalShell>

            <div className="space-y-3 animate-pop-in" style={{animationDelay: '0.15s'}}>
                {filteredMenu.map((item, index) => (
                    <div key={item.id} onClick={() => openEdit(item)} className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 flex items-center gap-4 cursor-pointer hover:border-primary/30 transition-all animate-pop-in" style={{animationDelay: `${0.2 + index * 0.03}s`}}>
                        <div className="w-16 h-16 rounded-lg bg-gray-100 dark:bg-white/5 flex-shrink-0 overflow-hidden">
                             {item.image ? <img src={item.image} className="w-full h-full object-cover" alt="" /> : <div className="w-full h-full flex items-center justify-center"><span aria-hidden="true" className="material-symbols-outlined text-gray-600">restaurant</span></div>}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <h4 className="font-bold text-gray-900 dark:text-white truncate flex-1">{item.name}</h4>
                                <span className="font-bold text-primary dark:text-white whitespace-nowrap">${item.price}</span>
                                <button onClick={(e) => { e.stopPropagation(); deleteCafeItem(item.id); }} className="w-8 h-8 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors flex-shrink-0">
                                    <span aria-hidden="true" className="material-symbols-outlined">delete</span>
                                </button>
                            </div>
                            <span className="inline-block text-[10px] font-bold uppercase tracking-wider bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/80 px-1.5 py-0.5 rounded mt-1 mb-1">{item.category}</span>
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{item.desc}</p>
                        </div>
                    </div>
                ))}
            </div>
            <FloatingActionButton onClick={openCreate} color="brand" label="Add menu item" />
        </div>
    );
};

export default CafeTab;
