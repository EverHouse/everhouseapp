import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Footer } from '../../components/Footer';
import { usePageReady } from '../../contexts/PageReadyContext';

interface GalleryImage {
  id: number;
  img: string;
  category: string;
  title?: string;
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

const MascotLoader: React.FC<{ isVisible: boolean; onFadeComplete?: () => void }> = ({ isVisible, onFadeComplete }) => {
  const [isExiting, setIsExiting] = useState(false);
  const [shouldRender, setShouldRender] = useState(true);
  const [tagline] = useState(() => taglines[Math.floor(Math.random() * taglines.length)]);

  useEffect(() => {
    if (!isVisible && !isExiting) {
      setIsExiting(true);
      const timer = setTimeout(() => {
        setShouldRender(false);
        onFadeComplete?.();
      }, 700);
      return () => clearTimeout(timer);
    }
  }, [isVisible, isExiting, onFadeComplete]);

  if (!shouldRender) return null;

  return createPortal(
    <div className={`gallery-loader-overlay ${isExiting ? 'gallery-loader-exit' : ''}`}>
      <div className={`gallery-loader-content ${isExiting ? 'gallery-content-exit' : ''}`}>
        <div className="gallery-mascot">
          <img 
            src="/assets/logos/walking-mascot-white.gif" 
            alt="Loading gallery..." 
            style={{ width: '120px', height: 'auto' }}
          />
        </div>
        <p className="gallery-tagline">{tagline}</p>
      </div>

      <style>{`
        .gallery-loader-overlay {
          position: fixed;
          inset: 0;
          z-index: 99999;
          display: flex;
          justify-content: center;
          align-items: center;
          background-color: #293515;
          will-change: clip-path;
        }

        .gallery-loader-exit {
          animation: galleryMinimizeToStatusBar 0.55s cubic-bezier(0.32, 0, 0.67, 0) forwards;
          pointer-events: none;
        }

        @keyframes galleryMinimizeToStatusBar {
          0% {
            transform: translateY(0);
            opacity: 1;
          }
          100% {
            transform: translateY(-100%);
            opacity: 1;
          }
        }

        .gallery-loader-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1.5rem;
          will-change: opacity, transform;
        }

        .gallery-content-exit {
          animation: galleryContentFadeOut 0.3s cubic-bezier(0.4, 0, 1, 1) forwards;
        }

        @keyframes galleryContentFadeOut {
          0% {
            opacity: 1;
            transform: translateY(0);
          }
          100% {
            opacity: 0;
            transform: translateY(-30px);
          }
        }

        .gallery-mascot {
          display: flex;
          justify-content: center;
          align-items: center;
        }

        .gallery-tagline {
          font-family: 'Playfair Display', serif;
          color: white;
          font-size: 1rem;
          text-align: center;
          margin: 0;
          padding: 0 2rem;
          opacity: 0;
          animation: galleryTaglineFadeIn 0.6s ease-out 0.3s forwards;
        }

        @keyframes galleryTaglineFadeIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>,
    document.body
  );
};

const Gallery: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [showLoader, setShowLoader] = useState(true);
  const [filter, setFilter] = useState('All');
  const [viewerState, setViewerState] = useState<{images: string[], index: number} | null>(null);

  useEffect(() => {
    if (!showLoader) {
      setPageReady(true);
    }
  }, [showLoader, setPageReady]);

  useEffect(() => {
    const fetchGallery = async () => {
      try {
        const res = await fetch('/api/gallery');
        if (res.ok) {
          const data = await res.json();
          setImages(data);
        }
      } catch (err) {
        console.error('Failed to fetch gallery:', err);
      } finally {
        setIsLoadingData(false);
      }
    };
    fetchGallery();
  }, []);

  useEffect(() => {
    if (isLoadingData) return;

    let hasCompleted = false;

    const markComplete = () => {
      if (!hasCompleted) {
        hasCompleted = true;
        setImagesLoaded(true);
        setShowLoader(false);
      }
    };

    if (images.length === 0) {
      markComplete();
      return;
    }

    let loadedCount = 0;
    const totalImages = images.length;

    const timeoutId = setTimeout(() => {
      markComplete();
    }, 8000);

    images.forEach((imageData) => {
      const img = new Image();
      img.onload = () => {
        loadedCount++;
        if (loadedCount >= totalImages) {
          markComplete();
        }
      };
      img.onerror = () => {
        loadedCount++;
        if (loadedCount >= totalImages) {
          markComplete();
        }
      };
      img.src = imageData.img;
    });

    return () => {
      clearTimeout(timeoutId);
    };
  }, [isLoadingData, images]);

  const categories = useMemo(() => {
    const cats = new Set(images.map(img => img.category));
    return ['All', ...Array.from(cats)];
  }, [images]);

  const filteredItems = filter === 'All' ? images : images.filter(item => item.category === filter);

  const openViewer = useCallback((index: number) => {
    const imgs = filteredItems.map(item => item.img);
    setViewerState({ images: imgs, index });
  }, [filteredItems]);

  const handleClose = useCallback(() => {
    setViewerState(null);
  }, []);

  const handlePrev = useCallback(() => {
    setViewerState(prev => {
      if (prev && prev.index > 0) {
        return { ...prev, index: prev.index - 1 };
      }
      return prev;
    });
  }, []);

  const handleNext = useCallback(() => {
    setViewerState(prev => {
      if (prev && prev.index < prev.images.length - 1) {
        return { ...prev, index: prev.index + 1 };
      }
      return prev;
    });
  }, []);

  const isModalOpen = viewerState !== null;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isModalOpen) return;
      if (e.key === 'Escape') handleClose();
      if (e.key === 'ArrowLeft') handlePrev();
      if (e.key === 'ArrowRight') handleNext();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen, handleClose, handlePrev, handleNext]);

  useEffect(() => {
    if (isModalOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isModalOpen]);

  return (
    <>
      <MascotLoader isVisible={showLoader} />
      
      <div 
        className="flex flex-col min-h-screen bg-[#F2F2EC] overflow-x-hidden"
        style={{ marginTop: 'calc(-1 * var(--header-offset))', paddingTop: 'var(--header-offset)' }}
      >
        <div className="px-5 pt-4 md:pt-2 pb-6 animate-pop-in">
          <h1 className="text-3xl font-medium tracking-tight text-primary leading-tight">Gallery</h1>
          <p className="text-primary/70 text-base mt-2 font-light">Explore the exclusive spaces of Ever House.</p>
        </div>

        <div className="pl-5 pr-5 py-2 w-full overflow-x-auto scrollbar-hide mb-6 animate-pop-in" style={{animationDelay: '0.05s'}}>
          <div className="flex gap-3 min-w-max pr-5">
            {categories.map(cat => (
              <FilterButton 
                key={cat} 
                label={cat.charAt(0).toUpperCase() + cat.slice(1)} 
                active={filter === cat} 
                onClick={() => setFilter(cat)} 
                disabled={isModalOpen} 
              />
            ))}
          </div>
        </div>

        <div className="px-5 flex-1 animate-pop-in" style={{animationDelay: '0.1s'}}>
          {filteredItems.length === 0 ? (
            <div className="text-center py-20">
              <span className="material-symbols-outlined text-5xl text-primary/30 mb-4">photo_library</span>
              <p className="text-primary/60">No images found{filter !== 'All' ? ` in ${filter}` : ''}.</p>
              <p className="text-primary/40 text-sm mt-2">Check back soon for new photos.</p>
            </div>
          ) : (
            <>
              <div className="columns-2 gap-4 space-y-4 animate-in fade-in duration-500">
                {filteredItems.map((item, index) => (
                  <GalleryItem key={item.id || item.img} img={item.img} onClick={() => openViewer(index)} index={index} />
                ))}
              </div>
              <div className="mt-12 flex justify-center pb-8">
                <p className="text-xs text-primary/40 font-medium">
                  {filteredItems.length} {filteredItems.length === 1 ? 'image' : 'images'}
                </p>
              </div>
            </>
          )}
        </div>

        <Footer />

        {viewerState && (
          <ImageViewer
            images={viewerState.images}
            currentIndex={viewerState.index}
            onClose={handleClose}
            onPrev={handlePrev}
            onNext={handleNext}
          />
        )}
      </div>
    </>
  );
};

const FilterButton: React.FC<{label: string; active?: boolean; onClick?: () => void; disabled?: boolean}> = ({ label, active, onClick, disabled }) => (
  <button 
    onClick={onClick} 
    disabled={disabled}
    className={`${
        active 
        ? 'bg-primary text-white shadow-md' 
        : 'bg-white/40 text-primary border border-white/50 hover:bg-white/60 backdrop-blur-md'
    } px-5 py-2.5 rounded-xl text-sm font-semibold transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed`}
  >
    {label}
  </button>
);

const GalleryItem: React.FC<{img: string; onClick: () => void; index: number}> = ({ img, onClick, index }) => {
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState(false);

  const skeletonHeights = ['aspect-[4/3]', 'aspect-[3/4]', 'aspect-square', 'aspect-[4/5]'];
  const skeletonHeight = skeletonHeights[index % skeletonHeights.length];
  
  return (
    <div 
      className="break-inside-avoid relative group rounded-2xl overflow-hidden shadow-sm cursor-pointer mb-4 border border-white/20 active:scale-[0.98] transition-transform"
      onClick={onClick}
    >
      {!loaded && !error && (
        <div className={`w-full ${skeletonHeight} bg-gradient-to-br from-gray-200 via-gray-100 to-gray-200 rounded-2xl overflow-hidden`}>
          <div className="w-full h-full animate-shimmer bg-gradient-to-r from-transparent via-white/40 to-transparent" 
               style={{ backgroundSize: '200% 100%', animation: 'shimmer 1.5s infinite' }} />
        </div>
      )}
      <img 
        src={img} 
        className={`w-full h-auto object-cover transform group-hover:scale-105 transition-all duration-700 ease-out ${loaded ? 'opacity-100' : 'opacity-0 absolute top-0 left-0'}`}
        alt="Gallery"
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
      {error && (
        <div className={`w-full ${skeletonHeight} bg-gray-200 flex items-center justify-center rounded-2xl`}>
          <span className="material-symbols-outlined text-gray-400 text-3xl">broken_image</span>
        </div>
      )}
      {loaded && <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300"></div>}
    </div>
  );
};

interface ImageViewerProps {
  images: string[];
  currentIndex: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

const ImageViewer: React.FC<ImageViewerProps> = ({ images, currentIndex, onClose, onPrev, onNext }) => {
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);

  const minSwipeDistance = 50;

  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchEnd(null);
    setTouchStart(e.targetTouches[0].clientX);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    setTouchEnd(e.targetTouches[0].clientX);
  };

  const handleTouchEnd = () => {
    if (!touchStart || !touchEnd) return;
    const distance = touchStart - touchEnd;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;
    if (isLeftSwipe) onNext();
    if (isRightSwipe) onPrev();
  };

  return createPortal(
    <div 
      className="fixed inset-0 bg-black/80 backdrop-blur-xl flex items-center justify-center"
      style={{ zIndex: 99999 }}
      onClick={onClose}
    >
      <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}>
        <div className="px-4 py-2 bg-white/10 backdrop-blur-sm rounded-full">
          <span className="text-white/80 text-sm font-medium">
            {currentIndex + 1} / {images.length}
          </span>
        </div>
        <button
          className="w-12 h-12 flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors backdrop-blur-sm"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
          <span className="material-symbols-outlined text-white text-2xl">close</span>
        </button>
      </div>

      {currentIndex > 0 && (
        <button
          className="absolute left-4 top-1/2 -translate-y-1/2 z-10 w-12 h-12 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors"
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
        >
          <span className="material-symbols-outlined text-white text-3xl">chevron_left</span>
        </button>
      )}

      {currentIndex < images.length - 1 && (
        <button
          className="absolute right-4 top-1/2 -translate-y-1/2 z-10 w-12 h-12 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors"
          onClick={(e) => { e.stopPropagation(); onNext(); }}
        >
          <span className="material-symbols-outlined text-white text-3xl">chevron_right</span>
        </button>
      )}

      <div 
        className="max-w-[90vw] max-h-[80vh] rounded-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <img
          src={images[currentIndex]}
          alt="Gallery full view"
          className="max-w-full max-h-[80vh] object-contain rounded-2xl"
        />
      </div>
    </div>,
    document.body
  );
};

export default Gallery;
