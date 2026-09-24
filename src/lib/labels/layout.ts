/**
 * Asset labels: the stock, where each label sits on it, and what fits.
 *
 * Every number here is a physical one, in millimetres, because a label is a
 * piece of paper before it is anything else. The page draws the sheet at its
 * real size (`mm` in CSS, which Chrome prints exactly at 100% scale) and the
 * preview is the same sheet scaled down, so there is one layout, not two that
 * are meant to agree.
 *
 * Two kinds of stock. A SHEET is a letter page of die-cut labels in a grid
 * (Avery 5160, 5167): the page is the sheet and a partly used one can start
 * part-way down. A ROLL is one label per page (Dymo, Brother, a 2″ × 1″
 * thermal): the page IS the label, and the driver feeds the next one.
 *
 * Pure and dependency-free, so the arithmetic is unit-tested rather than
 * checked by eye on a printout.
 */

export const MM_PER_INCH = 25.4;
export const MM_PER_POINT = MM_PER_INCH / 72;

export function inches(value: number): number {
  return value * MM_PER_INCH;
}

export type LabelTemplateId = 'avery-5160' | 'avery-5167' | 'dymo-30252' | 'brother-dk1201' | 'thermal-2x1';

export interface LabelTemplate {
  id: LabelTemplateId;
  /** What the picker says: the name on the box. */
  name: string;
  /** One line under it: the size, and how many a sheet holds. */
  detail: string;
  kind: 'sheet' | 'roll';
  /** The printed page, portrait as it goes through the printer. */
  page: { width: number; height: number };
  /** One label. */
  label: { width: number; height: number };
  columns: number;
  rows: number;
  /** From the page's top-left corner to the first label's. */
  offset: { top: number; left: number };
  /** From one label's corner to the next one's, across and down. */
  pitch: { x: number; y: number };
  /** The die-cut corner, for the preview only. */
  radius: number;
  /** Inside the label, kept clear on every side. */
  padding: number;
}

/**
 * The stock the desk buys. Avery's numbers are Avery's own templates; the
 * rolls are the labels themselves, landscape, which is how both drivers feed
 * them.
 */
export const LABEL_TEMPLATES: readonly LabelTemplate[] = [
  {
    id: 'avery-5160',
    name: 'Avery 5160',
    detail: '2⅝″ × 1″, 30 a sheet',
    kind: 'sheet',
    page: { width: inches(8.5), height: inches(11) },
    label: { width: inches(2.625), height: inches(1) },
    columns: 3,
    rows: 10,
    offset: { top: inches(0.5), left: inches(0.1875) },
    pitch: { x: inches(2.75), y: inches(1) },
    radius: inches(0.0625),
    padding: inches(0.08),
  },
  {
    id: 'avery-5167',
    name: 'Avery 5167',
    detail: '1¾″ × ½″, 80 a sheet',
    kind: 'sheet',
    page: { width: inches(8.5), height: inches(11) },
    label: { width: inches(1.75), height: inches(0.5) },
    columns: 4,
    rows: 20,
    offset: { top: inches(0.5), left: inches(0.3) },
    pitch: { x: inches(2.05), y: inches(0.5) },
    radius: inches(0.0625),
    padding: inches(0.04),
  },
  {
    id: 'dymo-30252',
    name: 'Dymo 30252',
    detail: '3½″ × 1⅛″ address roll',
    kind: 'roll',
    page: { width: inches(3.5), height: inches(1.125) },
    label: { width: inches(3.5), height: inches(1.125) },
    columns: 1,
    rows: 1,
    offset: { top: 0, left: 0 },
    pitch: { x: inches(3.5), y: inches(1.125) },
    radius: inches(0.06),
    padding: inches(0.1),
  },
  {
    id: 'brother-dk1201',
    name: 'Brother DK-1201',
    detail: '90 × 29 mm address roll',
    kind: 'roll',
    page: { width: 90, height: 29 },
    label: { width: 90, height: 29 },
    columns: 1,
    rows: 1,
    offset: { top: 0, left: 0 },
    pitch: { x: 90, y: 29 },
    radius: 1.5,
    padding: 2.5,
  },
  {
    id: 'thermal-2x1',
    name: 'Thermal 2″ × 1″',
    detail: 'Zebra, Rollo and most desk thermals',
    kind: 'roll',
    page: { width: inches(2), height: inches(1) },
    label: { width: inches(2), height: inches(1) },
    columns: 1,
    rows: 1,
    offset: { top: 0, left: 0 },
    pitch: { x: inches(2), y: inches(1) },
    radius: inches(0.05),
    padding: inches(0.06),
  },
];

