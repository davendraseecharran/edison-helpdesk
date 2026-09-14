import { describe, expect, it } from 'vitest';
import { asksFirst, readAsk } from '../src/lib/lookup/ask';

/**
 * The classifier decides which row Enter opens, so the tests that matter most
 * are the ones about what is NOT an ask: an identifier, a name, a single word.
 * A false positive costs somebody the record they were looking at.
 */
describe('a forced ask', () => {
  it('takes either prefix, with or without a space', () => {
    expect(readAsk('> who has cart 3', true)).toEqual({ rank: 'forced', prompt: 'who has cart 3' });
    expect(readAsk('>who has cart 3', true).rank).toBe('forced');
    expect(readAsk('? what is open', true)).toEqual({ rank: 'forced', prompt: 'what is open' });
  });

  it('forces the ask even for text that is plainly a record', () => {
    expect(readAsk('> EDT-1042', true)).toEqual({ rank: 'forced', prompt: 'EDT-1042' });
  });

  it('is still an ask with nothing typed after the prefix', () => {
    expect(readAsk('>', true)).toEqual({ rank: 'forced', prompt: '' });
  });
});

describe('a question', () => {
  it('reads a question mark as a question', () => {
    expect(readAsk('which carts are out?', true).rank).toBe('likely');
  });

  it('reads an opening verb as an instruction', () => {
    for (const text of [
      'find the cart 3 chromebooks',
      'show me what is waiting',
      'resolve the projector ticket',
      'draft a reply for room 214',
      'who has A-93542614',
      'summarise my open tickets',
    ]) {
      expect(readAsk(text, true).rank, text).toBe('likely');
    }
  });

  it('carries the text through unchanged', () => {
    expect(readAsk('  show me what is waiting  ', true).prompt).toBe('show me what is waiting');
  });
});

describe('what is not an ask', () => {
  it('leaves an identifier alone however it is punctuated', () => {
    for (const text of ['EDT-1042', 'A-93542614', '5CD91001JX', '243025319', 'a.okonkwo']) {
      expect(readAsk(text, true).rank, text).toBe('no');
    }
  });

  it('leaves a name alone', () => {
    expect(readAsk('Marcus Ellery', true).rank).toBe('no');
    expect(readAsk('okonkwo', true).rank).toBe('no');
  });

  it('leaves a single word alone even when the word is also a verb', () => {
    expect(readAsk('close', true).rank).toBe('no');
    expect(readAsk('show', true).rank).toBe('no');
  });

  it('leaves a short string alone', () => {
    expect(readAsk('who?', true).rank).toBe('no');
  });

  it('says nothing about an empty query', () => {
    expect(readAsk('   ', true)).toEqual({ rank: 'no', prompt: '' });
  });
});

describe('when the search found nothing', () => {
  it('offers the assistant instead of another spelling', () => {
    expect(readAsk('cart three will not charge', false).rank).toBe('likely');
  });

  it('still leaves a recognised identifier alone', () => {
    // A serial that matched nothing is a machine this account cannot see, not
    // a question. Offering to ask about it would be offering a second refusal.
    expect(readAsk('5CD91001JX', false).rank).toBe('no');
  });
});

describe('asksFirst', () => {
  it('puts a forced or likely ask above the records', () => {
    expect(asksFirst(readAsk('> anything', true))).toBe(true);
    expect(asksFirst(readAsk('what is open?', true))).toBe(true);
    expect(asksFirst(readAsk('EDT-1042', true))).toBe(false);
  });
});
