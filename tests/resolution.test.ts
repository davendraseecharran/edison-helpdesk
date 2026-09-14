import { describe, expect, it } from 'vitest';
import { draftSolution, DRAFT_SOLUTION_MAX } from '../src/lib/domain/resolution';
import type { TicketDetail } from '../src/lib/domain/selectors';
import type { WorkLog, WorkNote } from '../src/lib/domain/types';

function note(body: string, id = body.slice(0, 8)): WorkNote {
  return { id, ticketId: 't', authorId: 'a', body, createdAt: '2026-09-14T08:00:00Z' };
}

function log(description: string | null, minutes = 0): WorkLog {
  return {
    id: `w-${description ?? 'none'}-${minutes}`,
    ticketId: 't',
    contributorId: 'a',
    workDate: '2026-09-14',
    minutes,
    description,
    createdAt: '2026-09-14T08:00:00Z',
  };
}

function detail(notes: WorkNote[], workLogs: WorkLog[] = []): TicketDetail {
  return { notes, workLogs } as unknown as TicketDetail;
}

describe('draftSolution', () => {
  it('offers nothing when nothing is written down', () => {
    expect(draftSolution(detail([], []))).toBeNull();
    expect(draftSolution(detail([note('   ')], [log('  ')]))).toBeNull();
  });

  it('builds from the last two notes, newest last', () => {
    const draft = draftSolution(
      detail([note('Swapped the cable'), note('Tested the port'), note('Replaced the projector lamp')]),
    );
    expect(draft).toBe('Tested the port. Replaced the projector lamp.');
  });

  it('keeps punctuation that is already there', () => {
    expect(draftSolution(detail([note('Did it work? Yes.')]))).toBe('Did it work? Yes.');
  });

  it('adds what the work logs say and the time they took', () => {
    const draft = draftSolution(
      detail([note('Battery is the problem')], [log('Charge test on a second machine', 25)]),
    );
    expect(draft).toBe('Battery is the problem. Charge test on a second machine. 25m logged.');
  });

  it('writes an hour as an hour', () => {
    expect(draftSolution(detail([note('Fixed')], [log(null, 90)]))).toBe('Fixed. 1h 30m logged.');
    expect(draftSolution(detail([note('Fixed')], [log(null, 120)]))).toBe('Fixed. 2h logged.');
  });

  it('does not say the same thing twice', () => {
    const draft = draftSolution(detail([note('Charge test')], [log('Charge test', 10)]));
    expect(draft).toBe('Charge test. 10m logged.');
  });

  it('leaves out a time of zero rather than saying nothing took no time', () => {
    expect(draftSolution(detail([note('Fixed')], [log(null, 0)]))).toBe('Fixed.');
  });

  it('collapses the newlines a pasted note brings with it', () => {
    expect(draftSolution(detail([note('Line one\n\nline two')]))).toBe('Line one line two.');
  });

  it('cuts a long draft at a sentence rather than mid-word', () => {
    const long = `${'Tested every port in the room. '.repeat(40)}`;
    const draft = draftSolution(detail([note(long)]));
    expect(draft).not.toBeNull();
    expect(draft!.length).toBeLessThanOrEqual(DRAFT_SOLUTION_MAX);
    expect(draft!.endsWith('.')).toBe(true);
  });
});
