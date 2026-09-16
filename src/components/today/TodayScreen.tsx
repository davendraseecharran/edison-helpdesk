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
 * One line on the page has two authors. The sentence under the greeting is the
 * library's, rendered on the server and correct on its own; when the reader has
 * connected their own ChatGPT, `useAssistantLine` asks it for the same fact in
 * better words once the page is already readable, and swaps the line in if an
 * answer comes back. Nothing waits for it and nothing reports its absence.
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
import { useApplePlatform, usePhone, useReducedMotion } from '@/components/ui/media';
import { useRowKeys } from '@/components/ui/useRowKeys';
import { claimTicketsAction } from '@/lib/data/actions';
import { markDeviceAvailableAction, returnDeviceAction } from '@/lib/data/device-actions';
import { ageLabel } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import type { ListAction } from '@/lib/lists/keys';
import {
  DUE_LABELS,
  briefingSentence,
  deviceCode,
  deviceTitle,
  devicesDue,
  devicesDueSentence,
  needsCount,
  needsYou,
  nextBestAction,
  type Briefing,
  type DueDevice,
  type NeedItem,
} from '@/lib/domain/today';
import { AVAILABLE_STATUS, PRIORITY_LABELS } from '@/lib/domain/types';
import { greetingMoment, isFridayAfternoon, say, voiceLine } from '@/lib/voice/moments';
import { useAssistantLine } from './useAssistantLine';
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

/**
 * One row of the page's keyboard, whichever section it is drawn in.
 *
 * Both lists share a single `useRowKeys`, because the hook binds a document
 * listener and two of them would answer the same `j`.
 */
type TodayRow =
  | { kind: 'need'; key: string; need: NeedItem }
  | { kind: 'device'; key: string; device: DueDevice };

/**
 * What the button on a machine says.
 *
 * A machine somebody still holds is RETURNED: the holder is cleared and the
 * hand-back is written into the inventory's history, which is the record
 * somebody will want in June. A machine on the bench that nobody holds has
 * nothing to return, so the honest action is the one it actually performs.
 */
