'use client';

/**
 * The week in review, offered once a week.
 *
 * A few seconds after the first page of a new school week has settled, this
 * asks the database to write last week's notice (it writes at most one a week,
 * and none for a week in which nothing happened). When one is written, a toast
 * says so and the bell counts it; the notice links to /summary for that week.
 * The browser remembers the week it asked for, so a busy Monday does not ask
 * on every page.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useRuntime } from '@/components/AppRuntime';
import { weeklyNudgeAction } from '@/lib/data/summary-actions';
import { weekStartOf } from '@/lib/domain/summary';

const KEY = 'edison.week-nudge';

export function WeeklyNudge() {
  const { notify, today } = useRuntime();
  const router = useRouter();

  useEffect(() => {
    const week = weekStartOf(today);
    try {
      if (window.localStorage.getItem(KEY) === week) return;
    } catch {
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        window.localStorage.setItem(KEY, week);
      } catch {
        // Nowhere to remember it; the database still writes one notice a week.
      }
      if (await weeklyNudgeAction()) {
        notify('success', 'Your week in review is ready. It is in your notifications.');
        router.refresh();
      }
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [today, notify, router]);

  return null;
}
