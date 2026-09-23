import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `.vercelignore` keeps tests/, scripts/, supabase/ and docs/ out of the
 * upload, so the host builds a tree without them. A module under src/ that
 * imports from one of those builds here and fails there — which is how the
 * analytics release never reached the live site. This walks every import in
 * src/ and refuses any that leaves for an ignored directory.
 */

const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');

function ignoredTopLevel(): string[] {
  return readFileSync(join(ROOT, '.vercelignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/') && !line.includes('*') && !line.includes('.', 1))
    .map((line) => line.slice(1));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

describe('the Vercel upload', () => {
  it('builds without the directories .vercelignore leaves out', () => {
    const ignored = ignoredTopLevel();
    expect(ignored).toEqual(expect.arrayContaining(['tests', 'scripts', 'supabase', 'docs']));

    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(SPECIFIER)) {
        const spec = match[1];
        if (!spec.startsWith('.')) continue;
        const target = relative(ROOT, resolve(dirname(file), spec)).split(/[\\/]/)[0];
        if (ignored.includes(target)) offenders.push(`${relative(ROOT, file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
