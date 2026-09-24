'use client';

/**
 * One label, drawn at its real size.
 *
 * Every length is millimetres and every type size is points, so the same
 * element is the preview (scaled by its sheet) and the print (not scaled at
 * all). The bars are one SVG path on whole modules; the QR is one path on its
 * grid; the text is Geist Mono for the tag, because a tag is read character
 * by character by somebody typing it into a search.
 */

import { memo, useMemo } from 'react';
import { barsPath, encodableB, encodeCode128B, totalModules } from '@/lib/labels/code128';
import {
  modelLine,
  PROPERTY_LINE,
  type LabelContent,
  type LabelDevice,
  type LabelLayout,
  type LabelLine,
} from '@/lib/labels/layout';
import { qrPath, QR_QUIET } from '@/lib/labels/qr';

/** Wider than this per module and the bars stop getting easier to read; the rest is margin. */
const MAX_MODULE_MM = 0.6;

function lineText(line: LabelLine, device: LabelDevice): string {
  switch (line) {
    case 'tag':
      return device.code;
    case 'serial':
      return device.serialNumber && device.serialNumber !== device.code ? `SN ${device.serialNumber}` : '';
    case 'model':
      return modelLine(device);
    case 'property':
      return PROPERTY_LINE;
  }
}

function Barcode({ code, width, height }: { code: string; width: number; height: number }) {
  const drawn = useMemo(() => {
    if (!encodableB(code)) return null;
    const encoded = encodeCode128B(code);
    return { path: barsPath(encoded), modules: totalModules(encoded) };
  }, [code]);
  if (!drawn) {
    return (
      <span className="label-nosymbol" style={{ height: `${height}mm` }}>
        No barcode for this tag
      </span>
    );
  }
  const drawnWidth = Math.min(width, drawn.modules * MAX_MODULE_MM);
  return (
    <svg
      className="label-bars"
      viewBox={`0 0 ${drawn.modules} 1`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      style={{ width: `${drawnWidth}mm`, height: `${height}mm` }}
      aria-hidden="true"
    >
      <path d={drawn.path} />
    </svg>
  );
}

function QrSymbol({ code, edge }: { code: string; edge: number }) {
  const drawn = useMemo(() => {
    try {
      return qrPath(code);
    } catch {
      return null;
    }
  }, [code]);
  if (!drawn) return <span className="label-nosymbol">No code</span>;
  const box = drawn.size + QR_QUIET * 2;
  return (
    <svg
      className="label-qr"
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
      style={{ width: `${edge}mm`, height: `${edge}mm` }}
      aria-hidden="true"
    >
      <path d={drawn.path} />
    </svg>
  );
}

export const LabelFace = memo(function LabelFace({
  device,
  content,
  layout,
}: {
  device: LabelDevice;
  content: LabelContent;
  layout: LabelLayout;
}) {
  const lines = layout.lines
    .map((line) => ({ ...line, text: lineText(line.line, device) }))
    .filter((line) => line.text !== '');

  const text = (
    <span className="label-lines">
      {lines.map((line) => (
        <span
          key={line.line}
          className="label-line"
          data-line={line.line}
          style={{ fontSize: `${line.size}pt`, lineHeight: `${line.height}mm`, height: `${line.height}mm` }}
        >
          {line.text}
        </span>
      ))}
    </span>
  );

  return (
    <span
      className="label-face"
      data-symbol={content.symbol}
      style={{ width: `${layout.content.width}mm`, height: `${layout.content.height}mm` }}
    >
      {content.symbol === 'qr' ? (
        <>
          <QrSymbol code={device.code} edge={layout.symbol.width} />
          {text}
        </>
      ) : (
        <>
          <Barcode code={device.code} width={layout.symbol.width} height={layout.symbol.height} />
          {text}
        </>
      )}
    </span>
  );
});
