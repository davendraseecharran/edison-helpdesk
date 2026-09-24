/**
 * A QR code for a label, as one SVG path in module units.
 *
 * `qrcode` does the encoding; the drawing is ours, for the same reason the
 * bars are: one path, whole modules, and runs of dark modules along a row
 * merged into one rectangle, so a sheet of thirty codes stays a light page
 * and every edge lands on the grid.
 */

import QRCode from 'qrcode';

export interface QrPath {
  /** Modules along one edge, quiet zone excluded. */
  size: number;
  path: string;
}

/**
 * White round the code, in modules. The specification asks for four; on a
 * label the padding inside the die cut is white too, so two drawn plus the
 * label's own margin clears it without shrinking the code on a ½″ label.
 */
export const QR_QUIET = 2;

export function qrPath(text: string, quiet = QR_QUIET): QrPath {
  const code = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const { size, data } = code.modules;
  const parts: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let column = 0;
    while (column < size) {
      if (!data[row * size + column]) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < size && data[row * size + column]) column += 1;
      parts.push(`M${start + quiet} ${row + quiet}h${column - start}v1h-${column - start}z`);
    }
  }
  return { size, path: parts.join('') };
}
