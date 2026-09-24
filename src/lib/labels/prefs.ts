/**
 * The label printer's settings, remembered by this browser.
 *
 * Which stock is in the printer and what goes on a label belong to the desk
 * the printer sits on, not to an account, so they are kept here the way the
 * workflows' sound switch is (`src/lib/workflows/feedback.ts`): localStorage,
 * read through `useSyncExternalStore` so the server renders the defaults and
 * the browser swaps in the remembered values without a second pass of its own.
 * A browser that refuses storage keeps the choice for this page.
 */

import {
  DEFAULT_CONTENT,
  DEFAULT_TEMPLATE,
  isTemplateId,
  type LabelContent,
  type LabelTemplateId,
} from '@/lib/labels/layout';

export interface LabelPrefs {
  template: LabelTemplateId;
  content: LabelContent;
  copies: number;
}

export const LABEL_PREFS_KEY = 'edison-label-printer';

export const DEFAULT_PREFS: LabelPrefs = { template: DEFAULT_TEMPLATE, content: DEFAULT_CONTENT, copies: 1 };

/** Whatever was stored, made safe: unknown keys dropped, bad values defaulted. */
export function parsePrefs(raw: string | null): LabelPrefs {
  if (!raw) return DEFAULT_PREFS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_PREFS;
  const record = value as Record<string, unknown>;
  const content = (typeof record.content === 'object' && record.content !== null ? record.content : {}) as Record<
    string,
    unknown
  >;
  const flag = (key: keyof LabelContent, fallback: boolean) =>
    typeof content[key] === 'boolean' ? (content[key] as boolean) : fallback;
  const copies = typeof record.copies === 'number' && Number.isFinite(record.copies) ? record.copies : 1;
  return {
    template: isTemplateId(record.template) ? record.template : DEFAULT_TEMPLATE,
    content: {
      symbol: content.symbol === 'qr' ? 'qr' : 'barcode',
      tag: flag('tag', DEFAULT_CONTENT.tag),
      serial: flag('serial', DEFAULT_CONTENT.serial),
      model: flag('model', DEFAULT_CONTENT.model),
      property: flag('property', DEFAULT_CONTENT.property),
    },
    copies: Math.min(10, Math.max(1, Math.floor(copies))),
  };
}

let unstored: string | null = null;
let cachedRaw: string | null | undefined;
let cached: LabelPrefs = DEFAULT_PREFS;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  if (unstored !== null) return unstored;
  try {
    return window.localStorage.getItem(LABEL_PREFS_KEY);
  } catch {
    return null;
  }
}

export function subscribeLabelPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between changes, as `useSyncExternalStore` needs. */
export function labelPrefsSnapshot(): LabelPrefs {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parsePrefs(raw);
  }
  return cached;
}

export function serverLabelPrefs(): LabelPrefs {
  return DEFAULT_PREFS;
}

export function writeLabelPrefs(next: LabelPrefs): void {
  const raw = JSON.stringify(next);
  unstored = raw;
  try {
    window.localStorage.setItem(LABEL_PREFS_KEY, raw);
    unstored = null;
  } catch {
    // Kept for this page in `unstored`.
  }
  for (const listener of listeners) listener();
}
