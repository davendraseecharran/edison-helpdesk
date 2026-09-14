'use client';

/**
 * Today: the screen a session lands on.
 *
 * It answers one question — what should I do next — and it answers it in the
 * order a NetRider would ask it: who you are, how much is waiting, what the
 * first thing is, and one key to do it with. Everything else on the screen is
 * a link to a list somebody already knows how to read.
 *
 * The ranking is not decided here (`src/lib/domain/today.ts`), the wording is
 * not decided here (`src/lib/voice/moments.ts`), and the keys are not decided
 * here (`src/lib/lists/keys.ts`). This file is the arrangement: what is on the
 * page, in what order, and what a press does.
 *
 * Two pieces of state it keeps for itself. It watches the count of things
 * needing you and marks the moment it reaches zero, because a queue you
 * emptied while you were looking at it is the one win this application gets to
 * acknowledge. And it remembers, per browser, whether this account has been
 * here before, so a first sign-in is told the one keyboard shortcut worth
 * knowing and nobody else ever sees that line again.
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRuntime } from '@/components/AppRuntime';
import { Button, ButtonLink } from '@/components/ui/Button';
import { useApplePlatform, useReducedMotion } from '@/components/ui/media';
import { useRowKeys } from '@/components/ui/useRowKeys';
import { claimTicketAction } from '@/lib/data/actions';
import { ageLabel } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { ListAction } from '@/lib/lists/keys';
import {
  briefingSentence,
  NEED_LABELS,
  needsCount,
  needsYou,
  nextBestAction,
  type Briefing,
  type NeedItem,
} from '@/lib/domain/today';
import { PRIORITY_LABELS } from '@/lib/domain/types';
import { greetingMoment, isFridayAfternoon, say, voiceLine } from '@/lib/voice/moments';
import '@/styles/lists.css';
import '@/styles/today.css';
import '@/styles/voice.css';

/** The session flag the entrance reads. Written by the page's blocking script too. */
export const TODAY_SEEN_KEY = 'edison.today.seen';

function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * The queue's age, one token wide.
 *
 * `ageLabel` says "just now", which is three times the width of "9m" and makes
 * the column jump as rows age past a minute. Here the column has to hold still
 * while the eye runs down it, so the newest rows read as "now".
 */
function shortAge(since: string, at: Date): string {
  const label = ageLabel(since, at);
  return label === 'just now' ? 'now' : label;
}

/** Per browser, per account: whether this person has landed here before. */
function welcomeKey(accountId: string): string {
  return `edison.today.welcomed.${accountId}`;
}

export interface TodayScreenProps {
  briefing: Briefing & { ok?: boolean };
  /** The request clock, so the first paint's ages match the server's. */
  now: number;
  /** What to call the reader. Their first name, not their login. */
  firstName: string;
  /** School-local hour and weekday, computed on the server so both renders agree. */
  hour: number;
  weekday: number;
  /** Whether this account works tickets at all. A skills officer sees no queue. */
  ticketWorker: boolean;
  /** Whether the pending-access row is worth offering. */
  admin: boolean;
}

