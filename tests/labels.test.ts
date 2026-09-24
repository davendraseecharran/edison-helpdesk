import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import {
  barsOf,
  barsPath,
  checkValue,
  CODE128_PATTERNS,
  encodableB,
  encodeCode128B,
  QUIET_ZONE,
  START_B,
  STOP,
  totalModules,
  valuesB,
} from '../src/lib/labels/code128';
import {
  barcodeReadable,
  clampSkip,
  codeSource,
  codesFromPaste,
  DEFAULT_CONTENT,
  expandCopies,
  fitPoints,
  idsFromParam,
  inches,
  LABEL_DEVICE_CAP,
  LABEL_TEMPLATES,
  labelLayout,
  labelsHref,
  MIN_BAR_HEIGHT,
  modelLine,
  moduleWidth,
  pageRule,
  pagesNeeded,
  perPage,
  placeLabels,
  templateFor,
} from '../src/lib/labels/layout';
import { qrPath, QR_QUIET } from '../src/lib/labels/qr';
import { DEFAULT_PREFS, parsePrefs } from '../src/lib/labels/prefs';

/**
 * Renders the encoder's bars into a greyscale bitmap and hands it to ZXing,
 * the same decoder a phone without `BarcodeDetector` uses. If the check
 * symbol, a pattern or the stop were wrong, ZXing would refuse the read.
 */
async function decode(text: string, scale = 3): Promise<string | null> {
  const code = encodeCode128B(text);
  const width = totalModules(code) * scale;
  const height = 40;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const bar of barsOf(code)) {
    for (let y = 0; y < height; y += 1) {
      for (let x = bar.x * scale; x < (bar.x + bar.width) * scale; x += 1) {
        const index = (y * width + x) * 4;
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
      }
    }
  }
  const results = await readBarcodes({ data, width, height, colorSpace: 'srgb' } as unknown as ImageData, {
    formats: ['Code128'],
    tryHarder: true,
  });
  return results[0]?.text ?? null;
}

beforeAll(async () => {
  const wasm = readFileSync('node_modules/zxing-wasm/dist/reader/zxing_reader.wasm');
  await prepareZXingModule({
    overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) },
    fireImmediately: true,
  });
});

describe('Code 128-B', () => {
  it('has 107 patterns, each 11 modules of three bars and three spaces, and a 13-module stop', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((pattern, index) => {
      const widths = [...pattern].map(Number);
      const sum = widths.reduce((total, width) => total + width, 0);
      if (index === STOP) {
        expect(widths).toHaveLength(7);
        expect(sum).toBe(13);
      } else {
        expect(widths).toHaveLength(6);
        expect(sum).toBe(11);
      }
      expect(widths.every((width) => width >= 1 && width <= 4)).toBe(true);
    });
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });

  it('knows the reference patterns: value 0, Start B and the stop', () => {
    expect(CODE128_PATTERNS[0]).toBe('212222');
    expect(CODE128_PATTERNS[START_B]).toBe('211214');
    expect(CODE128_PATTERNS[STOP]).toBe('2331112');
  });

  it('maps printable ASCII to value = code point − 32', () => {
    expect(valuesB(' ~')).toEqual([0, 94]);
    expect(valuesB('A1-')).toEqual([33, 17, 13]);
  });

  it('computes the check symbol by hand-worked examples', () => {
    // Start B 104 + P(48)·1 + J(42)·2 + J(42)·3 + 1(17)·4 + 2(18)·5 + 3(19)·6 + C(35)·7 = 879; 879 mod 103 = 55.
    expect(checkValue(START_B, valuesB('PJJ123C'))).toBe(55);
    // 104 + A(33)·1 = 137; 137 mod 103 = 34.
    expect(encodeCode128B('A').check).toBe(34);
    // 104 + 0 = 104; mod 103 = 1.
    expect(encodeCode128B(' ').check).toBe(1);
  });

  it('frames the data with Start B, the check and the stop', () => {
    const code = encodeCode128B('DOE-1');
    expect(code.symbols[0]).toBe(START_B);
    expect(code.symbols.at(-1)).toBe(STOP);
    expect(code.symbols.at(-2)).toBe(code.check);
    // 11 per symbol, 13 for the stop: start + 5 data + check = 7 × 11 + 13.
    expect(code.modules).toBe(7 * 11 + 13);
    expect(code.widths).toHaveLength(7 * 6 + 7);
  });

  it('refuses what subset B cannot write', () => {
    expect(encodableB('')).toBe(false);
    expect(encodableB('tab\there')).toBe(false);
    expect(encodableB('café')).toBe(false);
    expect(encodableB('DOE-LN0000001')).toBe(true);
    expect(() => encodeCode128B('é')).toThrow(/printable ASCII/);
  });

  it('draws whole-module bars inside the quiet zone', () => {
    const code = encodeCode128B('X');
    const bars = barsOf(code);
    expect(bars[0].x).toBe(QUIET_ZONE);
    const last = bars.at(-1)!;
    expect(last.x + last.width).toBe(QUIET_ZONE + code.modules);
    expect(bars.every((bar) => Number.isInteger(bar.x) && Number.isInteger(bar.width))).toBe(true);
    expect(barsPath(code).startsWith(`M${QUIET_ZONE} 0h2v1h-2z`)).toBe(true);
  });

  it.each(['DOE-LN0000001', 'SER-5CD1234XYZ', 'edison-cb-0412', 'PJJ123C', 'A', '0', 'Cart 3 / Room 204', '~!@#$%^&*()_+'])(
    'round-trips %s through ZXing',
    async (text) => {
      expect(await decode(text)).toBe(text);
    },
  );
});

