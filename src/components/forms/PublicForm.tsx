'use client';

/**
 * `/f/<slug>`: a form somebody opened from a poster, a message or a QR code.
 *
 * Three states and nothing else. Who you are (only for a directory form),
 * your answers, and sent. The identity step asks for two things the school
 * already holds together — a school email and an OSIS or staff ID — and when
 * they name the same person the form opens with everything the directory
 * knows already written in. A miss says one sentence whichever half was
 * wrong.
 *
 * The honeypot is an ordinary-looking field a person never sees and a script
 * fills. It is sent with both calls and the server treats a filled one as a
 * miss.
 */

import { useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { publicIdentifyAction, publicSubmitAction } from '@/lib/data/public-form-actions';
import {
  answerErrors,
  initialAnswers,
  type Answers,
  type AnswerValue,
  type FormAudience,
  type FormField,
} from '@/lib/domain/forms';
import { Button } from '@/components/ui/Button';
import { CheckDraw } from './CheckDraw';
import { FormRenderer, focusQuestion } from './FormRenderer';

type Step = 'identify' | 'answer' | 'sent';

export function PublicForm({
  slug,
  title,
  description,
  audience,
  fields,
}: {
  slug: string;
  title: string;
  description: string;
  audience: FormAudience;
  fields: FormField[];
}) {
  const [step, setStep] = useState<Step>(audience === 'directory' ? 'identify' : 'answer');
  const [email, setEmail] = useState('');
  const [externalId, setExternalId] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');
  const [already, setAlready] = useState(false);
  const [prefill, setPrefill] = useState<Record<string, string>>({});
  const [masked, setMasked] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const [updated, setUpdated] = useState(false);

  async function identify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (email.trim() === '' || externalId.trim() === '') {
      setProblem('Enter your school email and your OSIS or staff ID.');
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const result = await publicIdentifyAction(slug, email, externalId, honeypot);
      if (!result.ok) {
        setProblem(result.message);
        return;
      }
      setFirstName(result.firstName);
      setAlready(result.already);
      setPrefill(result.prefill);
      setMasked(result.masked);
      setAnswers(initialAnswers(fields, result.prefill, result.masked));
      setErrors({});
      setReveal(true);
      setStep('answer');
      // The page is now a different page; start it at the top.
      window.scrollTo({ top: 0 });
    } catch {
      setProblem('That did not go through. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  function change(id: string, value: AnswerValue) {
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
    const found = answerErrors(fields, answers);
    setErrors(found);
    const first = fields.find((field) => found[field.id]);
    if (first) {
      setProblem(null);
      focusQuestion('public', first.id);
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const result = await publicSubmitAction(slug, email, externalId, answers, honeypot);
      if (!result.ok) {
        if (result.reason === 'no_match') {
          // The directory changed under them, or the identity was edited away.
          setStep('identify');
        }
        setProblem(result.message);
        return;
      }
      setUpdated(result.updated);
      if (result.firstName) setFirstName(result.firstName);
      setStep('sent');
      window.scrollTo({ top: 0 });
    } catch {
      setProblem('That did not go through. Nothing was sent. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  function startOver() {
    setAnswers({});
    setErrors({});
    setProblem(null);
    setReveal(false);
    setStep(audience === 'directory' ? 'identify' : 'answer');
  }

  if (step === 'sent') {
    return (
      <section className="pf-sent" aria-live="polite">
        <CheckDraw size={72} />
        <h2 className="pf-sent-title">
          {updated ? 'Your answers were updated' : firstName ? `Thanks, ${firstName}` : 'Thanks'}
        </h2>
        <p className="pf-sent-body">
          {updated
            ? `We replaced the answers you sent before to ${title}.`
            : `Your answers to ${title} were sent.`}{' '}
          You can close this page.
        </p>
        {audience === 'anyone' ? (
          <Button variant="ghost" onClick={startOver}>
            Send another response
          </Button>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <header className="pf-head">
        <h1 className="pf-title">{title}</h1>
        {description ? <p className="pf-description">{description}</p> : null}
      </header>

      {step === 'identify' ? (
        <form className="pf-card pf-identify" onSubmit={identify} noValidate>
          <div className="pf-card-head">
            <h2 className="pf-card-title">First, who are you?</h2>
            <p className="pf-card-note">
              Your school email and your OSIS or staff ID. We use them to fill in what the school
              already has on file.
            </p>
          </div>
          <div className="pf-identify-fields">
            <div className="field">
              <label className="field-label" htmlFor="pf-email">
                School email
              </label>
              <input
                id="pf-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                maxLength={320}
                onChange={(event) => setEmail(event.target.value)}
                disabled={pending}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="pf-id">
                OSIS or staff ID
              </label>
              <input
                id="pf-id"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={externalId}
                maxLength={80}
                onChange={(event) => setExternalId(event.target.value)}
                disabled={pending}
              />
            </div>
            {/* Not for people. Hidden from sight and from assistive technology,
                skipped by the keyboard, and refused by autofill. */}
            <div className="pf-trap" aria-hidden="true">
              <label htmlFor="pf-website">Website</label>
              <input
                id="pf-website"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(event) => setHoneypot(event.target.value)}
              />
            </div>
          </div>
          {problem ? (
            <p className="pf-problem" role="alert">
              {problem}
            </p>
          ) : null}
          <div className="pf-actions">
            <Button type="submit" variant="primary" size="lg" loading={pending} className="pf-primary">
              Continue
            </Button>
          </div>
        </form>
      ) : (
        <form className="pf-answer" onSubmit={send} noValidate>
          {audience === 'directory' ? (
            <div className="pf-greeting">
              <p className="pf-greeting-line">{firstName ? `Hi, ${firstName}.` : 'Hi.'}</p>
              <p className="pf-greeting-note">
                {already
                  ? 'You have answered this form before. Sending it again replaces those answers.'
                  : 'We filled in what the school has on file. Change anything that is out of date.'}
              </p>
              <button type="button" className="pf-not-me" onClick={startOver} disabled={pending}>
                <ArrowLeft size={14} aria-hidden="true" />
                Not you?
              </button>
            </div>
          ) : null}

          <div className="pf-card">
            {fields.length === 0 ? (
              <p className="pf-card-note">This form has no questions yet.</p>
            ) : (
              <FormRenderer
                fields={fields}
                answers={answers}
                onChange={change}
                prefill={prefill}
                masked={masked}
                errors={errors}
                disabled={pending}
                reveal={reveal}
                idPrefix="public"
              />
            )}
            {audience === 'anyone' ? (
              <div className="pf-trap" aria-hidden="true">
                <label htmlFor="pf-website-2">Website</label>
                <input
                  id="pf-website-2"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={honeypot}
                  onChange={(event) => setHoneypot(event.target.value)}
                />
              </div>
            ) : null}
          </div>

          {problem || Object.keys(errors).length > 0 ? (
            <p className="pf-problem" role="alert">
              {problem ?? 'Some answers need another look.'}
            </p>
          ) : null}
          <div className="pf-actions">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={pending}
              disabled={fields.length === 0}
              className="pf-primary"
            >
              Send answers
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
