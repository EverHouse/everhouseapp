import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface ConfettiProps {
  isActive: boolean;
  duration?: number;
  particleCount?: number;
  colors?: string[];
  onComplete?: () => void;
}

const Confetti: React.FC<ConfettiProps> = ({
  isActive,
  duration = 3000,
  particleCount = 50,
  colors = ['#293515', '#CCB8E4', '#F2F2EC', '#FFD700', '#FF6B6B', '#4ECDC4'],
  onComplete
}) => {
  const [particles, setParticles] = useState<Array<{
    id: number;
    left: number;
    color: string;
    delay: number;
    xOffset: number;
    rotation: number;
    size: number;
    shape: 'square' | 'circle' | 'rectangle';
  }>>([]);

  useEffect(() => {
    if (isActive) {
      const newParticles = Array.from({ length: particleCount }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        color: colors[Math.floor(Math.random() * colors.length)],
        delay: Math.random() * 0.5,
        xOffset: (Math.random() - 0.5) * 200,
        rotation: Math.random() * 720,
        size: 6 + Math.random() * 8,
        shape: ['square', 'circle', 'rectangle'][Math.floor(Math.random() * 3)] as 'square' | 'circle' | 'rectangle'
      }));
      setParticles(newParticles);

      const timer = setTimeout(() => {
        setParticles([]);
        onComplete?.();
      }, duration);

      return () => clearTimeout(timer);
    }
  }, [isActive, particleCount, colors, duration, onComplete]);

  if (!isActive || particles.length === 0) return null;

  return createPortal(
    <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 99999 }}>
      {particles.map((particle) => (
        <div
          key={particle.id}
          className="confetti-piece"
          style={{
            left: `${particle.left}%`,
            backgroundColor: particle.color,
            width: particle.shape === 'rectangle' ? particle.size * 1.5 : particle.size,
            height: particle.shape === 'rectangle' ? particle.size * 0.6 : particle.size,
            borderRadius: particle.shape === 'circle' ? '50%' : '2px',
            animationDelay: `${particle.delay}s`,
            '--confetti-x': `${particle.xOffset}px`,
            '--confetti-rotate': `${particle.rotation}deg`
          } as React.CSSProperties}
        />
      ))}
    </div>,
    document.body
  );
};

export default Confetti;
