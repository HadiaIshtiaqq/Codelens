import { PALETTES, SHADES } from './scripts/gen-theme-palettes.mjs';

// Every palette reads its shades from CSS variables (src/theme.css), so light mode can swap them.
const themed = Object.fromEntries(
  PALETTES.map((name) => [name, Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`]))]),
);

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      colors: {
        ...themed,
        white: 'rgb(var(--c-white) / <alpha-value>)',
        black: 'rgb(var(--c-black) / <alpha-value>)',
        // Colour-blind-safe pair (blue / orange) used for step vs. failure highlights.
        step: { DEFAULT: '#3b82f6', soft: 'rgba(59,130,246,0.22)' },
        fail: { DEFAULT: '#f97316', soft: 'rgba(249,115,22,0.24)' },
      },
    },
  },
  plugins: [],
};