export const DEFAULT_TEMPLATE: LabelTemplateId = 'avery-5160';

export function isTemplateId(value: unknown): value is LabelTemplateId {
  return typeof value === 'string' && LABEL_TEMPLATES.some((template) => template.id === value);
}

export function templateFor(id: string): LabelTemplate {
  return LABEL_TEMPLATES.find((template) => template.id === id) ?? LABEL_TEMPLATES[0];
}

/** How many labels one page holds. */
export function perPage(template: LabelTemplate): number {
  return template.columns * template.rows;
}

/**
 * The first N labels on a partly used sheet, clamped to what a sheet can skip.
 * A roll has nothing to skip: the next label is always the first.
 */
export function clampSkip(template: LabelTemplate, skip: number): number {
  if (template.kind === 'roll' || !Number.isFinite(skip)) return 0;
  return Math.min(perPage(template) - 1, Math.max(0, Math.floor(skip)));
}

/** One printed label: which page, which slot, and where its corner is. */
export interface LabelSlot {
  /** Zero-based page. */
  page: number;
  /** Zero-based slot on the page, reading left to right, top to bottom. */
  slot: number;
  row: number;
  column: number;
  /** The label's top-left corner on its page, in mm. */
  x: number;
  y: number;
}

export function slotPosition(template: LabelTemplate, slot: number): { row: number; column: number; x: number; y: number } {
  const row = Math.floor(slot / template.columns);
  const column = slot % template.columns;
  return {
    row,
    column,
    x: template.offset.left + column * template.pitch.x,
    y: template.offset.top + row * template.pitch.y,
  };
}

/**
 * Where `count` labels land, after `skip` used ones on the first sheet. The
 * skipped ones are on the first page only: the second sheet out of the box is
 * a new one.
 */
export function placeLabels(template: LabelTemplate, count: number, skip = 0): LabelSlot[] {
  const capacity = perPage(template);
  const first = clampSkip(template, skip);
  const slots: LabelSlot[] = [];
  for (let index = 0; index < Math.max(0, Math.floor(count)); index += 1) {
    const absolute = first + index;
    const page = Math.floor(absolute / capacity);
    const slot = absolute % capacity;
    slots.push({ page, slot, ...slotPosition(template, slot) });
  }
  return slots;
}

/** Pages the print will take. Nothing to print is no pages, not one empty one. */
export function pagesNeeded(template: LabelTemplate, count: number, skip = 0): number {
  if (count <= 0) return 0;
  return Math.ceil((clampSkip(template, skip) + count) / perPage(template));
}

