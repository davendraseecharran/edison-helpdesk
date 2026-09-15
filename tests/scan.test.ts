import { describe, expect, it } from 'vitest';
import {
  DEDUPE_WINDOW_MS,
  isScanPath,
  isSessionId,
  scanFormat,
  SCAN_FORMATS,
  scanPath,
  shouldSend,
} from '../src/lib/scan/relay';
import { devicePath, routeScannedCode } from '../src/lib/scan/route';

const ID = '2fae5f6b-0f9b-4a1e-9c9e-6b1d2f0a7c33';

describe('isSessionId', () => {
  it('accepts the uuid the database generated', () => {
    expect(isSessionId(ID)).toBe(true);
  });

  it('refuses anything that is not one', () => {
    expect(isSessionId(ID.toUpperCase())).toBe(false);
    expect(isSessionId(ID.slice(0, -1))).toBe(false);
    expect(isSessionId(`${ID} `)).toBe(false);
    expect(isSessionId('------------------------------------')).toBe(false);
    expect(isSessionId('')).toBe(false);
    expect(isSessionId(null)).toBe(false);
    expect(isSessionId(undefined)).toBe(false);
    expect(isSessionId({ toString: () => ID })).toBe(false);
  });
});

describe('isScanPath', () => {
  it('accepts the phone page for one session, and that alone', () => {
    expect(isScanPath(scanPath(ID))).toBe(true);
    expect(isScanPath(`/scan/${ID}`)).toBe(true);
  });

  it('refuses another route of this application', () => {
    expect(isScanPath('/queue')).toBe(false);
    expect(isScanPath('/admin/audit')).toBe(false);
    expect(isScanPath('/scan')).toBe(false);
    expect(isScanPath('/scan/')).toBe(false);
    expect(isScanPath(`/scan/${ID}/edit`)).toBe(false);
    expect(isScanPath(`/scan/${ID}?x=1`)).toBe(false);
    expect(isScanPath(`/scan/${ID}#x`)).toBe(false);
  });

  it('refuses every way of naming another host', () => {
    expect(isScanPath(`https://evil.test/scan/${ID}`)).toBe(false);
    expect(isScanPath(`//evil.test/scan/${ID}`)).toBe(false);
    expect(isScanPath(`/\\evil.test/scan/${ID}`)).toBe(false);
    expect(isScanPath(`http://127.0.0.1:3005/scan/${ID}`)).toBe(false);
    expect(isScanPath(`javascript:alert(1)//scan/${ID}`)).toBe(false);
  });

  it('refuses a path that only looks right up to a trailing newline', () => {
    expect(isScanPath(`/scan/${ID}\n`)).toBe(false);
    expect(isScanPath(`/scan/${ID}\n/queue`)).toBe(false);
  });

  it('refuses anything that is not a string', () => {
    expect(isScanPath(null)).toBe(false);
    expect(isScanPath(undefined)).toBe(false);
    expect(isScanPath(['/scan/', ID])).toBe(false);
  });
});

describe('scanFormat', () => {
  it('keeps the symbologies the session asked for', () => {
    for (const format of SCAN_FORMATS) expect(scanFormat(format)).toBe(format);
  });

  it('is the seven the detector is configured with', () => {
    expect([...SCAN_FORMATS]).toEqual([
      'code_128',
      'code_39',
      'ean_13',
      'ean_8',
      'upc_a',
      'qr_code',
      'data_matrix',
    ]);
  });

  it('normalises the case and spacing a browser may report', () => {
    expect(scanFormat('QR_CODE')).toBe('qr_code');
    expect(scanFormat(' code_128 ')).toBe('code_128');
  });

  it('records nothing at all for a symbology outside the list', () => {
    expect(scanFormat('pdf417')).toBe(null);
    expect(scanFormat('itf')).toBe(null);
    expect(scanFormat('')).toBe(null);
    expect(scanFormat(undefined)).toBe(null);
    expect(scanFormat(42)).toBe(null);
  });
});

describe('shouldSend', () => {
  it('sends the first code of a session', () => {
    expect(shouldSend('DOE-LN0000001', null, 1_000)).toBe(true);
  });

  it('ignores the same code again inside the window', () => {
    const last = { code: 'DOE-LN0000001', at: 1_000 };
    expect(shouldSend('DOE-LN0000001', last, 1_000)).toBe(false);
    expect(shouldSend('DOE-LN0000001', last, 1_000 + DEDUPE_WINDOW_MS - 1)).toBe(false);
  });

  it('sends the same code again once the window has passed', () => {
    const last = { code: 'DOE-LN0000001', at: 1_000 };
    expect(shouldSend('DOE-LN0000001', last, 1_000 + DEDUPE_WINDOW_MS)).toBe(true);
  });

  it('sends a different code at once, however fast it follows', () => {
    const last = { code: 'DOE-LN0000001', at: 1_000 };
    expect(shouldSend('DOE-LN0000002', last, 1_001)).toBe(true);
  });

  it('sends a code that comes back after a different one, because that is a real second scan', () => {
    // A, B, A again: a technician checking their work, not a camera repeating.
    expect(shouldSend('A', { code: 'B', at: 1_000 }, 1_001)).toBe(true);
  });

  it('never sends an empty reading', () => {
    expect(shouldSend('', null, 1_000)).toBe(false);
    expect(shouldSend('   ', null, 1_000)).toBe(false);
  });

  it('waits a second and a half', () => {
    expect(DEDUPE_WINDOW_MS).toBe(1500);
  });
});

/**
 * Where a scanned code goes.
 *
 * The decision itself, with no camera, no palette and no database in it: given
 * a code and what `app_lookup_inventory_code` made of it, either the machine's
 * page or the search field. Both scanners — the palette's camera and the
 * paired phone — call this, so they cannot drift apart.
 */
describe('routeScannedCode', () => {
  const MATCH = { id: '2fae5f6b-0f9b-4a1e-9c9e-6b1d2f0a7c33', label: 'DOE-LN0000001' };

  it('opens the machine when exactly one answers to the code', () => {
    expect(routeScannedCode('DOE-LN0000001', MATCH)).toEqual({
      kind: 'device',
      id: MATCH.id,
      label: MATCH.label,
      href: `/devices/${MATCH.id}`,
    });
  });

  it('falls back to the search when no machine answers to it', () => {
    expect(routeScannedCode('9051234567', null)).toEqual({
      kind: 'search',
      query: '9051234567',
    });
  });

  /**
   * The lookup returns nothing for a code that names TWO machines, on purpose:
   * a scanner has nobody to ask which one is in the operator's hand. That
   * arrives here as no match, and it has to end in the search rather than in a
   * guess.
   */
  it('falls back to the search for an ambiguous code, which arrives as no match', () => {
    expect(routeScannedCode('SR0001', null).kind).toBe('search');
  });

  it('trims what the camera read, whichever way it goes', () => {
    expect(routeScannedCode('  DOE-LN0000001 \n', MATCH).kind).toBe('device');
    expect(routeScannedCode('  9051234567  ', null)).toEqual({
      kind: 'search',
      query: '9051234567',
    });
  });

  it('searches for nothing rather than opening a machine on an empty reading', () => {
    expect(routeScannedCode('', MATCH)).toEqual({ kind: 'search', query: '' });
    expect(routeScannedCode('   ', null)).toEqual({ kind: 'search', query: '' });
  });

  it('names the page one machine lives on', () => {
    expect(devicePath(MATCH.id)).toBe(`/devices/${MATCH.id}`);
  });
});
