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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  description,
  url,
  image = DEFAULT_IMAGE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  type = 'website',
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  keywords,
}) => {
  const _fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  const _fullImage = image.startsWith('http') ? image : `${BASE_URL}${image}`;
  const fullTitle = title.includes('Ever') ? title : `${title} | Ever Members Club`;

  useEffect(() => {
    document.title = fullTitle;
  }, [fullTitle]);

  return null;
};

export default SEO;