/** The `@page` rule for the stock: its exact size, and no margin of the browser's. */
export function pageRule(template: LabelTemplate): string {
  return `@page { size: ${round(template.page.width)}mm ${round(template.page.height)}mm; margin: 0; }`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// What goes on a label
// ---------------------------------------------------------------------------

export type LabelSymbol = 'barcode' | 'qr';

export interface LabelContent {
  symbol: LabelSymbol;
  /** The tag, in mono, under the barcode or beside the QR. */
  tag: boolean;
  serial: boolean;
  model: boolean;
  /** "Property of Thomas A. Edison CTE HS — IT". */
  property: boolean;
}

export const DEFAULT_CONTENT: LabelContent = {
  symbol: 'barcode',
  tag: true,
  serial: true,
  model: false,
  property: true,
};

export const PROPERTY_LINE = 'Property of Thomas A. Edison CTE HS — IT';

/** A text line on the label, and the order they are given up in when space runs out. */
export type LabelLine = 'tag' | 'serial' | 'model' | 'property';

/** Last dropped first: the tag is the one line a person reads off a label. */
const DROP_ORDER: readonly LabelLine[] = ['property', 'model', 'serial', 'tag'];

export interface LineSize {
  line: LabelLine;
  /** Font size in points. */
  size: number;
  /** Line box height in mm. */
  height: number;
}

export interface LabelLayout {
  /** Inside the padding. */
  content: { width: number; height: number };
  /** The symbol's box: bar height for a barcode, edge for a QR. */
  symbol: { width: number; height: number };
  lines: LineSize[];
  /** Lines asked for that the label had no room for. */
  dropped: LabelLine[];
  /** QR beside the text rather than above it. */
  sideBySide: boolean;
}

/** The smallest readable bar: 4 mm tall, and a QR no smaller than 7 mm. */
export const MIN_BAR_HEIGHT = 4;
export const MIN_QR = 7;
const LINE_GAP = 0.35;
/** Between a QR and its lines, as `labels.css` draws it. */
export const QR_GAP = 1.5;
/** The smallest type a desk printer holds legibly. */
export const MIN_POINTS = 4;
/** Geist's average advance, as a share of the size: an estimate that errs wide. */
const ADVANCE = 0.56;

/** The largest size, up to `points`, at which `text` fits `width` mm; null under `MIN_POINTS`. */
export function fitPoints(text: string, width: number, points: number): number | null {
  const needed = text.length * ADVANCE * MM_PER_POINT;
  const fits = Math.min(points, width / needed);
  if (fits < MIN_POINTS) return null;
  return Math.floor(fits * 10) / 10;
}

/**
 * Type sizes by label height: 1″ labels get a 9 pt tag, ½″ labels 6.5 pt.
 * Points, because a person asks for "a bigger font" in points.
 */
export function typeScale(template: LabelTemplate): Record<LabelLine, number> {
  const height = template.label.height;
  if (height < 15) return { tag: 6.5, serial: 5, model: 5, property: 4.5 };
  if (height < 27) return { tag: 9, serial: 6.5, model: 6.5, property: 5.5 };
  return { tag: 10, serial: 7, model: 7, property: 6 };
}

function lineHeight(points: number): number {
  return points * MM_PER_POINT * 1.18;
}

/**
 * What fits, and how big.
 *
 * A barcode stacks: bars across the full width, the lines under them, and the
 * bars take whatever height the lines leave. When that falls under
 * `MIN_BAR_HEIGHT` a line is given up — the property line first, the tag last —
 * and said so beside the preview rather than printed clipped.
 *
 * A QR sits on the left at the label's full inner height with the lines beside
 * it; when even the tag will not fit beside it, it is dropped and the QR stands
 * alone, which on a ½″ label is the honest answer.
 */
export function labelLayout(template: LabelTemplate, content: LabelContent): LabelLayout {
  const inner = {
    width: template.label.width - template.padding * 2,
    height: template.label.height - template.padding * 2,
  };
  const scale = { ...typeScale(template) };
  const wanted = (['tag', 'serial', 'model', 'property'] as const).filter((line) => content[line]);
  const sized = (lines: readonly LabelLine[]): LineSize[] =>
    lines.map((line) => ({ line, size: scale[line], height: lineHeight(scale[line]) }));
  const stackHeight = (lines: readonly LineSize[]) =>
    lines.reduce((sum, one) => sum + one.height, 0) + (lines.length > 0 ? LINE_GAP * lines.length : 0);

  const dropped: LabelLine[] = [];
  let kept = [...wanted];

  if (content.symbol === 'barcode') {
    if (kept.includes('property')) {
      const fitted = fitPoints(PROPERTY_LINE, inner.width, scale.property);
      if (fitted === null) {
        kept = kept.filter((line) => line !== 'property');
        dropped.push('property');
      } else {
        scale.property = fitted;
      }
    }
    for (const candidate of DROP_ORDER) {
      if (inner.height - stackHeight(sized(kept)) >= MIN_BAR_HEIGHT) break;
      if (kept.includes(candidate)) {
        kept = kept.filter((line) => line !== candidate);
        dropped.push(candidate);
      }
    }
    const lines = sized(kept);
    return {
      content: inner,
      symbol: { width: inner.width, height: Math.max(0, inner.height - stackHeight(lines)) },
      lines,
      dropped,
      sideBySide: false,
    };
  }

  const edge = Math.max(MIN_QR, Math.min(inner.height, inner.width * 0.45));
  const textHeight = inner.height;
  // The property line is the one line whose length is known, and beside a QR
  // on a narrow label it is the one that would run off the edge: it shrinks
  // to fit, and is given up below the smallest size a printer holds.
  const textWidth = inner.width - edge - QR_GAP;
  if (kept.includes('property')) {
    const fitted = fitPoints(PROPERTY_LINE, textWidth, scale.property);
    if (fitted === null) {
      kept = kept.filter((line) => line !== 'property');
      dropped.push('property');
    } else {
      scale.property = fitted;
    }
  }
  for (const candidate of DROP_ORDER) {
    if (stackHeight(sized(kept)) <= textHeight) break;
    if (kept.includes(candidate)) {
      kept = kept.filter((line) => line !== candidate);
      dropped.push(candidate);
    }
  }
  return {
    content: inner,
    symbol: { width: edge, height: edge },
    lines: sized(kept),
    dropped,
    sideBySide: true,
  };
}

/**
 * How wide one bar module comes out: the symbol's full width with its quiet
 * zones, over the space it is given. Under 0.19 mm (7.5 mil) a desk scanner
 * starts missing reads and most printers cannot hold the edge.
 */
export const MIN_MODULE_MM = 0.19;

export function moduleWidth(availableWidth: number, totalModules: number): number {
  if (totalModules <= 0) return 0;
  return availableWidth / totalModules;
}

export function barcodeReadable(availableWidth: number, totalModules: number): boolean {
  return moduleWidth(availableWidth, totalModules) >= MIN_MODULE_MM;
}

// ---------------------------------------------------------------------------
// The machine on the label
// ---------------------------------------------------------------------------

export interface LabelDevice {
  id: string;
  /** The code the symbol carries: asset tag, else serial, else inventory id. */
  code: string;
  assetTag: string;
  serialNumber: string;
  manufacturer: string;
  model: string;
  deviceType: string;
}

/** Which of the machine's identifiers the label carries, as the page says it. */
export function codeSource(device: Pick<LabelDevice, 'code' | 'assetTag' | 'serialNumber'>): 'tag' | 'serial' | 'id' {
  if (device.assetTag !== '' && device.code === device.assetTag) return 'tag';
  if (device.serialNumber !== '' && device.code === device.serialNumber) return 'serial';
  return 'id';
}

/** "Lenovo 300e": the model line, with the maker when the model does not already say it. */
export function modelLine(device: Pick<LabelDevice, 'manufacturer' | 'model' | 'deviceType'>): string {
  const maker = device.manufacturer.trim();
  const model = device.model.trim();
  if (model === '') return [maker, device.deviceType.trim()].filter(Boolean).join(' ');
  if (maker !== '' && !model.toLowerCase().startsWith(maker.toLowerCase())) return `${maker} ${model}`;
  return model;
}

/** Each machine, `copies` times, in the order they were added. */
export function expandCopies<T>(devices: readonly T[], copies: number): T[] {
  const times = Math.min(10, Math.max(1, Math.floor(copies)));
  return devices.flatMap((device) => Array.from({ length: times }, () => device));
}

/** The most machines one print takes: three sheets of the smallest stock. */
export const LABEL_DEVICE_CAP = 240;

/** `/devices/labels?ids=…`, the page with these machines already on it. */
export function labelsHref(ids: readonly string[] = []): string {
  const unique = [...new Set(ids.filter((id) => id.trim() !== ''))].slice(0, LABEL_DEVICE_CAP);
  return unique.length === 0 ? '/devices/labels' : `/devices/labels?ids=${unique.join(',')}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids from the URL: uuids only, once each, capped. */
export function idsFromParam(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(',') : value ?? '';
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => UUID.test(id));
  return [...new Set(ids)].slice(0, LABEL_DEVICE_CAP);
}

/**
 * Codes out of whatever was pasted: a column from a spreadsheet, a comma list,
 * one per line. Trimmed, once each, in order. Spaces inside a code are kept
 * only when the paste was one line per code, since a sheet's tag can have one.
 */
export function codesFromPaste(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pieces =
    lines.length > 1
      ? lines.flatMap((line) => line.split(/[,;\t]/))
      : text.split(/[\s,;]+/);
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const piece of pieces) {
    const code = piece.trim();
    const key = code.toUpperCase();
    if (code === '' || seen.has(key)) continue;
    seen.add(key);
    codes.push(code);
  }
  return codes;
}
