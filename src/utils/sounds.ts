let audioContext: AudioContext | null = null;
let audioUnlocked = false;

const setupUnlockListeners = () => {
  if (typeof window === 'undefined') return;

  const unlock = () => {
    if (audioUnlocked) return;

    if (!audioContext) {
      try {
        audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)();
      } catch (e: unknown) {
        return;
      }
    }

    const removeListeners = () => {
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('touchend', unlock);
      document.removeEventListener('click', unlock);
    };

    if (audioContext.state === 'suspended') {
      audioContext.resume().then(() => {
        audioUnlocked = true;
        removeListeners();
      });
    } else {
      audioUnlocked = true;
      removeListeners();
    }
  };

  document.addEventListener('touchstart', unlock, { passive: true });
  document.addEventListener('touchend', unlock, { passive: true });
  document.addEventListener('click', unlock);
};

setupUnlockListeners();

const getAudioContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;

  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)();
    } catch (e: unknown) {
      return null;
    }
  }

  if (audioContext.state === 'suspended') {
    audioContext.resume();
    return null;
  }

  audioUnlocked = true;
  return audioContext;
};

const playTone = (
  frequency: number, 
  duration: number, 
  startTime: number, 
  gainValue: number = 0.15,
  type: OscillatorType = 'sine'
) => {
  const ctx = getAudioContext();
  if (!ctx) return;

  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();
  
  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);
  
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startTime);
  
  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(gainValue, startTime + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  
  oscillator.start(startTime);
  oscillator.stop(startTime + duration);
};

export const sounds = {
  bookingConfirmed: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    
    playTone(523.25, 0.15, now, 0.12, 'sine');
    playTone(659.25, 0.15, now + 0.1, 0.12, 'sine');
    playTone(783.99, 0.25, now + 0.2, 0.15, 'sine');
  },

  success: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    
    playTone(440, 0.1, now, 0.08, 'sine');
    playTone(554.37, 0.1, now + 0.08, 0.08, 'sine');
    playTone(659.25, 0.15, now + 0.16, 0.1, 'sine');
  },

  notification: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    
    playTone(880, 0.12, now, 0.1, 'sine');
    playTone(1108.73, 0.18, now + 0.08, 0.08, 'sine');
  },

  error: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    
    playTone(220, 0.15, now, 0.1, 'triangle');
    playTone(196, 0.2, now + 0.12, 0.12, 'triangle');
  },

  tap: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    playTone(600, 0.05, now, 0.04, 'sine');
  },

  newBookingRequest: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    playTone(587.33, 0.12, now, 0.1, 'sine');
    playTone(739.99, 0.12, now + 0.1, 0.1, 'sine');
    playTone(880, 0.18, now + 0.2, 0.12, 'sine');
  },

  bookingApproved: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    playTone(523.25, 0.1, now, 0.1, 'sine');
    playTone(659.25, 0.1, now + 0.08, 0.1, 'sine');
    playTone(783.99, 0.1, now + 0.16, 0.12, 'sine');
    playTone(1046.5, 0.2, now + 0.24, 0.14, 'sine');
  },

  bookingDeclined: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    playTone(311.13, 0.15, now, 0.1, 'triangle');
    playTone(261.63, 0.15, now + 0.12, 0.1, 'triangle');
    playTone(196, 0.25, now + 0.24, 0.12, 'triangle');
  },

  bookingCancelled: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    playTone(349.23, 0.12, now, 0.1, 'triangle');
    playTone(293.66, 0.18, now + 0.1, 0.1, 'triangle');
  },

  checkinSuccess: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    playTone(523.25, 0.12, now, 0.15, 'sine');
    playTone(659.25, 0.12, now + 0.1, 0.15, 'sine');
    playTone(783.99, 0.12, now + 0.2, 0.18, 'sine');
    playTone(1046.5, 0.3, now + 0.3, 0.2, 'sine');
  },

  checkinWarning: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    
    const now = ctx.currentTime;
    playTone(440, 0.25, now, 0.18, 'sawtooth');
    playTone(349.23, 0.25, now + 0.25, 0.18, 'sawtooth');
    playTone(293.66, 0.4, now + 0.5, 0.2, 'sawtooth');
  }
};

export const playSound = (type: keyof typeof sounds) => {
  try {
    sounds[type]?.();
  } catch (e: unknown) {
    // silently ignore
  }
};

export const initAudioContext = () => {
  getAudioContext();
};
