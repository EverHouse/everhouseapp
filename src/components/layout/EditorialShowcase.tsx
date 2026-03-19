import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

interface EditorialShowcaseProps {
  overline: string;
  title: React.ReactNode;
  description: string;
  image: string;
  imageAlt: string;
  ctaLabel?: string;
  ctaLink?: string;
  reversed?: boolean;
  className?: string;
}

const EditorialShowcase: React.FC<EditorialShowcaseProps> = ({
  overline,
  title,
  description,
  image,
  imageAlt,
  ctaLabel,
  ctaLink,
  reversed = false,
  className = '',
}) => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setIsVisible(true); observer.unobserve(el); } },
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} className={`${className}`}>
      <div
        className={`flex flex-col md:flex-row md:min-h-[600px] lg:min-h-[700px] overflow-hidden bg-bone dark:bg-[#1a1a1a] transition-opacity duration-[1200ms] ease-out ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        style={{ transform: isVisible ? 'translateY(0)' : 'translateY(24px)', transition: 'opacity 1200ms ease-out, transform 1200ms ease-out' }}
      >
        <div className={`relative overflow-hidden h-72 md:h-auto md:w-1/2 ${reversed ? 'md:order-2' : 'md:order-1'}`} style={{ aspectRatio: '4/3' }}>
          <img
            src={image}
            alt={imageAlt}
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-[800ms] ease-out hover:opacity-90"
            loading="lazy"
            fetchPriority="low"
            width={800}
            height={600}
          />
        </div>

        <div className={`flex flex-col justify-center p-8 md:p-16 lg:px-24 lg:py-28 md:w-1/2 ${reversed ? 'md:order-1' : 'md:order-2'}`}>
          <span
            className="text-[10px] uppercase text-primary/35 dark:text-white/35 mb-8 block text-left"
            style={{
              fontFamily: 'var(--font-label)',
              fontWeight: 400,
              letterSpacing: '0.35em',
            }}
          >
            {overline}
          </span>

          <h2
            className="text-3xl md:text-4xl text-primary dark:text-white mb-8 md:mb-10"
            style={{
              fontFamily: 'var(--font-display)',
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
            }}
          >
            {title}
          </h2>

          <p
            className="text-sm text-primary/60 dark:text-white/60 mb-10 md:mb-12 max-w-lg leading-[1.8]"
            style={{
              fontFamily: 'var(--font-body)',
              fontWeight: 300,
            }}
          >
            {description}
          </p>

          {ctaLabel && ctaLink && (
            <Link
              to={ctaLink}
              className="inline-flex items-center justify-center px-6 py-3 text-[10px] uppercase tracking-[0.25em] font-normal text-primary/70 dark:text-white/70 border border-primary/15 dark:border-white/15 hover:border-primary/40 dark:hover:border-white/40 hover:text-primary dark:hover:text-white transition-all duration-[600ms] w-fit"
              style={{ fontFamily: 'var(--font-label)' }}
            >
              {ctaLabel}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
};

export default EditorialShowcase;
