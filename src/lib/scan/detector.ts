/**
 * The barcode reader, wherever the camera is opened.
 *
 * The browser's own `BarcodeDetector` where it has one (Chrome on Android and
 * ChromeOS), otherwise a WebAssembly decoder fetched the first time a camera
 * opens — which is what puts a camera on an iPhone. The two answer the same
 * interface, so nothing past `loadDetector` knows which it got.
 *
 * Shared by the palette's one-shot scan (`ScanButton`) and the workflows'
 * continuous one (`WorkflowCamera`). Browser-only: every function here touches
 * `window`, and is only called from an effect.
 */

/** What the shape detection API reads: the formats asset tags, serials and labels come in. */
export const DETECTOR_FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'qr_code', 'data_matrix'];

export interface DetectedBarcode {
  rawValue: string;
  format: string;
}

export interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

export type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

/** Where `copy-zxing-wasm.cjs` puts the decoder, served by this deployment. */
const WASM_PATH = '/zxing_reader.wasm';

export async function loadDetector(): Promise<BarcodeDetectorConstructor> {
  const native = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (native) return native;
  const { BarcodeDetector, setZXingModuleOverrides } = await import('barcode-detector/ponyfill');
  setZXingModuleOverrides({
    locateFile: (file: string, prefix: string) => (file.endsWith('.wasm') ? WASM_PATH : prefix + file),
  });
  return BarcodeDetector as unknown as BarcodeDetectorConstructor;
}

/** Milliseconds between detection passes over the live frame. */
export const DETECT_INTERVAL_MS = 250;
