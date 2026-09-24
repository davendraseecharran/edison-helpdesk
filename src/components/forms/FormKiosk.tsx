'use client';

/**
 * A form at a door: scan in, find your details already written, answer the
 * rest, and hand the device to the next person.
 *
 * The signed-in account holding the device vouches for the lookup, so a card
 * alone is enough — no email to type on somebody else's tablet. The answers
 * are recorded as taken at this kiosk, by this account.
 *
 * Privacy at a shared screen: a form left half-answered goes back to the start
 * after ninety seconds without a touch, and the guardian's number is masked
 * here exactly as it is on the public link.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { kioskIdentifyAction, kioskSubmitAction } from '@/lib/data/form-actions';
import {
  answerErrors,
  initialAnswers,
  type AnswerValue,
  type Answers,
  type FormAudience,
  type FormField,
} from '@/lib/domain/forms';
import { Button } from '@/components/ui/Button';
import { FormRenderer, focusQuestion } from './FormRenderer';
import { KioskFrame } from './KioskFrame';
import { KioskMessage, type KioskNotice } from './KioskMessage';

const IDLE_MS = 90_000;
const DONE_MS = 2600;

type Phase = 'scan' | 'answer';

interface Person {
  requesterId: string | null;
  firstName: string;
  already: boolean;
  prefill: Record<string, string>;
  masked: Record<string, string>;
}

export function FormKiosk({
  formId,
  title,
  description,
  audience,
  fields,
  open,
}: {
  formId: string;
  title: string;
  description: string;
  audience: FormAudience;
  fields: FormField[];
  open: boolean;
}) {
  const scanInput = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('scan');
  const [key, setKey] = useState('');
  const [person, setPerson] = useState<Person | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<KioskNotice | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);
  const [round, setRound] = useState(0);

  const reset = useCallback(() => {
    setPhase('scan');
    setPerson(null);
    setAnswers({});
    setErrors({});
    setProblem(null);
    setKey('');
    setRound((value) => value + 1);
    window.setTimeout(() => scanInput.current?.focus({ preventScroll: true }), 0);
  }, []);

  // A half-answered form on a shared screen does not wait for the next person.
  const touch = useCallback(() => {
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      idleTimer.current = null;
      reset();
    }, IDLE_MS);
  }, [reset]);

  useEffect(() => {
    if (phase !== 'answer') return;
    touch();
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
  }, [phase, touch]);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  function flash(next: KioskNotice) {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, DONE_MS);
  }

  function begin(next: Person) {
    setPerson(next);
    setAnswers(initialAnswers(fields, next.prefill, next.masked));
    setErrors({});
    setProblem(null);
    setPhase('answer');
    window.scrollTo({ top: 0 });
  }

  async function identify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = key.trim();
    setKey('');
    if (value === '' || pending) return;
    setPending(true);
    setProblem(null);
    try {
      const result = await kioskIdentifyAction(formId, value);
      if (result.outcome === 'match') {
        begin({
          requesterId: result.requesterId,
          firstName: result.firstName,
          already: result.already,
          prefill: result.prefill,
          masked: result.masked,
        });
      } else {
        setProblem(result.message);
      }
    } catch {
      setProblem('That did not go through. Check the connection, then scan again.');
    } finally {
      setPending(false);
    }
  }

  function change(id: string, value: AnswerValue) {
    touch();
    setAnswers((current) => ({ ...current, [id]: value }));
    if (errors[id]) {
      setErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    touch();
    const found = answerErrors(fields, answers);
    setErrors(found);
    const first = fields.find((field) => found[field.id]);
    if (first) {
      setProblem('Some answers need another look.');
      focusQuestion('kiosk', first.id);
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const result = await kioskSubmitAction(formId, person?.requesterId ?? null, answers);
      if (!result.ok) {
        setProblem(result.message);
        return;
      }
      const name = result.firstName ?? person?.firstName ?? '';
      flash({
        tone: 'welcome',
        title: name ? `Thanks, ${name}` : 'Thanks',
        body: result.updated ? 'Your answers were updated.' : 'Your answers were sent.',
        key: Date.now(),
      });
      reset();
    } catch {
      setProblem('That did not go through. Nothing was sent. Try again.');
    } finally {
      setPending(false);
    }
  }

  const exitHref = `/forms/${formId}/responses`;

  if (!open) {
    return (
      <KioskFrame title={title} subtitle="Kiosk" exitHref={exitHref}>
        <div className="kiosk-stage">
          <p className="kiosk-prompt">This form is closed</p>
          <p className="kiosk-hint">Open it again from its settings to take answers here.</p>
        </div>
      </KioskFrame>
    );
  }

  return (
    <KioskFrame title={title} subtitle="Kiosk" exitHref={exitHref}>
      {phase === 'scan' ? (
        <div className="kiosk-stage" key={round}>
          <form className="kiosk-scan" onSubmit={identify} autoComplete="off">
            <label className="kiosk-prompt" htmlFor="kiosk-form-key">
              Scan your ID or type your OSIS
            </label>
            <input
              ref={scanInput}
              type="text"
              id="kiosk-form-key"
              className="kiosk-input mono"
              value={key}
              autoFocus
              disabled={pending}
              onChange={(event) => setKey(event.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="go"
              aria-describedby={problem ? 'kiosk-form-problem' : undefined}
            />
            {problem ? (
              <p className="kiosk-inline-problem" id="kiosk-form-problem" role="alert">
                {problem}
              </p>
            ) : (
              <p className="kiosk-hint">Your details fill themselves in.</p>
            )}
          </form>
          {audience === 'anyone' ? (
            <Button
              variant="ghost"
              onClick={() => begin({ requesterId: null, firstName: '', already: false, prefill: {}, masked: {} })}
            >
              Answer without an ID
            </Button>
          ) : null}
          <KioskMessage notice={notice} />
        </div>
      ) : (
        <form className="kiosk-answer" onSubmit={send} noValidate onPointerDown={touch} onKeyDown={touch}>
          <div className="kiosk-answer-head">
            <p className="kiosk-greeting">{person?.firstName ? `Hi, ${person.firstName}.` : 'Hi.'}</p>
            <p className="kiosk-hint">
              {person?.already
                ? 'You have answered this before. Sending again replaces those answers.'
                : person?.requesterId
                  ? 'Your details are filled in from the directory. Change anything that is out of date.'
                  : description || 'Answer the questions below.'}
            </p>
          </div>
          <div className="pf-card kiosk-card">
            <FormRenderer
              fields={fields}
              answers={answers}
              onChange={change}
              prefill={person?.prefill ?? {}}
              masked={person?.masked ?? {}}
              errors={errors}
              disabled={pending}
              reveal
              idPrefix="kiosk"
              size="large"
            />
          </div>
          {problem ? (
            <p className="pf-problem" role="alert">
              {problem}
            </p>
          ) : null}
          <div className="kiosk-answer-actions">
            <Button icon={ArrowLeft} size="lg" onClick={reset} disabled={pending}>
              Start over
            </Button>
            <Button type="submit" variant="primary" size="lg" loading={pending}>
              Send answers
            </Button>
          </div>
        </form>
      )}
    </KioskFrame>
  );
}
