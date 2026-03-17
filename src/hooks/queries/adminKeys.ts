export const adminKeys = {
  bookings: {
    all: ['bookings'] as const,
    list: (date: string) => [...adminKeys.bookings.all, 'list', date] as const,
    requests: (filters?: { status?: string; date?: string }) => [...adminKeys.bookings.all, 'requests', filters] as const,
    resources: () => [...adminKeys.bookings.all, 'resources'] as const,
    availability: (date: string, resourceId?: number) => [...adminKeys.bookings.all, 'availability', date, resourceId] as const,
    closures: () => [...adminKeys.bookings.all, 'closures'] as const,
    detail: (id: number | string) => [...adminKeys.bookings.all, 'detail', id] as const,
  },

  simulator: {
    all: ['simulator'] as const,
    allRequests: () => [...adminKeys.simulator.all, 'allRequests'] as const,
    pendingBookings: () => [...adminKeys.simulator.all, 'pendingBookings'] as const,
    approvedBookings: (startDate: string, endDate: string) => [...adminKeys.simulator.all, 'approved', startDate, endDate] as const,
    bays: () => [...adminKeys.simulator.all, 'bays'] as const,
    memberContacts: (status?: string) => [...adminKeys.simulator.all, 'memberContacts', status] as const,
    feeEstimate: (id: number | string) => [...adminKeys.simulator.all, 'feeEstimate', id] as const,
    bayAvailability: (resourceId: number, date: string) => [...adminKeys.simulator.all, 'bayAvailability', resourceId, date] as const,
  },

  commandCenter: {
    all: ['command-center'] as const,
    pendingRequests: () => [...adminKeys.commandCenter.all, 'pending-requests'] as const,
    scheduling: () => [...adminKeys.commandCenter.all, 'scheduling'] as const,
    facility: () => [...adminKeys.commandCenter.all, 'facility'] as const,
    activity: (userEmail?: string) => [...adminKeys.commandCenter.all, 'activity', userEmail] as const,
    hubspotContacts: () => [...adminKeys.commandCenter.all, 'hubspot-contacts'] as const,
    announcements: () => [...adminKeys.commandCenter.all, 'announcements'] as const,
  },

  billing: {
    all: ['billing'] as const,
    info: (email?: string) => [...adminKeys.billing.all, 'info', email] as const,
    invoices: (email?: string) => [...adminKeys.billing.all, 'invoices', email] as const,
  },

  financials: {
    all: ['financials'] as const,
    dailySummary: () => [...adminKeys.financials.all, 'daily-summary'] as const,
    overduePayments: () => [...adminKeys.financials.all, 'overdue-payments'] as const,
    failedPayments: () => [...adminKeys.financials.all, 'failed-payments'] as const,
    pendingAuthorizations: () => [...adminKeys.financials.all, 'pending-authorizations'] as const,
    futureBookingsWithFees: () => [...adminKeys.financials.all, 'future-bookings-with-fees'] as const,
    refundablePayments: () => [...adminKeys.financials.all, 'refundable-payments'] as const,
    refundedPayments: () => [...adminKeys.financials.all, 'refunded-payments'] as const,
    subscriptions: (status?: string) => [...adminKeys.financials.all, 'subscriptions', { status }] as const,
    invoices: (params?: { status?: string; startDate?: string; endDate?: string }) =>
      [...adminKeys.financials.all, 'invoices', params] as const,
  },

  cafe: {
    all: ['cafe'] as const,
    menu: () => [...adminKeys.cafe.all, 'menu'] as const,
  },

  tours: {
    all: ['tours'] as const,
    today: () => [...adminKeys.tours.all, 'today'] as const,
    list: () => [...adminKeys.tours.all, 'list'] as const,
    detail: (id: number) => [...adminKeys.tours.all, 'detail', id] as const,
  },
};

export const bookingsKeys = adminKeys.bookings;
export const simulatorKeys = adminKeys.simulator;
export const commandCenterKeys = adminKeys.commandCenter;
export const billingKeys = adminKeys.billing;
export const financialsKeys = adminKeys.financials;
export const cafeKeys = adminKeys.cafe;
export const toursKeys = adminKeys.tours;
