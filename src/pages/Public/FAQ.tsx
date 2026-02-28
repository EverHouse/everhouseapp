import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import WalkingGolferSpinner from '../../components/WalkingGolferSpinner';
import EmptyState from '../../components/EmptyState';
import { usePageReady } from '../../contexts/PageReadyContext';
import { AnimatedPage } from '../../components/motion';
import SEO from '../../components/SEO';
import { useAutoAnimate } from '@formkit/auto-animate/react';

interface FaqItem {
  id: number;
  question: string;
  answer: string;
  category?: string;
}

const FALLBACK_FAQS: FaqItem[] = [
  { id: 0, question: "Is Ever Club just a simulator room?", answer: "Not at all. Golf is the centerpiece, but the club is the product. Ever Club is a private social and professional space — the Trackman simulators are one part of a much larger experience that includes a premium workspace, a chef-driven cafe, curated events, and a community of like-minded professionals. Think of it as your office, your course, and your club — all under one roof.", category: "General" },
  { id: 1, question: "What is included in the membership?", answer: "Membership includes access to our lounge areas, coworking spaces, and the onsite cafe. Core and Premium memberships also include monthly hours for our TrackMan golf simulators and conference room bookings.", category: "Membership" },
  { id: 2, question: "Can I bring guests?", answer: "Yes, members are welcome to bring guests. Social and Core members have a daily guest limit, while Premium members enjoy enhanced guest privileges. Guests must be accompanied by a member at all times.", category: "Membership" },
  { id: 3, question: "How do I book a simulator?", answer: "Members can book simulator bays directly through the Ever Club app or member portal. Reservations can be made up to 14 days in advance depending on your membership tier.", category: "Booking" },
  { id: 4, question: "Is there a dress code?", answer: "We encourage a 'smart casual' dress code. Golf attire is always welcome. We ask that members avoid athletic wear that is overly casual (e.g., gym tank tops) in the lounge areas.", category: "Policies" },
  { id: 5, question: "Are the golf simulators suitable for beginners?", answer: "Absolutely! Our TrackMan 4 simulators are perfect for all skill levels, from beginners looking to learn the basics to professionals analyzing their swing data. We also offer introductory sessions.", category: "Amenities" },
  { id: 6, question: "Can I host a private event?", answer: "Yes, Ever Club offers several spaces for private hire, including the Main Hall and Private Dining Room. Visit our Private Hire page or contact our events team for more details.", category: "Events" },
  { id: 7, question: "What are the operating hours?", answer: "We are open Tuesday through Thursday from 8:30 AM to 8:00 PM, Friday and Saturday from 8:30 AM to 10:00 PM, and Sunday from 8:30 AM to 6:00 PM. We are closed on Mondays.", category: "General" },
  { id: 8, question: "Is there parking available?", answer: "Yes, ample complimentary parking is available for all members and guests at our Tustin location.", category: "General" },
];

const CATEGORY_ORDER = ['House Rules', 'Membership', 'Booking', 'Amenities', 'Events', 'Policies', 'General'];

