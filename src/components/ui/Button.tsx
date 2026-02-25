import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
  className?: string;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  children,
  className = '',
  ...props
}) => {
  const baseStyles = 'rounded-xl font-medium transition-all duration-fast focus:ring-2 focus:ring-offset-1 focus:ring-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed';

  const variants = {
    primary: 'bg-primary text-bone hover:bg-primary/90 active:scale-[0.98] dark:bg-bone dark:text-primary',
    secondary: 'bg-bone text-primary hover:bg-bone/90 active:scale-[0.98] dark:bg-primary dark:text-bone border border-primary/10 dark:border-bone/10',
    danger: 'bg-red-500 text-white hover:bg-red-600 active:scale-[0.98]',
    ghost: 'bg-transparent hover:bg-primary/10 dark:hover:bg-bone/10 text-primary dark:text-bone active:scale-[0.98]'
  };

  const sizes = {
    sm: 'px-3 py-1.5 text-sm min-h-[36px]',
    md: 'px-4 py-2.5 text-base min-h-[44px]',
    lg: 'px-6 py-3 text-lg min-h-[52px]'
  };

  return (
    <button
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

export default Button;
