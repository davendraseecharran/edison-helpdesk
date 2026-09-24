'use client';

/**
 * `/c/<slug>`: somebody scanned the poster on the door.
 *
 * One card and one button. The card asks for exactly what the event's setting
 * asks for — an OSIS, a name, either, or both — in boxes a phone fills
 * without zooming, and a name box that lets the phone's own autofill offer the
 * owner's name, which on a student's own phone is nearly always right.
 *
 * Two people with one name is a real Tuesday. With `either`, the answer to
 * that is not an error but the next question: the OSIS box appears under the
 * name, and the second press sends both, which have to be the same person.
 *
 * The one moment on the page is the answer: a ring closes, a tick is written,
 * and the first name rises into "You're checked in, Nia." Nothing else moves.
 *
 * The honeypot is an ordinary-looking field a person never sees and a script
 * fills; the server treats a filled one as a name nobody has.
 */

import { useRef, useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { publicCheckinAction } from '@/lib/data/public-checkin-actions';
import {
  asksFor,
  inputProblem,
  type CheckinIdentity,
  type CheckinInput,
} from '@/lib/domain/checkin';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { CheckDraw } from '@/components/forms/CheckDraw';

type Mode = 'name' | 'osis';

type Done = { outcome: 'present' | 'already'; firstName: string };

export function PublicCheckin({
  slug,
  eventName,
  groupName,
  dateLabel,
  identity,
}: {
  slug: string;
  eventName: string;
  groupName: string;
  dateLabel: string;
  identity: CheckinIdentity;
}) {
  const [mode, setMode] = useState<Mode>('name');
  const [input, setInput] = useState<CheckinInput>({ osis: '', first: '', last: '' });
  const [honeypot, setHoneypot] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // With `either` on the name, a shared name opens the OSIS box under it.
  const [needOsis, setNeedOsis] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const osisBox = useRef<HTMLInputElement>(null);
  const firstBox = useRef<HTMLInputElement>(null);

  const base = asksFor(identity);
  const showName = identity === 'either' ? mode === 'name' : base.name;
  const showOsis = identity === 'either' ? mode === 'osis' || needOsis : base.osis;

  function set(key: keyof CheckinInput, value: string) {
    setInput((current) => ({ ...current, [key]: value }));
    if (problem) setProblem(null);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setProblem(null);
    setNeedOsis(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const missing = inputProblem(identity, input, mode);
    if (missing) {
      setProblem(missing);
      return;
    }
    if (needOsis && input.osis.trim() === '') {
      setProblem('Add your OSIS to tell you apart.');
      osisBox.current?.focus();
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const result = await publicCheckinAction(
        slug,
        needOsis || identity !== 'either' || mode === 'osis' ? input : { ...input, osis: '' },
        { identity, groupName, mode },
        honeypot,
      );
      if (result.ok) {
        setDone({ outcome: result.outcome, firstName: result.firstName });
        window.scrollTo({ top: 0 });
        return;
      }
      if (result.reason === 'ambiguous' && identity === 'either' && mode === 'name') {
        setNeedOsis(true);
        setProblem(result.message);
        // After the box exists.
        window.requestAnimationFrame(() => osisBox.current?.focus());
        return;
      }
      setProblem(result.message);
    } catch {
      setProblem('That did not go through. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  if (done) {
    const name = done.firstName.trim();
    return (
      <section className="ci-done" aria-live="polite">
        <CheckDraw size={88} className="ci-check" />
        <h1 className="ci-done-title">
          {done.outcome === 'present'
            ? name
              ? `You’re checked in, ${name}.`
              : 'You’re checked in.'
            : 'Already checked in'}
        </h1>
        <p className="ci-done-body">
          {done.outcome === 'present'
            ? `${eventName}, ${dateLabel}.`
            : `${name ? `${name}, you` : 'You'} were already on the list for ${eventName}.`}
        </p>
        <p className="ci-done-foot">You can close this page.</p>
      </section>
    );
  }

  return (
    <>
      <header className="ci-head">
        {groupName ? <p className="ci-group">{groupName}</p> : null}
        <h1 className="ci-title">{eventName}</h1>
        <p className="ci-date">{dateLabel}</p>
      </header>

      <form className="ci-card" onSubmit={submit} noValidate>
        <div className="ci-card-head">
          <h2 className="ci-card-title">Check in</h2>
          {identity === 'either' ? (
            <SegmentedControl<Mode>
              label="Check in with"
              size="sm"
              value={mode}
              onChange={switchMode}
              options={[
                { value: 'name', label: 'My name' },
                { value: 'osis', label: 'My OSIS' },
              ]}
            />
          ) : null}
        </div>

        <div className="ci-fields">
          {showName ? (
            <div className="ci-name-row">
              <div className="field">
                <label className="field-label" htmlFor="ci-first">
                  First name
                </label>
                <input
                  ref={firstBox}
                  id="ci-first"
                  type="text"
                  autoComplete="given-name"
                  autoCapitalize="words"
                  spellCheck={false}
                  enterKeyHint="next"
                  maxLength={80}
                  value={input.first}
                  disabled={pending}
                  onChange={(event) => set('first', event.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="ci-last">
                  Last name
                </label>
                <input
                  id="ci-last"
                  type="text"
                  autoComplete="family-name"
                  autoCapitalize="words"
                  spellCheck={false}
                  enterKeyHint={showOsis ? 'next' : 'go'}
                  maxLength={80}
                  value={input.last}
                  disabled={pending}
                  onChange={(event) => set('last', event.target.value)}
                />
              </div>
            </div>
          ) : null}
          {showOsis ? (
            <div className="field ci-osis" data-added={needOsis || undefined}>
              <label className="field-label" htmlFor="ci-osis">
                {identity === 'osis' || identity === 'both' || mode === 'osis' ? 'OSIS' : 'Your OSIS'}
              </label>
              <input
                ref={osisBox}
                id="ci-osis"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="go"
                maxLength={40}
                placeholder="9 digits"
                value={input.osis}
                disabled={pending}
                onChange={(event) => set('osis', event.target.value)}
              />
              <span className="field-hint">Staff: your staff ID.</span>
            </div>
          ) : null}

          {/* Not for people. Hidden from sight and from assistive technology,
              skipped by the keyboard, and refused by autofill. */}
          <div className="pf-trap" aria-hidden="true">
            <label htmlFor="ci-website">Website</label>
            <input
              id="ci-website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={honeypot}
              onChange={(event) => setHoneypot(event.target.value)}
            />
          </div>
        </div>

        {problem ? (
          <p className="ci-problem" role="alert">
            {problem}
          </p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" block loading={pending} className="ci-submit">
          Check in
        </Button>

        {needOsis ? (
          <button
            type="button"
            className="pf-not-me ci-back"
            onClick={() => {
              setNeedOsis(false);
              setProblem(null);
              set('osis', '');
              firstBox.current?.focus();
            }}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Change the name
          </button>
        ) : null}
      </form>
    </>
  );
}
