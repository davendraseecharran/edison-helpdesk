'use client';

/**
 * The desktop's end of the relay: scans arriving from the phone.
 *
 * Two ways in, deliberately, because neither alone is trustworthy enough for
 * a technician standing at a bench with a laptop in their hands:
 *
 *   - Supabase Realtime. An INSERT on `scan_events` filtered to this session
 *     arrives in milliseconds. Realtime applies `scan_events_select_own` per
 *     subscriber, so the filter is a convenience and the policy is what keeps
 *     another technician's codes off this socket.
 *   - A poll of `app_scan_events`, every two seconds until the channel says
 *     SUBSCRIBED and every fifteen after that. The fast cadence is not a
 *     pessimism about Realtime; it is that `[realtime] enabled = false` in the
 *     local stack, so a developer's machine is served entirely by the poll,
 *     and a school network that blocks websockets is served by it too. The
 *     slow cadence afterwards is the safety net for a socket that has gone
 *     quiet without saying so.
 *
 * The two overlap constantly and that is fine: every event carries the id the
 * database gave it, and an id already seen is dropped. `after` is advanced
 * only from poll results, which are ordered and complete up to the instant
 * they were taken; advancing it from a socket message could step over a scan
 * the poll had not reached yet. Passing it at all is not optional — the RPC
 * returns the OLDEST 500 rows, so a poll that always asked for everything
 * would go blind on a long session.
 *
 * Nothing here stops the session. Closing the dialog stops it, because the
 * dialog is what opened it.
 */

import { useEffect, useRef, useState } from 'react';
import { browserClient } from '@/lib/supabase/browser';
import { scanEventsAction, type ScanEventView } from '@/lib/data/scan-actions';

/** While the channel has not reported SUBSCRIBED, the poll is the transport. */
export const RELAY_POLL_MS = 2000;
/** Once it has, the poll is only a safety net. */
export const RELAY_SAFETY_POLL_MS = 15000;

export type RelayTransport = 'polling' | 'live';

export interface ScanRelay {
  /** Every scan of this session, oldest first. */
  events: ScanEventView[];
  /** Whether the socket is carrying the scans, or the poll still is. */
  transport: RelayTransport;
}

/**
 * Subscribes to one pairing and reports its scans.
 *
 * `onScan` is called once per code, in the order the database recorded them.
 * It is read through a ref so a dialog may pass a fresh closure on every
 * render without tearing down the subscription.
 */
export function useScanRelay(
  session: string | null,
  onScan: (code: string) => void,
): ScanRelay {
  const [events, setEvents] = useState<ScanEventView[]>([]);
  const [transport, setTransport] = useState<RelayTransport>('polling');
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  // A new pairing starts from nothing. Adjusted during the render that brought
  // the new id rather than in an effect afterwards, so no render ever shows
  // the previous session's codes under the new session's QR.
  const [relayFor, setRelayFor] = useState(session);
  if (relayFor !== session) {
    setRelayFor(session);
    setEvents([]);
    setTransport('polling');
  }

  useEffect(() => {
    if (!session) return;

    let stopped = false;
    let live = false;
    let timer = 0;
    /** Event ids already delivered, from either transport. */
    const seen = new Set<string>();
    /** The newest instant a POLL has accounted for. */
    let after: string | null = null;

    /** Delivers whatever is new, in order, and drops what has been seen. */
    function accept(incoming: ScanEventView[]): void {
      if (stopped) return;
      const fresh = incoming.filter((event) => event.id !== '' && !seen.has(event.id));
      if (fresh.length === 0) return;
      for (const event of fresh) seen.add(event.id);
      setEvents((current) => [...current, ...fresh]);
      for (const event of fresh) onScanRef.current(event.code);
    }

    async function poll(): Promise<void> {
      const found = await scanEventsAction(session!, after);
      if (stopped) return;
      // Ordered oldest first, so the last row is the high-water mark. Taken
      // before `accept`, which filters, so a row already seen over the socket
      // still moves the mark forward.
      const newest = found.at(-1)?.scannedAt;
      if (newest) after = newest;
      accept(found);
    }

    function schedule(): void {
      if (stopped) return;
      timer = window.setTimeout(async () => {
        try {
          await poll();
        } catch {
          // A lost request; the next one will catch up.
        }
        schedule();
      }, live ? RELAY_SAFETY_POLL_MS : RELAY_POLL_MS);
    }

    // One immediate read, so a dialog reopened on a session that already has
    // scans shows them rather than waiting two seconds to look.
    void poll().catch(() => {});
    schedule();

    const channel = browserClient()
      .channel(`scan:${session}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'scan_events',
          filter: `session_id=eq.${session}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown> | null;
          if (!row || typeof row.id !== 'string' || typeof row.code !== 'string') return;
          accept([
            {
              id: row.id,
              code: row.code,
              format: typeof row.format === 'string' ? row.format : null,
              scannedAt: typeof row.scanned_at === 'string' ? row.scanned_at : '',
            },
          ]);
        },
      )
      .subscribe((status) => {
        if (stopped) return;
        const connected = status === 'SUBSCRIBED';
        if (connected === live) return;
        live = connected;
        setTransport(connected ? 'live' : 'polling');
        // The cadence belongs to the transport, so the pending tick is
        // replaced rather than left to fire at the old interval.
        window.clearTimeout(timer);
        schedule();
      });

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      void browserClient().removeChannel(channel);
    };
  }, [session]);

  return { events, transport };
}
