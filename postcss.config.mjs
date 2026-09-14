/**
 * PostCSS, for Tailwind v4.
 *
 * One plugin: Tailwind's own PostCSS adapter, which is what compiles the
 * `@import "tailwindcss"` and the `@theme` block in `src/app/globals.css`.
 * Everything else about the design system lives in CSS — `tokens.css` is still
 * the only file that names a colour, and the Tailwind theme is derived from it
 * rather than declared beside it.
 */
const config = {
  plugins: ['@tailwindcss/postcss'],
};

export default config;
