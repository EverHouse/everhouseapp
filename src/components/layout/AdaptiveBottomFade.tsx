import React, { useState, useEffect, useCallback, useRef } from 'react';

interface AdaptiveBottomFadeProps {
  defaultIsDark?: boolean;
}

export const AdaptiveBottomFade: React.FC<AdaptiveBottomFadeProps> = ({ defaultIsDark = false }) => {
  const [isDark, setIsDark] = useState(defaultIsDark);
  const rafRef = useRef<number | null>(null);
  const lastCheckRef = useRef<number>(0);

  const detectBottomColor = useCallback(() => {
    const now = Date.now();
    if (now - lastCheckRef.current < 100) return;
    lastCheckRef.current = now;

    const viewportHeight = window.innerHeight;
    const sampleY = viewportHeight - 100;
    const samplePoints = [
      { x: window.innerWidth * 0.25, y: sampleY },
      { x: window.innerWidth * 0.5, y: sampleY },
      { x: window.innerWidth * 0.75, y: sampleY },
    ];

    let darkCount = 0;
    let lightCount = 0;

    for (const point of samplePoints) {
      const elements = document.elementsFromPoint(point.x, point.y);
      
      for (const el of elements) {
        if (el.classList.contains('adaptive-bottom-fade')) continue;
        
        const computed = window.getComputedStyle(el);
        const bgColor = computed.backgroundColor;
        
        if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
          const rgb = bgColor.match(/\d+/g);
          if (rgb && rgb.length >= 3) {
            const r = parseInt(rgb[0]);
            const g = parseInt(rgb[1]);
            const b = parseInt(rgb[2]);
            const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            
            if (luminance < 0.5) {
              darkCount++;
            } else {
              lightCount++;
            }
            break;
          }
        }
      }
    }

    const newIsDark = darkCount > lightCount;
    setIsDark(newIsDark);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(detectBottomColor);
    };

    detectBottomColor();
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', detectBottomColor, { passive: true });

    const intervalId = setInterval(detectBottomColor, 500);

    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', detectBottomColor);
      clearInterval(intervalId);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [detectBottomColor]);

  const color = isDark ? '41, 53, 21' : '242, 242, 236';

  return (
    <div 
      className="adaptive-bottom-fade fixed inset-x-0 bottom-0 pointer-events-none lg:hidden"
      style={{ 
        zIndex: 8400,
        height: '80px',
        background: `linear-gradient(to top, rgba(${color}, 1) 0%, rgba(${color}, 0.85) 15%, rgba(${color}, 0.5) 35%, rgba(${color}, 0.15) 55%, rgba(${color}, 0.03) 75%, transparent 100%)`,
        transition: 'background 0.3s ease-out',
      }}
    />
  );
};

export default AdaptiveBottomFade;
