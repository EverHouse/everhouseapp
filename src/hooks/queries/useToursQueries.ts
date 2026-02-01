import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials, patchWithCredentials } from './useFetch';

interface Tour {
  id: number;
  googleCalendarId: string | null;
  hubspotMeetingId: string | null;
  title: string;
  guestName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  tourDate: string;
  startTime: string;
  endTime: string | null;
  notes: string | null;
  status: string;
  checkedInAt: string | null;
  checkedInBy: string | null;
}

interface ToursSyncResponse {
  synced: number;
  created: number;
  updated: number;
  error?: string;
}

interface ToursData {
  todayTours: Tour[];
  upcomingTours: Tour[];
  pastTours: Tour[];
}

export const toursKeys = {
  all: ['tours'] as const,
  today: () => [...toursKeys.all, 'today'] as const,
  list: () => [...toursKeys.all, 'list'] as const,
  detail: (id: number) => [...toursKeys.all, 'detail', id] as const,
};

export function useTodayTours() {
  return useQuery({
    queryKey: toursKeys.today(),
    queryFn: () => fetchWithCredentials<Tour[]>('/api/tours/today'),
  });
}

export function useAllTours() {
  return useQuery({
    queryKey: toursKeys.list(),
    queryFn: async () => {
      const allTours = await fetchWithCredentials<Tour[]>('/api/tours');
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

      const upcoming: Tour[] = [];
      const past: Tour[] = [];

      allTours.forEach((tour) => {
        if (tour.tourDate === todayStr) return;
        if (tour.tourDate > todayStr) {
          if (tour.status !== 'cancelled') {
            upcoming.push(tour);
          }
        } else {
          past.push(tour);
        }
      });

      upcoming.sort((a, b) => a.tourDate.localeCompare(b.tourDate));
      past.sort((a, b) => b.tourDate.localeCompare(a.tourDate));

      return { upcoming, past };
    },
  });
}

export function useTourData() {
  const todayQuery = useTodayTours();
  const allToursQuery = useAllTours();

  return {
    data: {
      todayTours: todayQuery.data || [],
      upcomingTours: allToursQuery.data?.upcoming || [],
      pastTours: allToursQuery.data?.past || [],
    },
    isLoading: todayQuery.isLoading || allToursQuery.isLoading,
    isError: todayQuery.isError || allToursQuery.isError,
    error: todayQuery.error || allToursQuery.error,
  };
}

export function useSyncTours() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postWithCredentials<ToursSyncResponse>('/api/tours/sync', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: toursKeys.all });
    },
  });
}

export function useCheckInTour() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tourId }: { tourId: number }) =>
      postWithCredentials<{ success: boolean }>(`/api/tours/${tourId}/checkin`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: toursKeys.all });
    },
  });
}

export function useUpdateTourStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tourId, status }: { tourId: number; status: string }) =>
      patchWithCredentials<{ success: boolean }>(`/api/tours/${tourId}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: toursKeys.all });
    },
  });
}
