'use client';

/**
 * Check-in at the door: one field, as big as the screen allows, that a
 * barcode scanner types into.
 *
 * A keyboard-wedge scanner is a keyboard: it types the code and presses
 * Enter. So the whole kiosk is a form with one input that never loses focus,
 * and every Enter is one person. The register it writes is the same one the
 * event's page shows — `app_mark_attendance_by_key`, the same five answers.
 *
 * THE MOMENT. A person who is checked in gets their name, large, and a tick
 * that draws itself — held for a second and a half and then gone, because the
 * next person is already holding out a card. The field stays live underneath
 * the whole time: a scan during somebody else's welcome is simply the next
 * welcome. Anything that is not a check-in stays a little longer and says what
 * to do instead.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { markByKeyAction } from '@/lib/data/group-event-actions';
import { KioskFrame } from './KioskFrame';
import { KioskMessage, type KioskNotice } from './KioskMessage';

const WELCOME_MS = 1500;
const PROBLEM_MS = 3200;

function firstNameOf(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

export function EventKiosk({
  eventId,
  eventName,
  groupId,
  groupName,
  heldOnLabel,
  initialPresent,
  memberCount,
}: {
  eventId: string;
  eventName: string;
  groupId: string;
  groupName: string;
  heldOnLabel: string;
  initialPresent: number;
  memberCount: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [present, setPresent] = useState(initialPresent);
  const [notice, setNotice] = useState<KioskNotice | null>(null);
  const clearTimer = useRef<number | null>(null);
  const sequence = useRef(0);

  const focusField = useCallback(() => {
    const field = input.current;
    if (field && document.activeElement !== field) field.focus({ preventScroll: true });
  }, []);

  // The field takes the keyboard back whenever it loses it to anything but
  // the kiosk's own two buttons: a scanner types wherever focus is.
  useEffect(() => {
    focusField();
    const onFocusOut = () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active && active.closest('.kiosk-bar')) return;
        focusField();
      }, 60);
    };
    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, [focusField]);

  useEffect(
    () => () => {
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    },
    [],
  );

  function show(next: KioskNotice, ms: number) {
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    setNotice(next);
    clearTimer.current = window.setTimeout(() => {
      clearTimer.current = null;
      setNotice(null);
    }, ms);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = value.trim();
    // Cleared at once: the next card may already be on its way.
    setValue('');
    if (key === '') return;
    const mine = ++sequence.current;
    let answer;
    try {
      answer = await markByKeyAction(eventId, key);
    } catch {
      show({ tone: 'problem', title: 'That did not go through', body: 'Check the connection, then scan again.' }, PROBLEM_MS);
      return;
    }
    // A slower answer to an earlier scan never paints over a newer one.
    if (mine !== sequence.current) {
      if (answer.outcome === 'present') setPresent((count) => count + 1);
      return;
    }
    const first = firstNameOf(answer.displayName);
    switch (answer.outcome) {
      case 'present':
        setPresent((count) => count + 1);
        show({ tone: 'welcome', title: first ? `Welcome, ${first}` : 'Welcome', body: `You are checked in to ${eventName}.`, key: mine }, WELCOME_MS);
        break;
      case 'already':
        show({ tone: 'welcome', title: first ? `Welcome back, ${first}` : 'Welcome back', body: 'You were already checked in.', key: mine }, WELCOME_MS);
        break;
      case 'not_member':
        show(
          {
            tone: 'problem',
            title: first ? `${first}, you are not on the list` : 'Not on the list',
            body: `You are not in ${groupName}. See the person running check-in.`,
          },
          PROBLEM_MS,
        );
        break;
      case 'ambiguous':
        show({ tone: 'problem', title: 'More than one person matches', body: 'Scan your ID card or type your OSIS instead of a name.' }, PROBLEM_MS);
        break;
      case 'no_match':
        show({ tone: 'problem', title: 'We could not find that ID', body: 'Try again, or type your OSIS.' }, PROBLEM_MS);
        break;
      default:
        show({ tone: 'problem', title: 'That did not go through', body: answer.error ?? 'Scan again.' }, PROBLEM_MS);
    }
  }

  return (
    <KioskFrame
      title={eventName}
      subtitle={`${groupName}, ${heldOnLabel}`}
      exitHref={`/groups/${groupId}/events/${eventId}`}
    >
      <div className="kiosk-stage" onPointerDown={() => window.setTimeout(focusField, 0)}>
        <form className="kiosk-scan" onSubmit={submit} autoComplete="off">
          <label className="kiosk-prompt" htmlFor="kiosk-key">
            Scan your ID or type your OSIS
          </label>
          <input
            ref={input}
            type="text"
            id="kiosk-key"
            className="kiosk-input mono"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            aria-describedby="kiosk-count"
          />
          <p className="kiosk-hint">Then press Enter.</p>
        </form>
        <p className="kiosk-count" id="kiosk-count">
          <span className="num">{present}</span> of <span className="num">{memberCount}</span> checked in
        </p>
        <KioskMessage notice={notice} />
      </div>
    </KioskFrame>
  );
}
