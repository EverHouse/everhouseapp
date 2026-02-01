import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2,
      gcTime: 1000 * 60 * 10,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 2,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
    },
    mutations: {
      retry: 1,
    },
  },
});

export const invalidateBookings = () => {
  queryClient.invalidateQueries({ queryKey: ['bookings'] });
};

export const invalidateMembers = () => {
  queryClient.invalidateQueries({ queryKey: ['members'] });
};

export const invalidateEvents = () => {
  queryClient.invalidateQueries({ queryKey: ['events'] });
};

export const invalidateFinancials = () => {
  queryClient.invalidateQueries({ queryKey: ['financials'] });
};

export const invalidateSettings = () => {
  queryClient.invalidateQueries({ queryKey: ['settings'] });
};

export const invalidateAll = () => {
  queryClient.invalidateQueries();
};
