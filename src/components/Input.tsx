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
    ? 'w-full bg-white border border-gray-200 rounded-lg py-3 px-4 text-primary placeholder:text-gray-600 focus:ring-2 focus:ring-primary focus:border-primary sm:text-sm sm:leading-6'
    : 'w-full glass-input py-3 px-4 text-primary dark:text-white placeholder:text-gray-600 dark:placeholder:text-white/70 sm:text-sm sm:leading-6';

  return (
    <div>
      <label 
        htmlFor={inputId}
        className="block text-sm font-bold text-primary dark:text-white mb-1.5 pl-1"
      >
        {label}
      </label>
      <div className="relative">
          <input 
              id={inputId}
              aria-describedby={errorId}
              aria-invalid={error ? 'true' : undefined}
              className={`${inputClasses} ${error ? 'border-red-500' : ''} ${className}`} 
              {...props} 
          />
          {icon && (
              <span className="material-symbols-outlined absolute right-3 top-3 text-gray-500 dark:text-gray-400 text-lg pointer-events-none" aria-hidden="true">{icon}</span>
          )}
      </div>
      {error && (
        <p id={errorId} className="mt-1 text-sm text-red-600 dark:text-red-400 pl-1" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

export default Input;