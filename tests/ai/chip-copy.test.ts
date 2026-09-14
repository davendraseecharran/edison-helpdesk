import { describe, expect, it } from 'vitest';
import { runningLabel } from '@/components/ai/chip-copy';

describe('running tool chip copy', () => {
  it('names the action and the one thing it is happening to', () => {
    expect(runningLabel('claim_ticket', { ticket: 'EDT-1042' })).toBe('Claiming EDT-1042');
    expect(runningLabel('resolve_ticket', { ticket: 'EDT-1042', solution: 'Replaced the cell.' })).toBe(
      'Resolving EDT-1042',
    );
    expect(runningLabel('get_person', { person: 'Nia Okonkwo' })).toBe('Reading Nia Okonkwo');
  });

  it('phrases a search as a search rather than as a noun', () => {
    expect(runningLabel('search_records', { query: 'projector' })).toBe('Searching for “projector”');
    expect(runningLabel('search_records', {})).toBe('Searching the records');
  });

  it('lists what is being listed, never a subject', () => {
    expect(runningLabel('list_people', { query: 'okonkwo' })).toBe('Listing people');
    expect(runningLabel('list_my_tickets', {})).toBe('Listing my tickets');
  });

  it('falls back to the tool name object when no argument identifies a subject', () => {
    expect(runningLabel('return_to_queue', {})).toBe('Returning to the queue');
  });

  it('hands back to the server description for a verb it cannot phrase', () => {
    expect(runningLabel('frobnicate_widget', { widget: 'x' })).toBeNull();
  });

  it('ignores blank arguments when choosing the subject', () => {
    expect(runningLabel('set_priority', { ticket: '', number: 'EDT-9', priority: 'high' })).toBe(
      'Setting EDT-9',
    );
  });
});
