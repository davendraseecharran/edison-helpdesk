'use client';

/**
 * The open screen notices a colleague's change and refreshes itself.
 *
 * `app_change_stamps` holds one version per area of the desk, moved by the
 * database on every write. This watches its updates over Realtime — the
 * transport the phone scanner's relay already uses — and, a moment after an
 * area this screen shows has moved, refreshes the page in place (the router
 * keeps what is typed and what is open). Tickets refresh every screen, because
 * the rail's counts are tickets. A change to the directory or the inventory
 * also re-reads the palette's search index.
 *
 * A dropped socket falls back to reading the same rows every 45 seconds, from
 * the browser straight to the database (no server function in between).
 * Nothing refreshes while the tab is hidden; coming back catches up.
 */

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useRuntime } from '@/components/AppRuntime';
import { browserClient } from '@/lib/supabase/browser';
import { warmSearchIndex } from '@/lib/lookup/local-store';
import { areasForPath, type ChangeArea } from '@/lib/domain/live-changes';

const SETTLE_MS = 1200;
const POLL_MS = 45_000;

export function LiveChanges() {
  const router = useRouter();
  const pathname = usePathname();
  const { actor } = useRuntime();
  // Read when a change lands, so a navigation does not re-open the socket.
  const path = useRef(pathname);
  useEffect(() => {
    path.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const seen = new Map<string, number>();
    let pending = false;
    let reindex = false;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setTimeout> | null = null;
    let doorbell: ReturnType<typeof setTimeout> | null = null;
    let live = false;
    let stopped = false;
    const supabase = browserClient();

    const flush = () => {
      settle = null;
      if (document.visibilityState !== 'visible') return;
      if (reindex) void warmSearchIndex(actor.id, true);
      if (pending) router.refresh();
      pending = false;
      reindex = false;
    };

    const note = (area: string, version: number) => {
      const before = seen.get(area);
      seen.set(area, version);
      if (before === undefined || version <= before) return;
      if (area === 'inventory' || area === 'directory') reindex = true;
      if (area === 'tickets' || areasForPath(path.current).includes(area as ChangeArea)) {
        pending = true;
      }
      if ((pending || reindex) && !settle) settle = setTimeout(flush, SETTLE_MS);
    };

    const read = async () => {
      const { data } = await supabase.from('app_change_stamps').select('area, version');
      for (const row of data ?? []) {
        if (typeof row.area === 'string' && typeof row.version === 'number') {
          note(row.area, row.version);
        }
      }
    };

    const schedule = () => {
      if (stopped || live) return;
      poll = setTimeout(async () => {
        if (document.visibilityState === 'visible') await read().catch(() => {});
        schedule();
      }, POLL_MS);
    };

    void read().catch(() => {});
    schedule();

    const channel = supabase
      .channel('desk-changes')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'app_change_stamps' },
        // A doorbell, not the news. Realtime checks the row's policy with a
        // narrower set of claims than the API does and can hand over an event
        // with the record stripped ("Error 401"); either way the rows are read
        // back through the API, where the account's own policy applies.
        () => {
          if (doorbell) return;
          doorbell = setTimeout(() => {
            doorbell = null;
            void read().catch(() => {});
          }, 250);
        },
      )
      .subscribe((status) => {
        if (stopped) return;
        live = status === 'SUBSCRIBED';
        // Readable in the page for a support check: live, or polling.
        document.documentElement.dataset.liveChanges = live ? 'live' : 'polling';
        if (poll) clearTimeout(poll);
        if (live) void read().catch(() => {});
        else schedule();
      });

    const onVisible = () => {
      if (document.visibilityState === 'visible' && (pending || reindex) && !settle) flush();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      if (settle) clearTimeout(settle);
      if (poll) clearTimeout(poll);
      if (doorbell) clearTimeout(doorbell);
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [router, actor.id]);

  return null;
}
