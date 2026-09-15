import { describe, expect, it } from 'vitest';
import {
  draftFromText,
  stripReplyPrefixes,
  DRAFT_ISSUE_MAX,
  DRAFT_TITLE_MAX,
} from '../src/lib/intake/draft';

const EMAIL = `From: Marcus Ellery <marcus.ellery@edison.example>
To: helpdesk@edison.example
Subject: Re: Projector in room 118 shows no signal

Hi,

The projector in 118 will not pick up the teaching laptop. I have a parent
observation this afternoon so it would be good to have it before then.

Thanks
Marcus

--
Marcus Ellery
Science Department
Sent from my iPhone

On Monday, someone else wrote:
> this has happened before
`;

describe('draftFromText', () => {
  it('takes the subject as the title, without the Re:', () => {
    expect(draftFromText(EMAIL).title).toBe('Projector in room 118 shows no signal');
  });

  it('keeps what the reporter wrote and drops the rest', () => {
    const { issue } = draftFromText(EMAIL);
    expect(issue).toContain('will not pick up the teaching laptop');
    expect(issue).not.toContain('Sent from my iPhone');
    expect(issue).not.toContain('this has happened before');
    expect(issue).not.toContain('helpdesk@edison.example');
  });

  it('finds the sender to search the directory for', () => {
    expect(draftFromText(EMAIL).requesterQuery).toBe('marcus.ellery@edison.example');
  });

  it('reads the category and the priority out of the words', () => {
    const draft = draftFromText(EMAIL);
    expect(draft.category).toBe('projector_display');
    expect(draft.priority).toBe('high');
  });

  it('uses the first sentence when there is no subject line', () => {
    const draft = draftFromText('The printer in the main office is jammed. It has been all week.');
    expect(draft.title).toBe('The printer in the main office is jammed.');
    expect(draft.category).toBe('printer');
  });

  it('takes a name off a From line when there is no address', () => {
    expect(draftFromText('From: Marcus Ellery\nSubject: Help\n\nIt is broken.').requesterQuery).toBe(
      'Marcus Ellery',
    );
  });

  it('finds an address anywhere when there is no From line', () => {
    expect(draftFromText('Ask A.Okonkwo@edison.example about it.').requesterQuery).toBe(
      'a.okonkwo@edison.example',
    );
  });

  it('offers nothing it did not find', () => {
    const draft = draftFromText('');
    expect(draft).toEqual({
      title: '',
      issue: '',
      requesterQuery: null,
      category: null,
      priority: null,
    });
  });

  it('caps a long paste', () => {
    const long = `Subject: ${'x'.repeat(400)}\n\n${'The projector is broken. '.repeat(400)}`;
    const draft = draftFromText(long);
    expect(draft.title.length).toBeLessThanOrEqual(DRAFT_TITLE_MAX + 1);
    expect(draft.issue.length).toBeLessThanOrEqual(DRAFT_ISSUE_MAX + 1);
  });

  it('reads a message pasted with Windows line endings', () => {
    const windows = 'Subject: Wi-Fi drops\r\n\r\nIt keeps dropping in the library.\r\n';
    expect(draftFromText(windows).title).toBe('Wi-Fi drops');
    expect(draftFromText(windows).category).toBe('network');
  });
});

describe('stripReplyPrefixes', () => {
  it('takes every marker off, not just the first', () => {
    // Forwarded, then replied to. A title that still says "Fwd:" is a title
    // about an email rather than about a projector.
    expect(stripReplyPrefixes('Re: Fwd: Projector in 118')).toBe('Projector in 118');
    expect(stripReplyPrefixes('FW: RE: FW: Chromebook cart')).toBe('Chromebook cart');
  });

  it('reads the numbered form some clients write', () => {
    expect(stripReplyPrefixes('Re[2]: Wi-Fi in the library')).toBe('Wi-Fi in the library');
  });

  it('leaves a subject that is not a reply alone', () => {
    expect(stripReplyPrefixes('Retirement of the old printers')).toBe(
      'Retirement of the old printers',
    );
  });

  it('is empty for a subject that was nothing but markers', () => {
    expect(stripReplyPrefixes('Re: Fwd:')).toBe('');
  });
});
