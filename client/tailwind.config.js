/** Design tokens live as CSS variables in src/styles/tokens.css; Tailwind maps names onto them. */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: token('color-bg'),
        surface: token('color-surface'),
        'surface-muted': token('color-surface-muted'),
        border: token('color-border'),
        fg: token('color-fg'),
        'fg-muted': token('color-fg-muted'),
        primary: { DEFAULT: token('color-primary'), fg: token('color-primary-fg'), soft: token('color-primary-soft') },
        accent: { DEFAULT: token('color-accent'), soft: token('color-accent-soft') },
        success: { DEFAULT: token('color-success'), soft: token('color-success-soft') },
        warning: { DEFAULT: token('color-warning'), strong: token('color-warning-strong'), soft: token('color-warning-soft') },
        danger: { DEFAULT: token('color-danger'), fg: token('color-danger-fg'), soft: token('color-danger-soft') },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.25rem',
        '3xl': '1.75rem',
      },
      boxShadow: {
        card: '0 1px 2px rgb(var(--shadow-color) / 0.06), 0 4px 16px rgb(var(--shadow-color) / 0.06)',
        raised: '0 8px 28px rgb(var(--shadow-color) / 0.14)',
      },
      maxWidth: {
        app: '32rem',
      },
      transitionTimingFunction: {
        calm: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
    },
  },
  plugins: [],
};
