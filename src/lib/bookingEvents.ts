type BookingEventCallback = () => void;

class BookingEventEmitter {
  private listeners: Set<BookingEventCallback> = new Set();

  subscribe(callback: BookingEventCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emit(): void {
    this.listeners.forEach(callback => {
      try {
        callback();
      } catch (error) {
        console.error('[BookingEvents] Error in listener:', error);
      }
    });
  }
}

export const bookingEvents = new BookingEventEmitter();
