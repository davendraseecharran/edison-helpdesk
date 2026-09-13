/**
 * The import library: parse a CSV, recognise which AppSheet tab it is, and
 * normalise its rows into what `app_admin_import` accepts.
 *
 *   import { parseCsv, detectPreset, toPersonRows } from '<relative>/lib/import';
 *
 * One module, three callers: the admin import screen, the server action behind
 * it, and `node scripts/import-directory.mts`. That last one runs this file
 * with Node's native type stripping and no loader, which is why every specifier
 * below carries its `.ts` extension — Node's ESM resolver does not guess
 * extensions — and why nothing here imports `server-only`, the `@/` alias, or
 * anything from Node. The repository's tsconfig sets
 * `allowImportingTsExtensions`, which is legal because it also sets `noEmit`,
 * so TypeScript reads the same specifiers Node does and neither needs a
 * suppression.
 */

export * from './csv.ts';
export * from './presets.ts';
export * from './normalize.ts';
