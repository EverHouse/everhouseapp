import React, { useId } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  icon?: string;
  variant?: 'glass' | 'solid';
  error?: string;
}

const Input: React.FC<InputProps> = ({ label, icon, variant = 'glass', error, className = "", id: providedId, ...props }) => {
  const generatedId = useId();
  const inputId = providedId || generatedId;
  const errorId = error ? `${inputId}-error` : undefined;
  
  const inputClasses = variant === 'solid'
    ? `w-full bg-white border rounded-lg py-3 px-4 text-primary placeholder:text-gray-600 sm:text-sm sm:leading-6 transition-shadow duration-fast ${
        error 
          ? 'border-amber-400 focus:ring-1 focus:ring-amber-400 focus:border-amber-400' 
          : 'border-gray-200 focus:ring-1 focus:ring-accent focus:border-accent'
      }`
    : `w-full glass-input py-3 px-4 text-primary dark:text-white placeholder:text-gray-600 dark:placeholder:text-white/70 sm:text-sm sm:leading-6 transition-shadow duration-fast ${
        error ? 'border-amber-400 focus:ring-1 focus:ring-amber-400' : ''
      }`;

  return (
    <div>
      <label 
        htmlFor={inputId}
        className="block text-sm font-semibold text-primary dark:text-white mb-1.5 pl-1"
      >
        {label}
      </label>
      <div className="relative">
          <input 
              id={inputId}
              aria-describedby={errorId}
              aria-invalid={error ? 'true' : undefined}
              className={`${inputClasses} ${className}`} 
              {...props} 
          />
          {icon && (
              <span className="material-symbols-outlined absolute right-3 top-3 text-gray-500 dark:text-gray-400 text-lg pointer-events-none" aria-hidden="true">{icon}</span>
          )}
      </div>
      {error && (
        <p id={errorId} className="mt-1 text-sm text-amber-600 dark:text-amber-400 pl-1 flex items-center gap-1" role="alert">
          <span className="material-symbols-outlined text-sm" aria-hidden="true">info</span>
          {error}
        </p>
      )}
    </div>
  );
};

export default Input;