function dueAction(device: DueDevice): string {
  return device.holderName ? 'Return' : 'Mark available';
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
  const due = useMemo(() => devicesDue(briefing), [briefing]);
  const total = needsCount(briefing.counts);

  /*
   * One keyboard for the page, not one per section.
   *
   * `useRowKeys` binds a document listener, so two of them would both answer
   * `j`. The rows of both lists go into one model instead, which is also the
   * honest reading of the rule this application already keeps: the same keys
   * mean the same things everywhere. `r` finishes the row you are on — resolve
   * a ticket, return a machine — and `o` opens it.
   */
  const rows = useMemo<TodayRow[]>(
    () => [
      ...items.map((need) => ({ kind: 'need' as const, key: need.key, need })),
      ...due.map((device) => ({ kind: 'device' as const, key: `device:${device.id}`, device })),
    ],
    [items, due],
  );

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
      if (item.ticketIds.length === 0) return;
      // A row that stands for five reports of one dead projector claims all
      // five. That is the whole reason it is one row.
      await run(`claim:${item.key}`, () => claimTicketsAction(item.ticketIds));
    },
    [run],
  );

  /**
   * Take a machine back, from the row it is on.
   *
   * One press, no form: the status it returns to is Available, which is what
   * every one of these is. Either way the version the row was rendered at goes
   * with the call, so a machine somebody else assigned while this screen was
   * open is refused with the inventory's own words rather than quietly
   * overwritten.
   */
  const returnDevice = useCallback(
    async (device: DueDevice) => {
      await run(`return:${device.id}`, () =>
        device.holderName
          ? returnDeviceAction(device.id, AVAILABLE_STATUS, null, device.version)
          : // Nobody holds it, so there is nobody to take it back from:
            // `app_return_inventory_device` refuses an unassigned machine, and
            // rightly. What this one needs is its status put right, through the
            // owner's editor — the bulk RPC takes no version, and one machine
            // changed by one press deserves the lock every other edit gets.
            markDeviceAvailableAction(device.id, device.version, AVAILABLE_STATUS),
      );
    },
    [run],
  );

  const can = useCallback((action: ListAction, row: TodayRow) => {
    if (row.kind === 'device') {
      // `r` returns it, `o` opens the machine. There is nothing here to claim
      // and nothing to edit from a summary.
      return action === 'resolve' || action === 'open';
    }
    const item = row.need;
    if (action === 'open') return true;
    if (action === 'claim') return item.claimable;
    // Resolving and editing belong to the ticket itself; from here they are a
    // navigation with intent rather than a change made blind from a summary.
    return item.ticketId !== null;
  }, []);

  const onAction = useCallback(
    (action: ListAction, row: TodayRow) => {
      if (row.kind === 'device') {
        if (action === 'resolve') void returnDevice(row.device);
        else router.push(`/devices/${row.device.id}`);
        return;
      }
      const item = row.need;
      if (action === 'claim') {
        void claim(item);
        return;
      }
      if (action === 'resolve' && item.ticketId) {
        router.push(`${item.href}?do=resolve`);
        return;
      }
      // `e` means the same thing here as it does in the queue: open the ticket
      // with the note composer already revealed. One keyboard model, or none.
      if (action === 'edit' && item.ticketId) {
        router.push(`${item.href}?do=note`);
        return;
      }
      router.push(item.href);
    },
    [claim, returnDevice, router],
  );

  const keys = useRowKeys<TodayRow>({ rows, keyOf: (row) => row.key, onAction, can });

  const greeting = voiceLine(greetingMoment(hour), { name: firstName, hour, weekday }).text;
  const library = briefingSentence(briefing.counts);
  /*
   * The same fact, said by the reader's own assistant instead.
   *
   * It is asked for after the page is painted and it is allowed to fail
   * silently, so `library` is what the server renders, what a reader with no
   * ChatGPT connection ever sees, and what is on screen for the second or two
   * before an answer arrives. The library sentence counts; the assistant's
   * names what the counts are made of.
   */
  const assistant = useAssistantLine(briefing.counts, briefing.ok !== false && total > 0);
  const sentence = assistant ?? library;
  const dueSentence = devicesDueSentence(briefing.counts);
  const friday = isFridayAfternoon({ weekday, hour })
    ? say('friday.afternoon', { hour, weekday })
    : null;

  return (
    /*
     * The briefing is published on the root element, the same way the ticket
     * page publishes which ticket is open: the assistant panel reads it when it
     * opens and uses it as its first line, so the panel and the screen say the
     * same thing. The page renders one attribute and knows nothing about the
     * panel.
     */
    /*
     * The page is the container the keyboard model measures, because both lists
     * share one model and the focus moves between them. The arrow handler is NOT
     * on the page: it calls `preventDefault`, and on the root that meant every
     * arrow press anywhere inside Today stopped scrolling the page and moving a
     * caret. It sits on the two lists, which is the only place arrows mean
     * "next row".
     */
    <div
      className="today"
      data-today-briefing={sentence || 'Nothing needs you right now.'}
      {...keys.containerProps}
    >
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
          <ul className="today-list" {...keys.arrowProps}>
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
                        <span className="today-row-kind">{item.state}</span>
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
                        loading={pendingKey === `claim:${item.key}`}
                        onClick={() => void claim(item)}
                      >
                        {item.count > 1 ? `Claim all ${item.count}` : 'Claim'}
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

      {/*
        * Machines due back.
        *
        * Not tickets, and deliberately not folded into "needs you": a
        * Chromebook a graduate still has is a fortnight's problem, not this
        * hour's, and mixing the two would make the number at the top of the
        * screen the one number people learn to discount. Its own section, its
        * own count, the same keyboard, and the action on the row.
        */}
      {due.length > 0 ? (
        <section className="today-stage today-due" aria-labelledby="today-due-heading">
          <div className="today-needs-head">
            <h2 id="today-due-heading">Devices due back</h2>
            <p className="today-keys" aria-hidden="true">
              <span>
                <kbd className="kbd">r</kbd> return
              </span>
            </p>
          </div>
          {dueSentence ? <p className="today-due-lead subtle">{dueSentence}</p> : null}
          <ul className="today-list" {...keys.arrowProps}>
            {due.map((device) => (
              <li key={device.id}>
                <div className="today-row" {...keys.rowProps(`device:${device.id}`)}>
                  <span className="today-row-main">
                    <span className="today-row-title">
                      <Link href={`/devices/${device.id}`} tabIndex={-1}>
                        {deviceTitle(device)}
                      </Link>
                      <span className="today-row-number">{deviceCode(device)}</span>
                    </span>
                    <span className="today-row-sub">
                      <span>{device.holderName ?? 'Nobody is holding it'}</span>
                      <span className="today-row-kind">{DUE_LABELS[device.reason]}</span>
                    </span>
                  </span>
                  <span className="today-row-age">{shortAge(device.since, now)}</span>
                  <span className="today-row-action">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pendingKey !== null}
                      loading={pendingKey === `return:${device.id}`}
                      onClick={() => void returnDevice(device)}
                    >
                      {dueAction(device)}
                    </Button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
  const line = voiceLine(cleared ? 'queue.cleared' : 'today.empty', { hour, weekday });
  return (
    <div className={cleared && !reduced ? 'today-clear voice-mark' : 'today-clear'}>
      <p className="today-clear-lead">{line.text}</p>
      {/* The lighter second line an empty queue carries: the desk being idle
          with you, which it is allowed to be only here. */}
      {line.follow ? <p className="today-clear-aside">{line.follow}</p> : null}
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
  const phone = usePhone();
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
  /*
   * A phone has no Ctrl K and no ⌘K, and this is the one visit where the reader
   * does not yet know what the application is — so it is the worst possible
   * place to name a key that is not there. Down there the palette lives behind
   * the Lookup button in the thumb's corner, and the line says so.
   */
  const line = phone
    ? voiceLine('signin.first.phone', { name })
    : voiceLine('signin.first', { name, key: mac ? '⌘K' : 'Ctrl K' });
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
