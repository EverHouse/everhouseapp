import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTheme } from '../../contexts/ThemeContext';
import { Footer } from '../../components/Footer';
import { MenuItemSkeleton, SkeletonList } from '../../components/skeletons';
import { usePageReady } from '../../contexts/PageReadyContext';
import { AnimatedPage } from '../../components/motion';

interface CafeItem {
  id: string;
  name: string;
  category: string;
  price: number;
  desc?: string;
  image?: string;
  icon?: string;
}

const PublicCafe: React.FC = () => {
  const navigate = useNavigate();
  const { effectiveTheme } = useTheme();
  const { setPageReady } = usePageReady();
  const isDark = effectiveTheme === 'dark';
  const [cafeMenu, setCafeMenu] = useState<CafeItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  const categories = useMemo(() => Array.from(new Set(cafeMenu.map(item => item.category))), [cafeMenu]);
  const [activeCategory, setActiveCategory] = useState('');
  const categoryScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  useEffect(() => {
    const fetchMenu = async () => {
      try {
        const response = await fetch('/api/cafe-menu');
        if (response.ok) {
          const data = await response.json();
          const normalized = data.map((item: any) => ({
            id: item.id?.toString() || '',
            name: item.name || '',
            category: item.category || '',
            price: parseFloat(item.price) || 0,
            desc: item.description || item.desc || '',
            image: item.image_url || item.image || '',
            icon: item.icon || ''
          }));
          setCafeMenu(normalized);
        }
      } catch (error) {
        console.error('Failed to fetch cafe menu:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchMenu();
  }, []);

  useEffect(() => {
    if (categories.length > 0 && !categories.includes(activeCategory)) {
      setActiveCategory(categories[0]);
    }
  }, [categories, activeCategory]);

  useEffect(() => {
    if (categoryScrollRef.current) {
      const buttons = categoryScrollRef.current.querySelectorAll('button');
      let activeBtn: HTMLElement | null = null;
      buttons.forEach(btn => {
        if (btn.textContent === activeCategory) activeBtn = btn as HTMLElement;
      });
      if (activeBtn) {
        activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
  }, [activeCategory]);

  const itemsByCategory = useMemo(() => {
    return categories.map(cat => ({
      category: cat,
      items: cafeMenu.filter(i => i.category === cat)
    }));
  }, [cafeMenu, categories]);

  return (
    <AnimatedPage>
    <div 
      className="flex flex-col min-h-screen bg-[#EAEBE6] dark:bg-[#0f120a] overflow-x-hidden w-full max-w-full"
      style={{ marginTop: 'calc(-1 * var(--header-offset))', paddingTop: 'var(--header-offset)' }}
    >
      <section className="px-6 pt-4 md:pt-2 pb-6 bg-[#EAEBE6] dark:bg-[#0f120a] animate-content-enter">
        <h1 className="text-5xl font-light text-primary dark:text-white mb-4 tracking-tight">Cafe Menu</h1>
        <p className="text-primary/70 dark:text-white/70 text-base leading-relaxed max-w-[90%]">
          Curated bites and beverages at the House. From artisan coffee to light fare.
        </p>
      </section>

      <div 
        ref={categoryScrollRef}
        className="flex gap-2 overflow-x-auto px-6 pb-4 scrollbar-hide animate-content-enter-delay-1 scroll-fade-right"
      >
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all flex-shrink-0 min-h-[44px] ${
              activeCategory === cat
                ? 'bg-primary text-white'
                : 'bg-white dark:bg-white/5 text-primary dark:text-white hover:bg-primary/10 dark:hover:bg-white/10'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="px-6 space-y-3 pb-8 flex-1 animate-content-enter-delay-2">
        {isLoading ? (
          <SkeletonList count={5} Component={MenuItemSkeleton} isDark={isDark} />
        ) : cafeMenu.length === 0 ? (
          <div className="text-center py-20">
            <span className="material-symbols-outlined text-5xl text-primary/30 dark:text-white/30 mb-4">restaurant_menu</span>
            <p className="text-primary/60 dark:text-white/60">Menu items are being updated.</p>
            <p className="text-primary/40 dark:text-white/40 text-sm mt-2">Check back soon for our latest offerings.</p>
          </div>
        ) : (
          itemsByCategory.map(cat => (
            <div
              key={cat.category}
              className={activeCategory === cat.category ? 'block space-y-3' : 'hidden'}
            >
              {cat.items.map((item, index) => {
                const isExpanded = expandedItemId === item.id;
                return (
                  <div
                    key={item.id}
                    className={`bg-white dark:bg-[#1a1d15] rounded-xl overflow-hidden shadow-layered dark:shadow-black/20 transition-all animate-list-item-delay-${Math.min(index, 10)}`}
                  >
                    <div
                      onClick={() => setExpandedItemId(isExpanded ? null : item.id)}
                      className={`flex justify-between items-center group p-3 cursor-pointer transition-all ${isExpanded ? '' : 'active:scale-[0.98]'}`}
                    >
                      <div className="flex gap-4 flex-1 items-center">
                        <div className="w-14 h-14 flex-shrink-0 rounded-lg flex items-center justify-center overflow-hidden relative bg-[#EAEBE6] dark:bg-white/5 text-primary/40 dark:text-white/40">
                          {item.image ? (
                            <img src={item.image} alt={item.name} className="w-full h-full object-cover absolute inset-0 opacity-80" />
                          ) : (
                            <span className="material-symbols-outlined text-2xl">{item.icon || 'restaurant'}</span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center gap-2">
                            <h3 className="font-bold text-base leading-tight text-primary dark:text-white">{item.name}</h3>
                            <span className="font-bold text-sm whitespace-nowrap text-primary dark:text-white">
                              {item.price === 0 ? 'MP' : `$${item.price}`}
                            </span>
                          </div>
                        </div>
                      </div>
                      <span className={`material-symbols-outlined text-[20px] transition-transform duration-300 ml-2 text-primary/40 dark:text-white/40 ${isExpanded ? 'rotate-180' : ''}`}>
                        expand_more
                      </span>
                    </div>
                    <div className={`accordion-content ${isExpanded ? 'expanded' : ''}`}>
                      <div className="px-3 pb-3 pt-0">
                        <p className="text-sm leading-relaxed text-primary/60 dark:text-white/60">
                          {item.desc || "A delicious choice from our menu, prepared fresh to order."}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <section className="px-6 py-10 text-center">
        <p className="text-primary/60 dark:text-white/60 text-sm mb-2">Our cafe is available to members and day pass holders.</p>
        <div className="flex items-center justify-center gap-4">
          <Link to="/tour" className="text-sm font-semibold text-primary dark:text-white hover:opacity-80 transition-opacity flex items-center gap-1">
            Book a Tour
            <span className="material-symbols-outlined text-lg">arrow_forward</span>
          </Link>
          <Link to="/checkout" className="text-sm font-semibold text-primary dark:text-white hover:opacity-80 transition-opacity flex items-center gap-1">
            Get a Day Pass
            <span className="material-symbols-outlined text-lg">arrow_forward</span>
          </Link>
        </div>
      </section>

      <Footer />
    </div>
    </AnimatedPage>
  );
};

export default PublicCafe;
