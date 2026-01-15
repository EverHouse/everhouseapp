import React, { useState } from 'react';

interface VirtualTourProps {
  url?: string;
  title?: string;
  className?: string;
}

const VirtualTour: React.FC<VirtualTourProps> = ({ 
  url = "https://my.matterport.com/show/?m=1hJ9Ea7Yz2c&brand=0&help=0&hl=0&ts=0&play=1", 
  title = "Even House Virtual Tour",
  className = ""
}) => {
  const [isLoading, setIsLoading] = useState(true);

  return (
    <div className={`w-full max-w-7xl mx-auto ${className}`}>
      <div className="relative w-full overflow-hidden rounded-[2rem] shadow-2xl bg-black/5 aspect-[3/4] md:aspect-video border border-white/10">
        
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#F2F2EC] z-10">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-[#293515] border-t-transparent rounded-full animate-spin" />
              <p className="text-[#293515] font-medium text-sm tracking-widest uppercase">Loading Tour...</p>
            </div>
          </div>
        )}

        <iframe
          src={url}
          className={`absolute top-0 left-0 w-full h-full transition-opacity duration-700 ${isLoading ? 'opacity-0' : 'opacity-100'}`}
          title={title}
          allow="xr-spatial-tracking; fullscreen; accelerometer; gyroscope; magnetometer"
          allowFullScreen
          onLoad={() => setIsLoading(false)}
        />
        
        <div className="absolute inset-0 pointer-events-none rounded-[2rem] border border-white/10" />
      </div>
    </div>
  );
};

export default VirtualTour;
