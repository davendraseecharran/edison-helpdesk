import { describe, expect, it } from 'vitest';
import {
  addressesOf,
  clipboardFor,
  GMAIL_ADDRESS_CAP,
  gmailLink,
  gmailTitle,
  hasStudents,
  identifierLabel,
  identifierMenuLabel,
  soleKind,
  type PersonAddressee,
} from '../src/lib/people/clipboard';

/**
 * Every person here is invented and every address is on edison.example. The
 * shapes are the ones the real directory produces, blanks included: a fair
 * number of the 3,448 students have no address on file and no guardian phone,
 * and those rows are the interesting ones.
 */
function student(
  displayName: string,
  over: Partial<PersonAddressee> = {},
): PersonAddressee {
  return {
    id: `s-${displayName}`,
    displayName,
    email: null,
    externalId: null,
    kind: 'student',
    guardianName: null,
    guardianPhone: null,
    ...over,
  };
}

function staff(displayName: string, over: Partial<PersonAddressee> = {}): PersonAddressee {
  return {
    id: `t-${displayName}`,
    displayName,
    email: null,
    externalId: null,
    kind: 'staff',
    ...over,
  };
}

function manyStudents(count: number): PersonAddressee[] {
  return Array.from({ length: count }, (_, at) =>
    student(`Student ${at}`, { email: `student${at}@edison.example`, externalId: `2000000${at}` }),
  );
}

describe('addressesOf', () => {
  it('trims, drops the blanks and keeps the order', () => {
    const list = [
      student('Nia', { email: '  nia@edison.example  ' }),
      student('Omar'),
      staff('Ms Ruiz', { email: 'ruiz@edison.example' }),
    ];
    expect(addressesOf(list)).toEqual(['nia@edison.example', 'ruiz@edison.example']);
  });

  it('counts one address once, however it was spelled', () => {
    // Two records can carry one guardian's address, and a mailing that reaches
    // them twice looks like a mistake by whoever sent it.
    const list = [
      student('Nia', { email: 'home@edison.example' }),
      student('Ade', { email: 'HOME@edison.example' }),
      student('Kai', { email: ' home@edison.example ' }),
    ];
    // The first spelling wins: it is the one the directory holds.
    expect(addressesOf(list)).toEqual(['home@edison.example']);
  });

  it('is empty for a list with nobody to write to', () => {
    expect(addressesOf([student('Nia'), student('Omar', { email: '   ' })])).toEqual([]);
  });
});

describe('gmailLink', () => {
  it('puts the addresses in the field the account chose', () => {
    const list = [
      student('Nia', { email: 'nia@edison.example' }),
      student('Omar', { email: 'omar@edison.example' }),
    ];

    const cc = gmailLink(list, 'cc');
    expect(cc.url).not.toBeNull();
    const parsed = new URL(cc.url as string);
    expect(parsed.origin + parsed.pathname).toBe('https://mail.google.com/mail/');
    expect(parsed.searchParams.get('view')).toBe('cm');
    expect(parsed.searchParams.get('fs')).toBe('1');
    expect(parsed.searchParams.get('cc')).toBe('nia@edison.example,omar@edison.example');
    expect(parsed.searchParams.get('bcc')).toBeNull();

    const bcc = gmailLink(list, 'bcc');
    expect(new URL(bcc.url as string).searchParams.get('bcc')).toBe(
      'nia@edison.example,omar@edison.example',
    );
    expect(new URL(bcc.url as string).searchParams.get('cc')).toBeNull();
  });

  it('counts the people it cannot reach rather than quietly dropping them', () => {
    const link = gmailLink(
      [student('Nia', { email: 'nia@edison.example' }), student('Omar'), student('Kai')],
      'cc',
    );
    expect(link.addressCount).toBe(1);
    expect(link.skipped).toBe(2);
    expect(gmailTitle(link, 'cc')).toBe('Compose to 1 address in CC. 2 people with no address left out.');
  });

  it('says so when there is nobody to write to, instead of opening an empty window', () => {
    const link = gmailLink([student('Nia'), student('Omar')], 'cc');
    expect(link.url).toBeNull();
    expect(link.overCap).toBe(false);
    expect(link.reason).toBe('Nobody here has an address on file.');
    expect(gmailTitle(link, 'cc')).toBe('Nobody here has an address on file.');
  });

  it('refuses above the cap and points at the clipboard', () => {
    expect(GMAIL_ADDRESS_CAP).toBe(100);

    const exactly = gmailLink(manyStudents(GMAIL_ADDRESS_CAP), 'bcc');
    expect(exactly.overCap).toBe(false);
    expect(exactly.url).not.toBeNull();
    expect(exactly.addressCount).toBe(100);

    const oneMore = gmailLink(manyStudents(GMAIL_ADDRESS_CAP + 1), 'bcc');
    expect(oneMore.overCap).toBe(true);
    expect(oneMore.url).toBeNull();
    expect(oneMore.addressCount).toBe(101);
    expect(oneMore.reason).toBe('Too many for one Gmail link; copy the addresses instead.');
  });

  it('measures the cap against distinct addresses, not against rows', () => {
    // A hundred and one students who share one guardian address are one
    // recipient, and the link is fine.
    const shared = Array.from({ length: GMAIL_ADDRESS_CAP + 1 }, (_, at) =>
      student(`Student ${at}`, { email: 'one.family@edison.example' }),
    );
    const link = gmailLink(shared, 'bcc');
    expect(link.addressCount).toBe(1);
    expect(link.overCap).toBe(false);
    expect(link.url).not.toBeNull();
  });
});