export function TodayScreen({
  briefing,
  now: renderedAt,
  firstName,
  hour,
  weekday,
  ticketWorker,
  admin,
}: TodayScreenProps) {
  const { pendingKey, run } = useRuntime();
  const router = useRouter();
  const tick = useNow();
  const now = new Date(tick ?? renderedAt);
  const reduced = useReducedMotion();
  const mac = useApplePlatform();

  const items = useMemo(() => needsYou(briefing), [briefing]);
  const total = needsCount(briefing.counts);

  /*
   * The entrance, suppressed on a revisit.
   *
   * A layout effect rather than an ordinary one: it runs before the browser
   * paints the newly inserted markup, which is the only moment at which
   * switching a CSS animation off is still switching it off rather than
   * cutting it short. That covers every in-app return to Today, which is the
   * case the rule is for: queue, ticket, back to Today, three times an hour.
   *
   * A full page load still plays it, and should. Hydration is far too late to
   * stop an animation that started at first paint, and the only thing that
   * would be early enough is a blocking script — which React re-renders on the
   * client, warns about, and does not execute anyway. It is also the right
   * answer: a reload is the application arriving, the same moment the bench
   * lamp is drawn for, and the two belong together.
   */
  useLayoutEffect(() => {
    try {
      const root = document.documentElement;
      if (window.sessionStorage.getItem(TODAY_SEEN_KEY)) root.setAttribute('data-today-seen', '');
      else window.sessionStorage.setItem(TODAY_SEEN_KEY, '1');
    } catch {
      // Storage refused. The entrance simply plays; it is 300ms.
    }
  }, []);

  /*
   * The queue reaching zero while you are looking at it.
   *
   * Only that: the screen arriving already empty is the ordinary empty state
   * and gets the ordinary line. This is the transition, which happens a
   * handful of times a term and is the one moment worth a mark.
   */
  const [previousTotal, setPreviousTotal] = useState(total);
  const [cleared, setCleared] = useState(false);
  if (previousTotal !== total) {
    // Adjusted during render rather than in an effect: the mark and the empty
    // list have to arrive in the same paint, or the screen briefly says
    // "nothing needs you" in the ordinary voice and then corrects itself.
    setPreviousTotal(total);
    setCleared(total === 0 && previousTotal > 0);
  }

  const claim = useCallback(
    async (item: NeedItem) => {
      if (!item.ticketId) return;
      await run(`claim:${item.ticketId}`, () => claimTicketAction(item.ticketId!));
    },
    [run],
  );

  const can = useCallback((action: ListAction, item: NeedItem) => {
    if (action === 'open') return true;
    if (action === 'claim') return item.claimable;
    // Resolving and editing belong to the ticket itself; from here they are a
    // navigation with intent rather than a change made blind from a summary.
    return item.ticketId !== null;
  }, []);

  const onAction = useCallback(
    (action: ListAction, item: NeedItem) => {
      if (action === 'claim') {
        void claim(item);
        return;
      }
      if (action === 'resolve' && item.ticketId) {
        router.push(`${item.href}?do=resolve`);
        return;
      }
      router.push(item.href);
    },
    [claim, router],
  );

  const keys = useRowKeys<NeedItem>({ rows: items, keyOf: (item) => item.key, onAction, can });

  const greeting = voiceLine(greetingMoment(hour), { name: firstName, hour, weekday }).text;
  const sentence = briefingSentence(briefing.counts);
  const friday = isFridayAfternoon({ weekday, hour })
    ? say('friday.afternoon', { hour, weekday })
    : null;

  return (
    <div className="today">
      <header className="today-stage today-greet">
        <h1 className="today-hello">{greeting}</h1>
        {total > 0 ? (
          <p className="today-brief">
            {sentence}
            {friday ? <span className="today-aside-line"> {friday}</span> : null}
          </p>
        ) : (
          <p className="today-brief">
            {briefing.ok === false
              ? 'The briefing could not be read just now. The queue still works.'
              : friday ?? 'Nothing is waiting on you.'}
          </p>
        )}
        <FirstVisitNote mac={mac} name={firstName} />
      </header>

      <section className="today-stage today-needs" aria-labelledby="today-needs-heading">
        <div className="today-needs-head">
          <h2 id="today-needs-heading">Needs you</h2>
          {items.length > 0 ? (
            <p className="today-keys" aria-hidden="true">
              <span>
                <kbd className="kbd">j</kbd>
                <kbd className="kbd">k</kbd> move
              </span>
              <span>
                <kbd className="kbd">o</kbd> open
              </span>
              <span>
                <kbd className="kbd">c</kbd> claim
              </span>
              <span>
                <kbd className="kbd">r</kbd> resolve
              </span>
            </p>
          ) : null}
        </div>

        {items.length === 0 ? (
          <ClearState briefing={briefing} cleared={cleared} reduced={reduced} hour={hour} weekday={weekday} />
        ) : (
          <ul className="today-list" {...keys.listProps}>
            {items.map((item, index) => (
              <li key={item.key}>
                <div className="today-row" {...keys.rowProps(item.key)}>
                  <span className="today-row-main">
                    <span className="today-row-title">
                      <Link href={item.href} tabIndex={-1}>
                        {item.title}
                      </Link>
                      {item.number ? <span className="today-row-number">{item.number}</span> : null}
                    </span>
                    <span className="today-row-sub">
                      {/* The person first, because a name is the thing you
                          recognise. The kind is dropped on a row that carries a
                          Claim button: the button already says "unclaimed", and
                          a word beside a button that means the same word is the
                          easiest thing on this screen to delete. */}
                      <span>{item.subtitle}</span>
                      {item.claimable ? null : (
                        <span className="today-row-kind">{NEED_LABELS[item.kind]}</span>
                      )}
                      {item.priority === 'urgent' || item.priority === 'high' ? (
                        <span className="today-row-flag" data-priority={item.priority}>
                          {PRIORITY_LABELS[item.priority]}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="today-row-age">{shortAge(item.since, now)}</span>
                  <span className="today-row-action">
                    {item.claimable && item.ticketId ? (
                      <Button
                        size="sm"
                        // The one action the screen is actually asking for is
                        // the first row's. The rest are quiet, which is what
                        // lets the first one mean anything.
                        variant={index === 0 ? 'accent' : 'secondary'}
                        disabled={pendingKey !== null}
                        loading={pendingKey === `claim:${item.ticketId}`}
                        onClick={() => void claim(item)}
                      >
                        Claim
                      </Button>
                    ) : (
                      <ButtonLink
                        size="sm"
                        variant={index === 0 ? 'accent' : 'secondary'}
                        href={item.href}
                      >
                        {item.kind === 'access' ? 'Review' : 'Open'}
                      </ButtonLink>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav className="today-stage today-ledger" aria-label="Where the rest of the work is">
        {ticketWorker ? (
          <Link className="today-ledger-item" href="/my-tickets">
            <b>{briefing.counts.mine}</b>
            <span>{briefing.counts.mine === 1 ? 'ticket you own' : 'tickets you own'}</span>
          </Link>
        ) : null}
        {ticketWorker ? (
          <Link className="today-ledger-item" href="/queue">
            <b>{briefing.counts.unassigned}</b>
            <span>in the queue</span>
          </Link>
        ) : null}
        {/* A measure reading nothing is not news. The row shrinks instead of
            printing a zero and a label explaining the zero. */}
        {admin && briefing.counts.accessRequests > 0 ? (
          <Link className="today-ledger-item" href="/admin">
            <b>{briefing.counts.accessRequests}</b>
            <span>waiting for access</span>
          </Link>
        ) : null}
      </nav>
    </div>
  );
}

/**
 * Nothing needs you.
 *
 * Two different sentences for two different facts. Arriving at an empty desk
 * is the ordinary empty state. Emptying it while you were sitting there is a
 * win, and it is one of exactly two moments in this application allowed a
 * piece of motion: 300ms, opacity and eight pixels, once, and never under
 * reduced motion.
 */
function ClearState({
  briefing,
  cleared,
  reduced,
  hour,
  weekday,
}: {
  briefing: Briefing;
  cleared: boolean;
  reduced: boolean;
  hour: number;
  weekday: number;
}) {
  const next = nextBestAction(briefing.counts);
  const line = say(cleared ? 'queue.cleared' : 'today.empty', { hour, weekday });
  return (
    <div className={cleared && !reduced ? 'today-clear voice-mark' : 'today-clear'}>
      <p className="today-clear-lead">{line}</p>
      <ButtonLink variant="accent" href={next.href}>
        {next.label}
      </ButtonLink>
    </div>
  );
}

/**
 * The first time this account lands here in this browser.
 *
 * Two lines: a welcome, and the one keyboard shortcut worth knowing. It is
 * written once and never shown again, which is the only reason it is allowed
 * to take up space at all. Rendered after mount because the answer lives in
 * this browser's storage; it is additive rather than a swap, so appearing a
 * frame late moves nothing that was already read.
 */
function FirstVisitNote({ mac, name }: { mac: boolean; name: string }) {
  const { actor } = useRuntime();
  const [dismissed, setDismissed] = useState(false);

  /*
   * Read through `useSyncExternalStore` rather than in an effect, so the server
   * snapshot is "already welcomed" and the note is simply absent from the first
   * paint. A note that appears and then disappears is worse than one that
   * appears a frame late.
   */
  const welcomed = useSyncExternalStore(
    subscribeToNothing,
    () => {
      try {
        return window.localStorage.getItem(welcomeKey(actor.id)) !== null;
      } catch {
        // Storage refused: the note is a nicety, not a step, so it is skipped.
        return true;
      }
    },
    () => true,
  );

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(welcomeKey(actor.id), '1');
    } catch {
      // Then it is offered once more next time, which is the harmless failure.
    }
  }, [actor.id]);

  if (welcomed || dismissed) return null;
  const line = voiceLine('signin.first', { name, key: mac ? '⌘K' : 'Ctrl K' });
  return (
    <div className="today-welcome">
      <p className="today-welcome-text">
        <strong>{line.text}</strong>
        {line.follow}
      </p>
      <Button size="sm" variant="ghost" onClick={dismiss}>
        Got it
      </Button>
    </div>
  );
}
