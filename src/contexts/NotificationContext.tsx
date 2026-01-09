import { createContext } from 'react';

export interface NotificationContextType {
  openNotifications: (tab?: 'updates' | 'announcements') => void;
}

export const NotificationContext = createContext<NotificationContextType>({ 
  openNotifications: () => {}
});
