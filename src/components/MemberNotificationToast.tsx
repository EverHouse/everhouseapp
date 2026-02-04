import React, { useEffect, useCallback, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { useToast } from './Toast';
import { playSound } from '../utils/sounds';

interface NotificationEventData {
  type: string;
  title?: string;
  message?: string;
  data?: {
    eventType?: string;
    bookingId?: number;
    resourceName?: string;
    bookingDate?: string;
    startTime?: string;
  };
}

export function MemberNotificationToast() {
  const { actualUser } = useData();
  const { showToast } = useToast();
  const [isInitialized, setIsInitialized] = useState(false);

  const isMember = actualUser?.role === 'member';

  const handleNotificationEvent = useCallback((e: CustomEvent<NotificationEventData>) => {
    if (!isInitialized) return;
    
    const notification = e.detail;
    const eventType = notification.data?.eventType;
    
    if (eventType === 'booking_approved') {
      showToast(notification.message || 'Your booking has been approved!', 'success', 6000);
      playSound('success');
    }
    
    if (eventType === 'booking_declined') {
      showToast(notification.message || 'Your booking request was declined.', 'info', 6000);
      playSound('notification');
    }
    
    if (eventType === 'booking_cancelled') {
      showToast(notification.message || 'A booking has been cancelled.', 'info', 6000);
      playSound('notification');
    }
    
    if (eventType === 'booking_invite') {
      showToast(notification.message || 'You have been invited to a booking!', 'info', 6000);
      playSound('notification');
    }
    
    if (eventType === 'rsvp_confirmed') {
      showToast(notification.message || 'Your RSVP has been confirmed!', 'success', 5000);
    }
    
    if (eventType === 'wellness_enrolled') {
      showToast(notification.message || 'You are enrolled in a wellness class!', 'success', 5000);
    }
    
    if (eventType === 'payment_success') {
      showToast(notification.message || 'Payment processed successfully!', 'success', 5000);
      playSound('success');
    }
    
    if (eventType === 'payment_failed') {
      showToast(notification.message || 'Payment failed. Please update your payment method.', 'error', 8000);
      playSound('error');
    }
  }, [isInitialized, showToast]);

  useEffect(() => {
    if (!isMember) return;
    
    const timer = setTimeout(() => {
      setIsInitialized(true);
    }, 2000);
    
    return () => clearTimeout(timer);
  }, [isMember]);

  useEffect(() => {
    if (!isMember || !isInitialized) return;
    
    const handler = handleNotificationEvent as EventListener;
    window.addEventListener('member-notification', handler);
    
    return () => {
      window.removeEventListener('member-notification', handler);
    };
  }, [isMember, isInitialized, handleNotificationEvent]);

  return null;
}