describe('QR on a label', () => {
  it('draws a code ZXing reads back, runs merged along each row', async () => {
    const text = 'DOE-LN0000001';
    const { size, path } = qrPath(text);
    const scale = 6;
    const edge = (size + QR_QUIET * 2) * scale;
    const data = new Uint8ClampedArray(edge * edge * 4).fill(255);
    for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      const [x, y, w] = [Number(match[1]), Number(match[2]), Number(match[3])];
      for (let py = y * scale; py < (y + 1) * scale; py += 1) {
        for (let px = x * scale; px < (x + w) * scale; px += 1) {
          const index = (py * edge + px) * 4;
          data[index] = 0;
          data[index + 1] = 0;
          data[index + 2] = 0;
        }
      }
    }
    const results = await readBarcodes({ data, width: edge, height: edge, colorSpace: 'srgb' } as unknown as ImageData, {
      formats: ['QRCode'],
    });
    expect(results[0]?.text).toBe(text);
    // One rectangle per run, not per module.
    expect(path.split('M').length - 1).toBeLessThan(size * size);
  });
});

describe('remembered settings', () => {
  it('reads what was stored and defaults whatever is missing or wrong', () => {
    expect(parsePrefs(null)).toBe(DEFAULT_PREFS);
    expect(parsePrefs('not json')).toBe(DEFAULT_PREFS);
    expect(parsePrefs(JSON.stringify({ template: 'avery-5167', content: { symbol: 'qr', model: true }, copies: 3 }))).toEqual({
      template: 'avery-5167',
      content: { ...DEFAULT_PREFS.content, symbol: 'qr', model: true },
      copies: 3,
    });
    expect(parsePrefs(JSON.stringify({ template: 'nope', copies: 99 }))).toMatchObject({
      template: 'avery-5160',
      copies: 10,
    });
  });
});

