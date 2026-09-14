/**
 * A QR code on a tile a phone camera can read.
 *
 * The markup is an SVG string produced by `qrcode` on the server, so the
 * package never reaches the browser bundle and the client does no drawing.
 * It is injected rather than parsed because that is the whole point of an
 * SVG string; what makes that safe is where it comes from — this
 * application's own `startScanSessionAction`, from a URL built out of the
 * configured origin and a uuid the database generated. Nothing a person
 * types can reach it. The guard below is belt and braces: anything that is
 * not an `<svg>` element renders as no code at all rather than as markup.
 *
 * The tile is white in both themes on purpose. `--ink` on `--surface` reads
 * beautifully in light and inverts in dark, and an inverted code defeats a
 * good many phone cameras — see `scan.css`, which owns that decision.
 */

export interface QrCodeProps {
  /** The `<svg>…</svg>` string from the server action. */
  svg: string;
  /** Named for assistive technology, which cannot read a barcode. */
  label: string;
  /** Edge length of the code itself, in pixels. */
  size?: number;
  className?: string;
}

function looksLikeSvg(svg: string): boolean {
  return svg.trimStart().startsWith('<svg') && !/<\s*script/i.test(svg);
}

export function QrCode({ svg, label, size = 240, className }: QrCodeProps) {
  if (!looksLikeSvg(svg)) return null;

  return (
    <div
      className={className ? `qr-tile ${className}` : 'qr-tile'}
      style={{ ['--qr-size' as string]: `${size}px` }}
      role="img"
      aria-label={label}
    >
      <div className="qr-code" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
