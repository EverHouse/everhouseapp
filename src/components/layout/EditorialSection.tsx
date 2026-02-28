import React from 'react';
import { Link } from 'react-router-dom';

interface EditorialSectionProps {
  image: string;
  title: string;
  description: string;
  ctaLabel?: string;
  ctaLink?: string;
  reversed?: boolean;
  className?: string;
}

const EditorialSection: React.FC<EditorialSectionProps> = ({
  image,
  title,
  description,
  ctaLabel,
  ctaLink,
  reversed = false,
  className = '',
}) => {
  return (
    <section className={`bg-bone dark:bg-[#141414] py-16 px-6 md:py-24 md:px-12 lg:px-20 ${className}`}>
      <div className={`max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 lg:gap-16 items-center ${reversed ? 'md:flex-row-reverse' : ''}`}>
        {/* Image */}
        <div className={`${reversed ? 'md:order-2' : 'md:order-1'}`}>
          <div className="overflow-hidden rounded-xl group">
            <img
              src={image}
              alt={title}
              className="w-full h-auto aspect-[4/3] object-cover transition-transform duration-emphasis ease-out group-hover:scale-105"
              loading="lazy"
            />
          </div>
        </div>

        {/* Text Content */}
        <div className={`${reversed ? 'md:order-1' : 'md:order-2'} flex flex-col justify-center`}>
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-semibold text-primary dark:text-white leading-tight mb-4 md:mb-6" style={{ fontFamily: 'var(--font-headline)' }}>
            {title}
          </h2>
          <p className="text-base md:text-lg text-primary/70 dark:text-white/70 leading-relaxed mb-6 md:mb-8" style={{ fontFamily: 'var(--font-body)' }}>
            {description}
          </p>
          {ctaLabel && ctaLink && (
            <Link
              to={ctaLink}
              className="inline-flex items-center gap-2 text-sm font-medium text-primary dark:text-white hover:text-primary/70 dark:hover:text-white/70 transition-colors group w-fit"
            >
              <span className="border-b border-primary/30 dark:border-white/30 group-hover:border-primary/60 dark:group-hover:border-white/60 transition-colors pb-0.5">
                {ctaLabel}
              </span>
              <span className="material-symbols-outlined text-lg group-hover:translate-x-1 transition-transform">
                arrow_forward
              </span>
            </Link>
          )}
        </div>
      </div>
    </section>
  );
};

export default EditorialSection;
