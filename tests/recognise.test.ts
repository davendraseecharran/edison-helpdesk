import { describe, expect, it } from 'vitest';
import {
  LOOKUP_KIND_LABELS,
  recognise,
  recogniseInText,
  recognisePaste,
  recognitionHeading,
  targetKind,
} from '../src/lib/lookup/recognise';

/**
 * The recogniser is the whole of "paste anything", so every shape a NetRider
 * actually pastes gets a test, and so does every shape that must NOT be
 * claimed: a surname is not a serial, nine bare digits are not a phone number,
 * and a room number is not a ticket when it is sitting inside a sentence.
 */
describe('ticket numbers', () => {
  it('reads every spelling of a ticket number', () => {
    for (const input of ['EDT-1042', 'edt-1042', 'EDT 1042', 'edt1042', '#EDT-1042']) {
      expect(recognise(input), input).toEqual({ kind: 'ticket', value: 'EDT-1042', certain: true });
    }
  });

  it('reads a bare number as a ticket, but not certainly', () => {
    expect(recognise('1042')).toEqual({ kind: 'ticket', value: 'EDT-1042', certain: false });
    expect(recognise('#7')).toEqual({ kind: 'ticket', value: 'EDT-7', certain: false });
  });
});

describe('OSIS', () => {
  it('reads nine digits, leading zeros kept', () => {
    expect(recognise('000123456')).toEqual({ kind: 'osis', value: '000123456', certain: true });
    expect(recognise('243025319')).toEqual({ kind: 'osis', value: '243025319', certain: true });
  });

  it('keeps a nine-digit OSIS as text rather than a number', () => {
    expect(recognise('000000001').value).toBe('000000001');
  });

  it('reads the importer´s wider range without claiming certainty', () => {
    expect(recognise('12345678')).toEqual({ kind: 'osis', value: '12345678', certain: false });
    expect(recognise('1234567890')).toEqual({ kind: 'osis', value: '1234567890', certain: false });
  });

  it('leaves a number too short for an OSIS to the ticket rule', () => {
    expect(recognise('12345').kind).toBe('ticket');
  });
});

describe('devices', () => {
  it('reads an asset tag in either spelling', () => {
    expect(recognise('A-93542614')).toEqual({ kind: 'asset_tag', value: 'A-93542614', certain: true });
    expect(recognise('a93542614')).toEqual({ kind: 'asset_tag', value: 'A-93542614', certain: true });
    expect(recognise('a 91001')).toEqual({ kind: 'asset_tag', value: 'A-91001', certain: true });
  });

  it('reads the inventory external id', () => {
    expect(recognise('dev-f8bc7dbde7a2')).toEqual({
      kind: 'device_id',
      value: 'DEV-F8BC7DBDE7A2',
      certain: true,
    });
  });

  it('reads a serial, upper-cased the way the database stores it', () => {
    expect(recognise('5cd91001jx')).toEqual({ kind: 'serial', value: '5CD91001JX', certain: false });
    expect(recognise('PW0FYJ9B')).toEqual({ kind: 'serial', value: 'PW0FYJ9B', certain: false });
  });

  it('never reads a word as a serial', () => {
    for (const input of ['Okonkwo', 'projector', 'chromebook']) {
      expect(recognise(input).kind, input).toBe('text');
    }
  });
});

describe('people', () => {
  it('reads an email address', () => {
    expect(recognise('A.Okonkwo@edison.example')).toEqual({
      kind: 'email',
      value: 'a.okonkwo@edison.example',
      certain: true,
    });
  });

  it('reads a district staff handle', () => {
    expect(recognise('a.okonkwo')).toEqual({ kind: 'staff_id', value: 'a.okonkwo', certain: true });
    expect(recognise('j.p.rivera').kind).toBe('staff_id');
  });

  it('reads a phone number only when it is punctuated or dialled', () => {
    expect(recognise('(212) 555-0134')).toEqual({
      kind: 'phone',
      value: '2125550134',
      certain: true,
    });
    expect(recognise('+1 212 555 0134')).toEqual({
      kind: 'phone',
      value: '+12125550134',
      certain: true,
    });
    // Bare digits are an id, never a phone: guessing here would put a student
    // behind a wrong turn.
    expect(recognise('2125550134').kind).toBe('osis');
  });
});

describe('plain text', () => {
  it('leaves an ordinary search alone', () => {
    expect(recognise('projector no signal')).toEqual({
      kind: 'text',
      value: 'projector no signal',
      certain: false,
    });
  });

  it('collapses the whitespace a pasted cell brings with it', () => {
    expect(recognise('  EDT-1042\n').value).toBe('EDT-1042');
  });

  it('treats an empty paste as empty text', () => {
    expect(recognise('   ')).toEqual({ kind: 'text', value: '', certain: false });
  });
});

describe('recogniseInText', () => {
  it('finds the identifier inside a pasted spreadsheet row', () => {
    const row = 'Okonkwo, Nia\t9A\tA-93542614\tin repair';
    expect(recogniseInText(row)).toEqual({ kind: 'asset_tag', value: 'A-93542614', certain: true });
  });

  it('prefers the ticket over anything else in the line', () => {
    const line = 'Re: EDT-1042 — a.okonkwo@edison.example says the projector is dead';
    expect(recogniseInText(line)?.kind).toBe('ticket');
  });

  it('prefers a device over an address in a signature block', () => {
    const block = 'Sent from a.okonkwo@edison.example about DEV-F8BC7DBDE7A2';
    expect(recogniseInText(block)?.kind).toBe('device_id');
  });

  it('ignores an uncertain shape inside a sentence', () => {
    // 214 is a room in this sentence, not ticket EDT-214.
    expect(recogniseInText('the projector in room 214 is dead')).toBeNull();
  });

  it('says nothing about a single token, which recognise() already handled', () => {
    expect(recogniseInText('EDT-1042')).toBeNull();
  });
});

describe('recognisePaste', () => {
  it('reads a lone identifier', () => {
    expect(recognisePaste(' a-91001 ').kind).toBe('asset_tag');
  });

  it('digs an identifier out of a longer paste', () => {
    expect(recognisePaste('Asset A-91001 was returned yesterday').kind).toBe('asset_tag');
  });

  it('falls back to searching for what was pasted', () => {
    expect(recognisePaste('cart three will not charge')).toEqual({
      kind: 'text',
      value: 'cart three will not charge',
      certain: false,
    });
  });
});

describe('targetKind', () => {
  it('points each identifier at the kind of record it names', () => {
    expect(targetKind('ticket')).toBe('ticket');
    expect(targetKind('osis')).toBe('person');
    expect(targetKind('staff_id')).toBe('person');
    expect(targetKind('email')).toBe('person');
    expect(targetKind('phone')).toBe('person');
    expect(targetKind('asset_tag')).toBe('device');
    expect(targetKind('serial')).toBe('device');
    expect(targetKind('device_id')).toBe('device');
    expect(targetKind('text')).toBeNull();
  });
});

describe('recognitionHeading', () => {
  it('says what it thinks it was given', () => {
    expect(recognitionHeading(recognise('A-91001'))).toBe('Asset tag A-91001');
    expect(recognitionHeading(recognise('243025319'))).toBe('OSIS 243025319');
    expect(recognitionHeading(recognise('a cracked screen'))).toBe('Results');
  });

  it('has a label for every kind', () => {
    for (const label of Object.values(LOOKUP_KIND_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
