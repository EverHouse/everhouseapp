import React from 'react';
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
  return (
    <section className={`bg-bone dark:bg-[#141414] ${className}`}>
      <div className="flex flex-col md:flex-row md:min-h-[600px] lg:min-h-[700px]">
        <div className={`relative overflow-hidden h-72 md:h-auto md:w-1/2 ${reversed ? 'md:order-2' : 'md:order-1'}`}>
          <img
            src={image}
            alt={imageAlt}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-emphasis ease-out hover:scale-105"
            loading="lazy"
          />
        </div>

        <div className={`flex flex-col justify-center p-6 md:p-12 lg:px-20 lg:py-24 md:w-1/2 ${reversed ? 'md:order-1' : 'md:order-2'}`}>
          <span
            className="text-[10px] uppercase text-primary/50 dark:text-white/50 mb-6 block text-left"
            style={{
              fontFamily: 'var(--font-label)',
              fontWeight: 700,
              letterSpacing: '0.4em',
            }}
          >
            {overline}
          </span>

          <h2
            className="text-3xl md:text-4xl text-primary dark:text-white mb-6 md:mb-8"
            style={{
              fontFamily: 'var(--font-display)',
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
            }}
          >
            {title}
          </h2>

          <p
            className="text-sm text-primary/70 dark:text-white/70 mb-8 md:mb-10 max-w-lg leading-relaxed"
            style={{
              fontFamily: 'var(--font-body)',
            }}
          >
            {description}
          </p>

          {ctaLabel && ctaLink && (
            <Link
              to={ctaLink}
              className="inline-flex items-center justify-center px-6 py-3 text-[11px] uppercase tracking-widest font-medium text-primary dark:text-white border border-primary/30 dark:border-white/30 hover:border-primary dark:hover:border-white hover:bg-primary/5 dark:hover:bg-white/5 transition-all w-fit"
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
