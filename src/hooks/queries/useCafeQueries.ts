import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials, putWithCredentials, deleteWithCredentials } from './useFetch';
import type { CafeItem } from '../../types/data';

export const cafeKeys = {
  all: ['cafe'] as const,
  menu: () => [...cafeKeys.all, 'menu'] as const,
};

interface CafeMenuResponse {
  id: number | string;
  category: string;
  name: string;
  price: number | string;
  description?: string;
  desc?: string;
  icon?: string;
  image_url?: string;
  image?: string;
}

interface ImageUploadResponse {
  url: string;
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
  image: item.image_url || item.image || ''
});

export function useCafeMenu() {
  return useQuery({
    queryKey: cafeKeys.menu(),
    queryFn: async () => {
      const data = await fetchWithCredentials<CafeMenuResponse[]>('/api/cafe-menu');
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

export function useAddCafeItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (item: Partial<CafeItem>) =>
      postWithCredentials<CafeMenuResponse>('/api/cafe-menu', {
        category: item.category,
        name: item.name,
        price: item.price,
        description: item.desc,
        icon: item.icon,
        image_url: item.image
      }),
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
        image_url: item.image
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cafeKeys.menu() });
    },
  });
}

export function useDeleteCafeItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      deleteWithCredentials<{ success: boolean }>(`/api/cafe-menu/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cafeKeys.menu() });
    },
  });
}
