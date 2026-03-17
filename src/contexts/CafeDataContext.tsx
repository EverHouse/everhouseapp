import React, { createContext, useState, useContext, ReactNode, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuthData } from './AuthDataContext';
import type { CafeItem } from '../types/data';
import { INITIAL_CAFE } from '../data/defaults';
import { fetchWithCredentials, postWithCredentials, putWithCredentials, deleteWithCredentials } from '../hooks/queries/useFetch';

interface CafeMenuItem {
  id: number | string;
  category: string;
  name: string;
  price: string | number;
  description?: string;
  icon?: string;
  image_url?: string;
}

interface CafeDataContextType {
  cafeMenu: CafeItem[];
  cafeMenuLoaded: boolean;
  addCafeItem: (item: CafeItem) => Promise<void>;
  updateCafeItem: (item: CafeItem) => Promise<void>;
  deleteCafeItem: (id: string) => Promise<void>;
  refreshCafeMenu: () => Promise<void>;
}

const CafeDataContext = createContext<CafeDataContextType | undefined>(undefined);

export const CafeDataProvider: React.FC<{children: ReactNode}> = ({ children }) => {
  const { sessionChecked, actualUser } = useAuthData();
  const actualUserRef = useRef(actualUser);
  useEffect(() => { actualUserRef.current = actualUser; }, [actualUser]);

  const [cafeMenu, setCafeMenu] = useState<CafeItem[]>(INITIAL_CAFE);
  const [cafeMenuLoaded, setCafeMenuLoaded] = useState(false);
  const cafeMenuFetchedRef = useRef(false);

  const formatCafeData = (data: CafeMenuItem[]) => data.map((item: CafeMenuItem) => ({
    id: item.id.toString(),
    category: item.category,
    name: item.name,
    price: parseFloat(String(item.price)) || 0,
    desc: item.description || '',
    icon: item.icon || '',
    image: item.image_url || ''
  }));

  useEffect(() => {
    if (!sessionChecked || cafeMenuFetchedRef.current) return;
    cafeMenuFetchedRef.current = true;
    const fetchCafeMenu = async () => {
      try {
        const data = await fetchWithCredentials<CafeMenuItem[]>('/api/cafe-menu');
        if (Array.isArray(data) && data.length > 0) {
          setCafeMenu(formatCafeData(data));
        }
      } catch (err: unknown) {
        if (actualUserRef.current) {
          console.error('Failed to fetch cafe menu:', err);
        }
      } finally {
        setCafeMenuLoaded(true);
      }
    };
    fetchCafeMenu();
  }, [sessionChecked]);

  const refreshCafeMenu = useCallback(async () => {
    try {
      const data = await fetchWithCredentials<CafeMenuItem[]>('/api/cafe-menu');
      if (Array.isArray(data)) {
        setCafeMenu(formatCafeData(data));
      }
    } catch (e) { console.warn('[CafeData] Failed to refresh cafe menu:', e); }
  }, []);

  useEffect(() => {
    const handleCafeMenuUpdate = () => { refreshCafeMenu(); };
    window.addEventListener('cafe-menu-update', handleCafeMenuUpdate);
    return () => { window.removeEventListener('cafe-menu-update', handleCafeMenuUpdate); };
  }, [refreshCafeMenu]);

  useEffect(() => {
    const handleAppRefresh = () => { refreshCafeMenu(); };
    window.addEventListener('app-refresh', handleAppRefresh);
    return () => window.removeEventListener('app-refresh', handleAppRefresh);
  }, [refreshCafeMenu]);

  const addCafeItem = useCallback(async (item: CafeItem) => {
    const tempId = `temp-${Date.now()}`;
    const optimisticItem = { ...item, id: tempId };
    setCafeMenu(prev => [...prev, optimisticItem]);
    try {
      const newItem = await postWithCredentials<CafeMenuItem>('/api/cafe-menu', {
        category: item.category,
        name: item.name,
        price: item.price,
        description: item.desc,
        icon: item.icon,
        image_url: item.image
      });
      setCafeMenu(prev => prev.map(i => i.id === tempId ? {
        id: newItem.id.toString(),
        category: newItem.category,
        name: newItem.name,
        price: parseFloat(String(newItem.price)) || 0,
        desc: newItem.description || '',
        icon: newItem.icon || '',
        image: newItem.image_url || ''
      } : i));
    } catch (err: unknown) {
      console.error('Failed to add cafe item:', err);
      setCafeMenu(prev => prev.filter(i => i.id !== tempId));
    }
  }, []);

  const updateCafeItem = useCallback(async (item: CafeItem) => {
    setCafeMenu(prev => prev.map(i => i.id === item.id ? item : i));
    try {
      await putWithCredentials(`/api/cafe-menu/${item.id}`, {
        category: item.category,
        name: item.name,
        price: item.price,
        description: item.desc,
        icon: item.icon,
        image_url: item.image
      });
    } catch (err: unknown) {
      console.error('Failed to update cafe item:', err);
      refreshCafeMenu();
    }
  }, [refreshCafeMenu]);

  const deleteCafeItem = useCallback(async (id: string) => {
    setCafeMenu(prev => prev.filter(i => i.id !== id));
    try {
      await deleteWithCredentials(`/api/cafe-menu/${id}`);
    } catch (err: unknown) {
      console.error('Failed to delete cafe item:', err);
      refreshCafeMenu();
    }
  }, [refreshCafeMenu]);

  const contextValue = useMemo(() => ({
    cafeMenu, cafeMenuLoaded, addCafeItem, updateCafeItem, deleteCafeItem, refreshCafeMenu
  }), [cafeMenu, cafeMenuLoaded, addCafeItem, updateCafeItem, deleteCafeItem, refreshCafeMenu]);

  return (
    <CafeDataContext.Provider value={contextValue}>
      {children}
    </CafeDataContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useCafeData = () => {
  const context = useContext(CafeDataContext);
  if (!context) {
    throw new Error('useCafeData must be used within a CafeDataProvider');
  }
  return context;
};
