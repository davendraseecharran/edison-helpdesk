import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

/**
 * Self-hosted application typefaces: Geist Sans for the interface, Geist Mono
 * for identifiers.
 *
 * The `geist` package ships both as local variable fonts through `next/font`,
 * so nothing is fetched from a third party at runtime and there is no layout
 * shift while they load. Each exposes its own CSS variable
 * (`--font-geist-sans` / `--font-geist-mono`); `tokens.css` maps those onto
 * `--font-sans` and `--font-mono`, which is what every rule in the application
 * actually says, so the typeface can change again without touching a
 * stylesheet twice.
 */
export const sans = GeistSans;
export const mono = GeistMono;
