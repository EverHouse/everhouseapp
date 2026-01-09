import React from 'react';

interface WalkingGolferLoaderProps {
  isVisible?: boolean;
  onFadeComplete?: () => void;
}

const taglines = [
  "Your second home.",
  "Rooted in golf, built for community.",
  "Where design meets lifestyle.",
  "Elevate your everyday experience.",
  "Come in, settle down, stay awhile.",
  "A place to focus, meet, and connect.",
  "Step onto the green.",
  "Golf all year.",
  "Where every day feels like a day on the course.",
  "Practice with purpose.",
  "Tour-level data, right here at home.",
  "Inspire. Engage. Elevate.",
  "Effortless balance.",
  "Play through.",
  "Refined leisure.",
  "Always open.",
  "A welcoming community.",
  "More than a sport.",
  "Productivity meets leisure."
];

const WalkingGolferLoader: React.FC<WalkingGolferLoaderProps> = ({ isVisible = true, onFadeComplete }) => {
  const [isExiting, setIsExiting] = React.useState(false);
  const [shouldRender, setShouldRender] = React.useState(true);
  const [tagline] = React.useState(() => taglines[Math.floor(Math.random() * taglines.length)]);

  React.useEffect(() => {
    if (!isVisible && !isExiting) {
      setIsExiting(true);
      const timer = setTimeout(() => {
        setShouldRender(false);
        onFadeComplete?.();
      }, 750);
      return () => clearTimeout(timer);
    }
  }, [isVisible, isExiting, onFadeComplete]);

  if (!shouldRender) return null;

  return (
    <div 
      className={`loader-overlay ${isExiting ? 'loader-exit' : ''}`}
    >
      <div className={`loader-content ${isExiting ? 'content-exit' : ''}`}>
        <div className="walking-mascot">
          <img 
            src="/assets/logos/walking-mascot-white.gif" 
            alt="Loading..." 
            className="mascot-image"
          />
        </div>
        <p className="tagline-text">{tagline}</p>
      </div>

      <style>{`
        .loader-overlay {
          position: fixed;
          inset: 0;
          z-index: 99999;
          display: flex;
          justify-content: center;
          align-items: center;
          background-color: #293515;
          will-change: transform, height, clip-path;
        }

        .loader-exit {
          animation: minimizeToStatusBar 0.55s cubic-bezier(0.32, 0, 0.67, 0) forwards;
          pointer-events: none;
        }

        @keyframes minimizeToStatusBar {
          0% {
            transform: translateY(0);
            opacity: 1;
          }
          100% {
            transform: translateY(-100%);
            opacity: 1;
          }
        }

        .loader-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1.5rem;
          will-change: opacity, transform;
        }

        .content-exit {
          animation: contentFadeOut 0.3s cubic-bezier(0.4, 0, 1, 1) forwards;
        }

        @keyframes contentFadeOut {
          0% {
            opacity: 1;
            transform: translateY(0);
          }
          100% {
            opacity: 0;
            transform: translateY(-30px);
          }
        }

        .mascot-image {
          width: 120px;
          height: auto;
        }

        .tagline-text {
          font-family: 'Playfair Display', serif;
          color: white;
          font-size: 1rem;
          text-align: center;
          margin: 0;
          padding: 0 2rem;
          opacity: 0;
          animation: taglineFadeIn 0.6s ease-out 0.3s forwards;
        }

        @keyframes taglineFadeIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .walking-mascot {
          display: flex;
          justify-content: center;
          align-items: center;
        }
      `}</style>
    </div>
  );
};

export default WalkingGolferLoader;