describe('label stock', () => {
  it('sums each sheet to its page: margins, pitches and labels add up to 8½″ × 11″', () => {
    for (const template of LABEL_TEMPLATES.filter((one) => one.kind === 'sheet')) {
      const right = template.offset.left + (template.columns - 1) * template.pitch.x + template.label.width;
      const bottom = template.offset.top + (template.rows - 1) * template.pitch.y + template.label.height;
      expect(right).toBeLessThanOrEqual(template.page.width);
      expect(bottom).toBeLessThanOrEqual(template.page.height);
      // Symmetric side margins, as Avery cuts them.
      expect(template.page.width - right).toBeCloseTo(template.offset.left, 5);
    }
  });

  it('holds 30 on a 5160 and 80 on a 5167', () => {
    expect(perPage(templateFor('avery-5160'))).toBe(30);
    expect(perPage(templateFor('avery-5167'))).toBe(80);
    expect(perPage(templateFor('dymo-30252'))).toBe(1);
  });

  it('places the 5160’s labels at Avery’s own coordinates', () => {
    const template = templateFor('avery-5160');
    const [first, second, , fourth] = placeLabels(template, 4);
    expect(first).toMatchObject({ page: 0, slot: 0, row: 0, column: 0 });
    expect(first.x).toBeCloseTo(inches(0.1875), 6);
    expect(first.y).toBeCloseTo(inches(0.5), 6);
    expect(second.x).toBeCloseTo(inches(0.1875 + 2.75), 6);
    expect(fourth).toMatchObject({ row: 1, column: 0 });
    expect(fourth.y).toBeCloseTo(inches(1.5), 6);
  });

  it('skips the used labels on the first sheet only', () => {
    const template = templateFor('avery-5160');
    const slots = placeLabels(template, 5, 28);
    expect(slots.map((slot) => [slot.page, slot.slot])).toEqual([
      [0, 28],
      [0, 29],
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
    expect(pagesNeeded(template, 5, 28)).toBe(2);
    expect(pagesNeeded(template, 2, 28)).toBe(1);
    expect(pagesNeeded(template, 0, 28)).toBe(0);
  });

  it('clamps the skip to a sheet, and a roll skips nothing', () => {
    const sheet = templateFor('avery-5167');
    expect(clampSkip(sheet, -3)).toBe(0);
    expect(clampSkip(sheet, 200)).toBe(79);
    expect(clampSkip(sheet, 4.8)).toBe(4);
    expect(clampSkip(templateFor('dymo-30252'), 12)).toBe(0);
    expect(placeLabels(templateFor('dymo-30252'), 3, 12).map((slot) => slot.page)).toEqual([0, 1, 2]);
  });

  it('writes an exact @page rule with no margin', () => {
    expect(pageRule(templateFor('avery-5160'))).toBe('@page { size: 215.9mm 279.4mm; margin: 0; }');
    expect(pageRule(templateFor('brother-dk1201'))).toBe('@page { size: 90mm 29mm; margin: 0; }');
  });
});

describe('what fits on a label', () => {
  it('gives a 1″ label bars and every line', () => {
    const layout = labelLayout(templateFor('avery-5160'), { ...DEFAULT_CONTENT, model: true });
    expect(layout.dropped).toEqual([]);
    expect(layout.lines.map((line) => line.line)).toEqual(['tag', 'serial', 'model', 'property']);
    expect(layout.symbol.height).toBeGreaterThanOrEqual(MIN_BAR_HEIGHT);
    const used = layout.symbol.height + layout.lines.reduce((sum, line) => sum + line.height, 0);
    expect(used).toBeLessThanOrEqual(layout.content.height);
  });

  it('gives up the property line first on a ½″ label, and never the bars', () => {
    const layout = labelLayout(templateFor('avery-5167'), { ...DEFAULT_CONTENT, model: true });
    expect(layout.dropped[0]).toBe('property');
    expect(layout.lines.map((line) => line.line)).toContain('tag');
    expect(layout.symbol.height).toBeGreaterThanOrEqual(MIN_BAR_HEIGHT);
  });

  it('puts a QR beside the lines, square, no taller than the label', () => {
    const template = templateFor('dymo-30252');
    const layout = labelLayout(template, { ...DEFAULT_CONTENT, symbol: 'qr' });
    expect(layout.sideBySide).toBe(true);
    expect(layout.symbol.width).toBe(layout.symbol.height);
    expect(layout.symbol.height).toBeLessThanOrEqual(template.label.height - template.padding * 2);
  });

  it('shrinks the property line to fit beside a QR, and gives it up when it cannot', () => {
    const dymo = labelLayout(templateFor('dymo-30252'), { ...DEFAULT_CONTENT, symbol: 'qr' });
    expect(dymo.lines.map((line) => line.line)).toContain('property');
    const thermal = labelLayout(templateFor('thermal-2x1'), { ...DEFAULT_CONTENT, symbol: 'qr' });
    expect(thermal.dropped).toContain('property');
    expect(thermal.lines.map((line) => line.line)).toEqual(['tag', 'serial']);
    expect(fitPoints('x'.repeat(200), 10, 6)).toBeNull();
    expect(fitPoints('short', 50, 6)).toBe(6);
  });

  it('says when bars would be too thin to read', () => {
    const template = templateFor('avery-5167');
    const width = template.label.width - template.padding * 2;
    const short = totalModules(encodeCode128B('DOE-LN0000001'));
    const long = totalModules(encodeCode128B('A-VERY-LONG-TAG-THAT-WILL-NOT-FIT-001'));
    expect(barcodeReadable(width, short)).toBe(true);
    expect(barcodeReadable(width, long)).toBe(false);
    expect(moduleWidth(width, 0)).toBe(0);
  });
});

describe('the machines on the labels', () => {
  it('says which identifier the symbol carries', () => {
    expect(codeSource({ code: 'DOE-1', assetTag: 'DOE-1', serialNumber: 'S1' })).toBe('tag');
    expect(codeSource({ code: 'S1', assetTag: '', serialNumber: 'S1' })).toBe('serial');
    expect(codeSource({ code: 'DEV-9', assetTag: '', serialNumber: '' })).toBe('id');
  });

  it('writes the model line without saying the maker twice', () => {
    expect(modelLine({ manufacturer: 'Lenovo', model: '300e', deviceType: 'Chromebook' })).toBe('Lenovo 300e');
    expect(modelLine({ manufacturer: 'Dell', model: 'Dell Latitude 3190', deviceType: '' })).toBe('Dell Latitude 3190');
    expect(modelLine({ manufacturer: 'HP', model: '', deviceType: 'Printer' })).toBe('HP Printer');
  });

  it('repeats each machine for copies, capped at ten', () => {
    expect(expandCopies(['a', 'b'], 2)).toEqual(['a', 'a', 'b', 'b']);
    expect(expandCopies(['a'], 0)).toEqual(['a']);
    expect(expandCopies(['a'], 40)).toHaveLength(10);
  });

  it('builds and reads the page link: uuids only, once each, capped', () => {
    const id = '0b4f2a4e-8c1d-4c55-9a53-0f5f6a1c2d3e';
    expect(labelsHref([])).toBe('/devices/labels');
    expect(labelsHref([id, id])).toBe(`/devices/labels?ids=${id}`);
    expect(idsFromParam(`${id},nope,${id.toUpperCase()}`)).toEqual([id, id.toUpperCase()]);
    const many = Array.from({ length: LABEL_DEVICE_CAP + 5 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(idsFromParam(many.join(','))).toHaveLength(LABEL_DEVICE_CAP);
  });

  it('reads codes out of a pasted column, a comma list or a line of spaces', () => {
    expect(codesFromPaste('DOE-1\nDOE-2\r\n\nDOE-1\n')).toEqual(['DOE-1', 'DOE-2']);
    expect(codesFromPaste('DOE-1, DOE-2;DOE-3')).toEqual(['DOE-1', 'DOE-2', 'DOE-3']);
    expect(codesFromPaste('doe-1 DOE-1  DOE-4')).toEqual(['doe-1', 'DOE-4']);
    expect(codesFromPaste('Cart 3 tag\nRoom 204 tag')).toEqual(['Cart 3 tag', 'Room 204 tag']);
  });
});
