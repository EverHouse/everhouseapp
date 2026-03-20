import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, putWithCredentials, deleteWithCredentials } from './useFetch';
import type { CafeItem } from '../../types/data';
import { cafeKeys } from './adminKeys';

export { cafeKeys };

interface CafeMenuResponse {
  id: number | string;
  category: string;
  name: string;
  price: number | string;
  description?: string;
  desc?: string;
  icon?: string;
  imageUrl?: string;
  image_url?: string;
  image?: string;
  isActive?: boolean;
  is_active?: boolean;
  synced?: boolean;
  syncError?: string;
}

interface ImageUploadResponse {
  imageUrl: string;
  originalSize: number;
  optimizedSize: number;
}

interface SeedCafeResponse {
  message: string;
  error?: string;
}

const formatCafeItem = (item: CafeMenuResponse): CafeItem => ({
  id: item.id.toString(),
  category: item.category,
  name: item.name,
  price: parseFloat(item.price as string) || 0,
  desc: item.description || item.desc || '',
  icon: item.icon || '',
  image: item.imageUrl || item.image_url || item.image || '',
  isActive: item.isActive ?? item.is_active ?? true,
});

export function useCafeMenu(options?: { includeInactive?: boolean }) {
  const includeInactive = options?.includeInactive ?? false;
  return useQuery({
    queryKey: [...cafeKeys.menu(), { includeInactive }],
    queryFn: async () => {
      const url = includeInactive ? '/api/cafe-menu?include_inactive=true' : '/api/cafe-menu';
      const data = await fetchWithCredentials<CafeMenuResponse[]>(url);
      return Array.isArray(data) ? data.map(formatCafeItem) : [];
    },
    staleTime: 1000 * 60 * 5,
  });
}

export function useUploadCafeImage() {
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('image', file);
      const response = await fetch('/api/admin/upload-image', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Upload failed');
      }
      return response.json() as Promise<ImageUploadResponse>;
    },
  });
}

export function useSeedCafeMenu() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => 
      fetchWithCredentials<SeedCafeResponse>('/api/admin/seed-cafe', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cafeKeys.menu() });
    },
  });
}

export function useUpdateCafeItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (item: CafeItem) =>
      putWithCredentials<CafeMenuResponse>(`/api/cafe-menu/${item.id}`, {
        category: item.category,
        name: item.name,
        price: item.price,
        description: item.desc,
        icon: item.icon,
        image_url: item.image,
        is_active: item.isActive,
      }),
    onMutate: async (item) => {
      await queryClient.cancelQueries({ queryKey: cafeKeys.menu() });
      const allCaches = queryClient.getQueriesData<CafeItem[]>({ queryKey: cafeKeys.menu() });
      allCaches.forEach(([key]) => {
        queryClient.setQueryData<CafeItem[]>(key, (old) => {
          if (!old) return old;
          return old.map(i => i.id === item.id ? { ...item } : i);
        });
      });
      return { snapshots: allCaches };
    },
    onError: (_err, _item, context) => {
      context?.snapshots?.forEach(([key, data]) => {
        queryClient.setQueryData(key, data);
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: cafeKeys.menu() });
    },
  });
}

export function useDeleteCafeItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      deleteWithCredentials<{ success: boolean }>(`/api/cafe-menu/${id}`),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: cafeKeys.menu() });
      const allCaches = queryClient.getQueriesData<CafeItem[]>({ queryKey: cafeKeys.menu() });
      allCaches.forEach(([key]) => {
        queryClient.setQueryData<CafeItem[]>(key, (old) => {
          if (!old) return old;
          return old.filter(i => i.id !== id);
        });
      });
      return { snapshots: allCaches };
    },
    onError: (_err, _id, context) => {
      context?.snapshots?.forEach(([key, data]) => {
        queryClient.setQueryData(key, data);
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: cafeKeys.menu() });
    },
  });
}
