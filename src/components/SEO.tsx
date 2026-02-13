import React, { useEffect } from 'react';

interface SEOProps {
  title: string;
  description: string;
  url: string;
  image?: string;
  type?: 'website' | 'article';
  keywords?: string;
}

const BASE_URL = 'https://everclub.app';
const DEFAULT_IMAGE = '/images/hero-lounge-optimized.webp';

export const SEO: React.FC<SEOProps> = ({
  title,
  description,
  url,
  image = DEFAULT_IMAGE,
  type = 'website',
  keywords,
}) => {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  const fullImage = image.startsWith('http') ? image : `${BASE_URL}${image}`;
  const fullTitle = title.includes('Ever') ? title : `${title} | Ever Members Club`;

  useEffect(() => {
    document.title = fullTitle;
  }, [fullTitle]);

  return null;
};

export default SEO;
