/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        display: ["Playfair Display", "Georgia", "serif"],
        sans: ["Inter", "sans-serif"],
        serif: ["Playfair Display", "Georgia", "serif"],
      },
      colors: {
        primary: {
          DEFAULT: "#293515",
          dark: "#141414",
          light: "#3d4b20"
        },
        secondary: "#E7E7DC",
        accent: "#CCB8E4",
        "accent-dark": "#8B6FA8",
        lavender: "#CCB8E4",
        "lavender-dark": "#8B6FA8",
        bone: {
          DEFAULT: "#F2F2EC",
          dark: "#e5e5df"
        },
        surface: {
          light: "#FFFFFF",
          dark: "rgba(255, 255, 255, 0.05)",
        },
        brand: {
          green: "#293515",
          bone: "#F2F2EC",
          lavender: "#CCB8E4"
        },
        "glass-surface-primary": {
          DEFAULT: "rgba(204, 184, 228, 0.15)",
          border: "rgba(204, 184, 228, 0.25)",
          text: "#8B6FA8",
          dark: "rgba(204, 184, 228, 0.20)"
        },
      },
      backgroundImage: {
        'liquid-gradient': 'linear-gradient(135deg, #293515 0%, #1a210d 100%)',
        'glass-gradient': 'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)',
        'liquid-glass-light': 'linear-gradient(135deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.3) 100%)',
        'liquid-glass-dark': 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.3) 100%)',
      },
      boxShadow: {
        'glass': '0 8px 32px 0 rgba(0, 0, 0, 0.3)',
        'glow': '0 0 20px rgba(204, 184, 228, 0.2)',
        'inner-light': 'inset 0 1px 0 0 rgba(255, 255, 255, 0.08)',
        'liquid': '0 8px 32px rgba(0, 0, 0, 0.1), 0 2px 8px rgba(0, 0, 0, 0.05)',
        'liquid-dark': '0 8px 32px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.2)',
        'liquid-inner': 'inset 0 1px 2px rgba(255, 255, 255, 0.3), inset 0 -1px 2px rgba(0, 0, 0, 0.05)',
        'liquid-inner-dark': 'inset 0 1px 2px rgba(255, 255, 255, 0.15), inset 0 -1px 2px rgba(0, 0, 0, 0.2)',
        'liquid-hover': '0 12px 40px rgba(0, 0, 0, 0.15), 0 4px 12px rgba(0, 0, 0, 0.08)',
        'liquid-modal': '0 25px 50px rgba(0, 0, 0, 0.2), 0 10px 20px rgba(0, 0, 0, 0.1)',
      },
      borderRadius: {
        'lg': '8px',
        'xl': '12px',
        '2xl': '20px',
        '3xl': '28px',
        '4xl': '2rem',
        'liquid': '2rem',
        'full': '9999px',
      },
      backdropBlur: {
        'liquid': '20px',
      },
      transitionDuration: {
        'liquid': '400ms',
      },
      transitionTimingFunction: {
        'liquid': 'ease-in-out',
      },
      animation: {
        'pop-in': 'pop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) backwards',
        'slide-in-left': 'slide-in-left 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-up': 'slide-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-in-right': 'slide-in-right 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards',
      },
      keyframes: {
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.95) translateY(10px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        'slide-in-left': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
      }
    },
  },
  plugins: [],
}