const FAQ: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [faqs, setFaqs] = useState<FaqItem[]>(FALLBACK_FAQS);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [faqParent] = useAutoAnimate();

  useEffect(() => {
    if (!loading) {
      setPageReady(true);
    }
  }, [loading, setPageReady]);

  const fetchFaqs = useCallback(() => {
    fetch('/api/faqs')
      .then(res => res.ok ? res.json() : Promise.reject())
      .then((data: FaqItem[]) => {
        if (data.length > 0) setFaqs(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchFaqs();
  }, [fetchFaqs]);

  useEffect(() => {
    const handler = () => { fetchFaqs(); };
    window.addEventListener('app-refresh', handler);
    return () => window.removeEventListener('app-refresh', handler);
  }, [fetchFaqs]);

  const categories = useMemo(() => {
    const uniqueCategories = [...new Set(faqs.map(f => f.category).filter(Boolean))] as string[];
    return uniqueCategories.sort((a, b) => {
      const aIndex = CATEGORY_ORDER.indexOf(a);
      const bIndex = CATEGORY_ORDER.indexOf(b);
      if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });
  }, [faqs]);

  const filteredFaqs = useMemo(() => {
    if (!selectedCategory) return faqs;
    return faqs.filter(f => f.category === selectedCategory);
  }, [faqs, selectedCategory]);

  return (
    <AnimatedPage>
    <SEO title="FAQ — Frequently Asked Questions | Ever Club" description="Got questions about Ever Club? Find answers about memberships, Trackman golf simulators, events, hours, day passes & more at our Tustin, OC location." url="/faq" />
    <div 
      className="flex flex-col min-h-screen bg-bone dark:bg-[#141414] overflow-x-hidden"
      style={{ marginTop: 'calc(-1 * var(--header-offset))', paddingTop: 'var(--header-offset)' }}
    >
      <div className="px-6 pt-4 md:pt-2 pb-4 animate-content-enter">
        <h1 className="text-5xl text-primary dark:text-white mb-2 leading-none" style={{ fontFamily: 'var(--font-display)' }}>Frequently Asked Questions</h1>
        <p className="text-base text-primary/70 dark:text-white/70 leading-relaxed" style={{ fontFamily: 'var(--font-body)' }}>Common questions about membership, amenities, and policies.</p>
      </div>

      {!loading && categories.length > 0 && (
        <div className="px-6 pb-4 animate-content-enter-delay-1">
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-6 px-6 scrollbar-hide scroll-fade-right">
            <button
              onClick={() => setSelectedCategory(null)}
              className={`tactile-btn flex-shrink-0 px-4 py-2 rounded-full text-sm font-semibold transition-all duration-fast ${
                selectedCategory === null
                  ? 'bg-primary text-white'
                  : 'bg-white/60 dark:bg-white/5 text-primary/70 dark:text-white/70 hover:bg-white/80 dark:hover:bg-white/10'
              }`}
            >
              All
            </button>
            {categories.map(category => (
              <button
                key={category}
                onClick={() => setSelectedCategory(category)}
                className={`tactile-btn flex-shrink-0 px-4 py-2 rounded-full text-sm font-semibold transition-all duration-fast whitespace-nowrap ${
                  selectedCategory === category
                    ? 'bg-primary text-white'
                    : 'bg-white/60 dark:bg-white/5 text-primary/70 dark:text-white/70 hover:bg-white/80 dark:hover:bg-white/10'
                }`}
              >
                {category}
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={faqParent} className="px-6 pb-12 flex-1 space-y-3 animate-content-enter-delay-2">
        {loading ? (
          <div className="flex justify-center py-8">
            <WalkingGolferSpinner size="md" />
          </div>
        ) : filteredFaqs.length === 0 ? (
          <EmptyState
            icon="help"
            title="No questions found"
            description="Try selecting a different category."
            variant="compact"
          />
        ) : (
          filteredFaqs.map((faq, index) => (
            <div key={faq.id} className={`animate-list-item-delay-${Math.min(index, 10)}`}>
              <AccordionItem question={faq.question} answer={faq.answer} />
            </div>
          ))
        )}
      </div>

      <Footer />
    </div>
    </AnimatedPage>
  );
};

const AccordionItem: React.FC<{ question: string; answer: string }> = ({ question, answer }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="tactile-row border border-primary/10 dark:border-white/10 rounded-xl overflow-hidden bg-white/40 dark:bg-white/5 backdrop-blur-xl" style={{ borderRadius: '12px' }}>
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 text-left font-bold text-primary dark:text-white hover:bg-primary/5 dark:hover:bg-white/5 transition-colors"
      >
        <span>{question}</span>
        <span className={`material-symbols-outlined transition-transform duration-normal ${isOpen ? 'rotate-180' : ''}`}>expand_more</span>
      </button>
      <div className={`accordion-content ${isOpen ? 'is-open' : ''}`}>
        <div className="accordion-inner">
          <div className="p-4 pt-0 text-sm text-primary/70 dark:text-white/70 leading-relaxed">
            {answer}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FAQ;
