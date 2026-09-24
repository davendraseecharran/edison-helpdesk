/**
 * Puts the barcode decoder's WebAssembly where the site can serve it.
 *
 * `zxing-wasm` would otherwise fetch its module from a CDN at run time. The
 * scanner is used on a school network from a phone in a corridor, so the file
 * is served from this deployment instead: copied from the installed package
 * into `public/` and checked in. Run `npm run wasm` after upgrading
 * `barcode-detector` and commit the result. Not a build hook: the deployment
 * upload excludes `scripts/`, so a hook here fails on the host.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- a plain Node script, run by hand */
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(
  __dirname,
  '..',
  'node_modules',
  'zxing-wasm',
  'dist',
  'reader',
  'zxing_reader.wasm',
);
const target = path.join(__dirname, '..', 'public', 'zxing_reader.wasm');

if (!fs.existsSync(source)) {
  console.error('copy-zxing-wasm: zxing-wasm is not installed; run npm install first.');
  process.exit(1);
}
const same =
  fs.existsSync(target) && fs.readFileSync(source).equals(fs.readFileSync(target));
if (!same) {
  fs.copyFileSync(source, target);
  console.log('copy-zxing-wasm: public/zxing_reader.wasm updated.');
}
