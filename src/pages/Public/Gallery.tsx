import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import EmptyState from '../../components/EmptyState';
import { usePageReady } from '../../contexts/PageReadyContext';
import { AnimatedPage } from '../../components/motion';

interface GalleryImage {
  id: number;
  img: string;
  category: string;
  title?: string;
}

const Gallery: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [filter, setFilter] = useState('All');
  const [viewerState, setViewerState] = useState<{images: string[], index: number} | null>(null);

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

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
      <AnimatedPage>
      <div 
        className="flex flex-col min-h-screen bg-bone dark:bg-[#0f120a] overflow-x-hidden"
        style={{ marginTop: 'calc(-1 * var(--header-offset))', paddingTop: 'var(--header-offset)' }}
      >
        <div className="px-5 pt-4 md:pt-2 pb-6 animate-content-enter">
          <h1 className="text-3xl font-medium tracking-tight text-primary dark:text-white leading-tight">Gallery</h1>
          <p className="text-primary/70 dark:text-white/70 text-base mt-2 font-light">Explore the exclusive spaces of Ever Club.</p>
        </div>

        <div className="pl-5 pr-5 py-2 w-full overflow-x-auto scrollbar-hide mb-6 animate-content-enter-delay-1">
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

        <div className="px-5 flex-1 animate-content-enter-delay-2">
          {filteredItems.length === 0 ? (
            <EmptyState
              icon="photo_library"
              title={`No images found${filter !== 'All' ? ` in ${filter}` : ''}`}
              description="Check back soon for new photos."
              variant="compact"
            />
          ) : (
            <>
              <div className="columns-2 gap-4 space-y-4 animate-in fade-in duration-500">
                {filteredItems.map((item, index) => (
                  <GalleryItem key={item.id || item.img} img={item.img} onItemClick={openViewer} index={index} />
                ))}
              </div>
              <div className="mt-12 flex justify-center pb-8">
                <p className="text-xs text-primary/40 dark:text-white/40 font-medium">
                  {filteredItems.length} {filteredItems.length === 1 ? 'image' : 'images'}
                </p>
              </div>
            </>
          )}
        </div>

        <section className="px-6 py-10 text-center bg-bone dark:bg-[#0f120a]">
          <p className="text-primary/60 dark:text-white/60 text-sm mb-4">Like what you see?</p>
          <Link to="/tour" className="inline-block px-8 py-4 bg-primary text-white rounded-2xl font-bold text-sm tracking-widest uppercase hover:bg-primary/90 transition-all duration-300 active:scale-[0.98] shadow-[0_4px_16px_rgba(41,53,21,0.3)]">
            Book Your Private Tour
          </Link>
        </section>

        <Footer />
      </div>
      </AnimatedPage>

        {viewerState && (
          <ImageViewer
            images={viewerState.images}
            currentIndex={viewerState.index}
            onClose={handleClose}
            onPrev={handlePrev}
            onNext={handleNext}
          />
        )}
    </>
  );
};

const FilterButton: React.FC<{label: string; active?: boolean; onClick?: () => void; disabled?: boolean}> = ({ label, active, onClick, disabled }) => (
  <button 
    onClick={onClick} 
    disabled={disabled}
    className={`${
        active 
        ? 'bg-primary text-white shadow-md dark:shadow-black/20' 
        : 'bg-white/40 dark:bg-white/5 text-primary dark:text-white border border-white/50 dark:border-white/10 hover:bg-white/60 dark:hover:bg-white/10 backdrop-blur-md'
    } px-5 py-2.5 rounded-xl text-sm font-semibold transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed`}
  >
    {label}
  </button>
);

interface GalleryItemProps {
  img: string;
  index: number;
  onItemClick: (index: number) => void;
}

const GalleryItem: React.FC<GalleryItemProps> = React.memo(({ img, index, onItemClick }) => {
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState(false);

  const skeletonHeights = ['aspect-[4/3]', 'aspect-[3/4]', 'aspect-square', 'aspect-[4/5]'];
  const skeletonHeight = skeletonHeights[index % skeletonHeights.length];
  
  const handleClick = () => onItemClick(index);
  
  return (
    <div 
      className={`break-inside-avoid relative group rounded-2xl overflow-hidden shadow-sm dark:shadow-black/20 cursor-pointer mb-4 border border-white/20 dark:border-white/10 active:scale-[0.98] transition-transform animate-list-item-delay-${Math.min(index, 10)}`}
      onClick={handleClick}
    >
      {!loaded && !error && (
        <div className={`w-full ${skeletonHeight} bg-gradient-to-br from-gray-200 dark:from-white/10 via-gray-100 dark:via-white/5 to-gray-200 dark:to-white/10 rounded-2xl overflow-hidden`}>
          <div className="w-full h-full shimmer-effect" />
        </div>
      )}
      <img 
        src={img} 
        className={`w-full h-auto object-cover transform group-hover:scale-105 transition-all duration-700 ease-out ${loaded ? 'opacity-100' : 'opacity-0 absolute top-0 left-0'}`}
        alt="Gallery"
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
      {error && (
        <div className={`w-full ${skeletonHeight} bg-gray-200 dark:bg-white/5 flex items-center justify-center rounded-2xl`}>
          <span className="material-symbols-outlined text-gray-400 dark:text-white/50 text-3xl">broken_image</span>
        </div>
      )}
      {loaded && <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300"></div>}
    </div>
  );
});

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
