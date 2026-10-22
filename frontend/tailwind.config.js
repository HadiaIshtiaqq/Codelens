/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Colour-blind-safe pair (blue / orange) used for step vs. failure highlights.
        step: { DEFAULT: '#3b82f6', soft: 'rgba(59,130,246,0.22)' },
        fail: { DEFAULT: '#f97316', soft: 'rgba(249,115,22,0.24)' },
      },
    },
  },
  plugins: [],
};
