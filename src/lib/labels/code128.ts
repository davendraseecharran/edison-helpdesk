/**
 * Code 128, subset B: the barcode on an asset label.
 *
 * Every handheld scanner on the desk reads it, every phone camera reads it,
 * and subset B covers the whole printable ASCII range an asset tag is written
 * in (`DOE-LN0000001`, `edison-cb-0412`). A tag of digits only would be
 * shorter in subset C, but a label is printed once and read for years; one
 * subset keeps the encoder small enough to read in one sitting and test
 * exhaustively.
 *
 * The output is not a picture. It is the run of bar and space widths in
 * modules, and the SVG is drawn from that with every edge on a whole module,
 * so the printer's own rasteriser decides where each edge lands and nothing
 * is anti-aliased into grey.
 *
 * Pure and dependency-free: the label page, the preview and the tests all
 * call the same function.
 */

/**
 * The 107 symbols, as six widths each (bar, space, bar, space, bar, space),
 * summing to 11 modules. 106 is the stop pattern: seven widths, 13 modules,
 * the last bar being the two-module termination bar.
 */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

export const START_B = 104;
export const STOP = 106;
/** Quiet zone either side, in modules. The specification asks for ten. */
export const QUIET_ZONE = 10;

/** Whether every character can be written in subset B: printable ASCII. */
export function encodableB(text: string): boolean {
  if (text.length === 0) return false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code > 126) return false;
  }
  return true;
}

/** The symbol values for the text, without start, check or stop. */
export function valuesB(text: string): number[] {
  if (!encodableB(text)) {
    throw new RangeError('Code 128-B takes printable ASCII only: letters, digits, spaces and punctuation.');
  }
  return [...text].map((char) => (char.codePointAt(0) ?? 32) - 32);
}

/** The check symbol: start plus each value times its position, modulo 103. */
export function checkValue(start: number, values: readonly number[]): number {
  let sum = start;
  values.forEach((value, index) => {
    sum += value * (index + 1);
  });
  return sum % 103;
}

export interface Code128 {
  /** Start, data, check, stop. */
  symbols: number[];
  check: number;
  /** Alternating bar and space widths in modules, starting with a bar. */
  widths: number[];
  /** Total width in modules, quiet zones excluded. */
  modules: number;
}

export function encodeCode128B(text: string): Code128 {
  const values = valuesB(text);
  const check = checkValue(START_B, values);
  const symbols = [START_B, ...values, check, STOP];
  const widths = symbols.flatMap((symbol) => [...CODE128_PATTERNS[symbol]].map(Number));
  return { symbols, check, widths, modules: widths.reduce((sum, width) => sum + width, 0) };
}

/** One bar: where it starts and how wide it is, in modules from the left edge of the quiet zone. */
export interface Bar {
  x: number;
  width: number;
}

/** The bars only, positioned, with the quiet zone included on the left. */
export function barsOf(code: Code128, quiet = QUIET_ZONE): Bar[] {
  const bars: Bar[] = [];
  let x = quiet;
  code.widths.forEach((width, index) => {
    if (index % 2 === 0) bars.push({ x, width });
    x += width;
  });
  return bars;
}

/**
 * The bars as one SVG path, in module units: `M x 0 h w v 1 h -w z` per bar.
 * One path rather than a rect per bar keeps a sheet of eighty labels light.
 * The viewBox is (modules + both quiet zones) by 1, stretched by the caller
 * with `preserveAspectRatio="none"` to whatever height the label allows;
 * horizontal edges never move, so stretching them is free.
 */
export function barsPath(code: Code128, quiet = QUIET_ZONE): string {
  return barsOf(code, quiet)
    .map((bar) => `M${bar.x} 0h${bar.width}v1h-${bar.width}z`)
    .join('');
}

/** Width of the whole symbol with both quiet zones, in modules. */
export function totalModules(code: Code128, quiet = QUIET_ZONE): number {
  return code.modules + quiet * 2;
}