describe('clipboardFor', () => {
  const roster: PersonAddressee[] = [
    student('Nia Okonkwo', {
      email: 'nia@edison.example',
      externalId: '210982679',
      guardianName: 'Adaeze Okonkwo',
      guardianPhone: '555 0100',
    }),
    student('Omar Haddad', { externalId: '230020049', guardianName: 'Rana Haddad' }),
    student('Kai Mercer', {
      email: ' kai@edison.example ',
      externalId: '  ',
      guardianPhone: ' 555 0188 ',
    }),
  ];

  it('writes addresses for a To: field and counts what it wrote', () => {
    const clip = clipboardFor('addresses', roster);
    expect(clip.text).toBe('nia@edison.example, kai@edison.example');
    expect(clip.count).toBe(2);
    expect(clip.message).toBe('Copied 2 addresses.');
  });

  it('writes names one to a line', () => {
    const clip = clipboardFor('names', roster);
    expect(clip.text).toBe('Nia Okonkwo\nOmar Haddad\nKai Mercer');
    expect(clip.message).toBe('Copied 3 names.');
  });

  it('writes a name and an address only for the people who have one', () => {
    const clip = clipboardFor('names-and-addresses', roster);
    expect(clip.text).toBe('Nia Okonkwo <nia@edison.example>\nKai Mercer <kai@edison.example>');
    expect(clip.count).toBe(2);
    expect(clip.message).toBe('Copied 2 names and addresses.');
  });

  it('does not repeat one address under two names', () => {
    const clip = clipboardFor('names-and-addresses', [
      student('Nia', { email: 'home@edison.example' }),
      student('Ade', { email: 'HOME@edison.example' }),
    ]);
    expect(clip.text).toBe('Nia <home@edison.example>');
    expect(clip.count).toBe(1);
  });

  it('writes identifiers one to a line, skipping the blanks', () => {
    const clip = clipboardFor('identifiers', roster);
    expect(clip.text).toBe('210982679\n230020049');
    expect(clip.message).toBe('Copied 2 OSIS numbers.');

    const staffClip = clipboardFor('identifiers', [
      staff('Ms Ruiz', { externalId: 'a.ruiz' }),
      staff('Mr Vance'),
    ]);
    expect(staffClip.text).toBe('a.ruiz');
    // One of a thing reads in the singular, whichever list it came from.
    expect(staffClip.message).toBe('Copied 1 staff id.');
  });

  it('writes a guardian phone against the guardian, or the student when there is no name', () => {
    const clip = clipboardFor('guardian-phones', roster);
    expect(clip.text).toBe('Adaeze Okonkwo: 555 0100\nKai Mercer: 555 0188');
    expect(clip.count).toBe(2);
    expect(clip.message).toBe('Copied 2 guardian phones.');
  });

  it('never writes a staff member into the guardian list', () => {
    const clip = clipboardFor('guardian-phones', [
      staff('Ms Ruiz', { guardianPhone: '555 0199' } as Partial<PersonAddressee>),
      student('Nia', { guardianName: 'Adaeze', guardianPhone: '555 0100' }),
    ]);
    expect(clip.text).toBe('Adaeze: 555 0100');
  });

  it('says there was nothing rather than writing an empty clipboard', () => {
    const none = clipboardFor('addresses', [student('Nia'), student('Omar')]);
    expect(none.text).toBe('');
    expect(none.count).toBe(0);
    expect(none.message).toBe('Nobody here has an address on file.');

    expect(clipboardFor('guardian-phones', [staff('Ms Ruiz')]).message).toBe(
      'Nobody here has a guardian phone on file.',
    );
    expect(clipboardFor('identifiers', []).message).toBe('Nobody here has an OSIS on file.');
  });

  it('says one of a thing in the singular', () => {
    const one = clipboardFor('addresses', [student('Nia', { email: 'nia@edison.example' })]);
    expect(one.message).toBe('Copied 1 address.');
    expect(clipboardFor('names', [student('Nia')]).message).toBe('Copied 1 name.');
    expect(clipboardFor('identifiers', [student('Nia', { externalId: '210982679' })]).message).toBe(
      'Copied 1 OSIS number.',
    );
    expect(
      clipboardFor('guardian-phones', [student('Nia', { guardianPhone: '555 0100' })]).message,
    ).toBe('Copied 1 guardian phone.');
  });
});

describe('what a list is called', () => {
  it('names the identifier from the one kind everybody is', () => {
    expect(soleKind([student('Nia'), student('Omar')])).toBe('student');
    expect(soleKind([staff('Ms Ruiz')])).toBe('staff');
    expect(soleKind([student('Nia'), staff('Ms Ruiz')])).toBeNull();
    expect(soleKind([])).toBeNull();

    expect(identifierLabel([student('Nia')])).toBe('OSIS numbers');
    expect(identifierLabel([staff('Ms Ruiz')])).toBe('staff ids');
    expect(identifierLabel([])).toBe('identifiers');
  });

  it('takes the list the screen is showing over the people it has not fetched', () => {
    // The menu is labelled before the fetch comes back, so an empty list with a
    // known kind must still read correctly.
    expect(identifierMenuLabel([], 'student')).toBe('OSIS numbers');
    expect(identifierMenuLabel([], 'staff')).toBe('Staff ids');
    expect(identifierMenuLabel([])).toBe('OSIS or staff ids');
    expect(identifierMenuLabel([staff('Ms Ruiz')])).toBe('Staff ids');
  });

  it('offers guardian phones on the students list and nowhere else', () => {
    expect(hasStudents([], 'student')).toBe(true);
    expect(hasStudents([], 'staff')).toBe(false);
    expect(hasStudents([student('Nia')])).toBe(true);
    expect(hasStudents([staff('Ms Ruiz')])).toBe(false);
  });
});
