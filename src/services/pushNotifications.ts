import { fetchWithCredentials, postWithCredentials } from '../hooks/queries/useFetch';

const PUBLIC_VAPID_KEY_URL = '/api/push/vapid-public-key';
const SUBSCRIBE_URL = '/api/push/subscribe';
const UNSUBSCRIBE_URL = '/api/push/unsubscribe';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function isPushSupported(): Promise<boolean> {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function getNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) {
    return 'denied';
  }
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) {
    return 'denied';
  }
  return await Notification.requestPermission();
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    return null;
  }
  
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    return registration;
  } catch (error: unknown) {
    console.error('Service worker registration failed:', error);
    return null;
  }
}

export async function subscribeToPush(userEmail: string): Promise<boolean> {
  try {
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') {
      console.warn('[Push] Permission not granted:', permission);
      return false;
    }

    const registration = await registerServiceWorker();
    if (!registration) {
      console.warn('[Push] Service worker registration failed');
      return false;
    }

    await navigator.serviceWorker.ready;

    const { publicKey } = await fetchWithCredentials<{ publicKey: string }>(PUBLIC_VAPID_KEY_URL);
    
    if (!publicKey) {
      console.error('[Push] No VAPID public key available from server');
      return false;
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    await postWithCredentials(SUBSCRIBE_URL, {
      subscription: subscription.toJSON(),
      user_email: userEmail
    });

    return true;
  } catch (error: unknown) {
    console.error('[Push] Subscription failed:', error);
    return false;
  }
}

export async function unsubscribeFromPush(): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    
    if (subscription) {
      await postWithCredentials(UNSUBSCRIBE_URL, { endpoint: subscription.endpoint });
      
      await subscription.unsubscribe();
    }
    
    return true;
  } catch (error: unknown) {
    console.error('Push unsubscription failed:', error);
    return false;
  }
}

export async function isSubscribedToPush(): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator)) {
      return false;
    }
    
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return !!subscription;
  } catch (_error: unknown) {
    return false;
  }
}
