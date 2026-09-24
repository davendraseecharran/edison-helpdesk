'use client';

/**
 * What the kiosk says back, over the field: a welcome with a tick that draws
 * itself, or a problem and what to do about it.
 *
 * A live region, so a screen reader at the door hears the same sentence the
 * screen shows. Each welcome is keyed on the scan that caused it, so two
 * people in a row each get their own tick rather than the second arriving
 * already drawn.
 */

import { CircleAlert } from 'lucide-react';
import { Icon } from '@/components/ui/Icon';
import { CheckDraw } from './CheckDraw';

export interface KioskNotice {
  tone: 'welcome' | 'problem';
  title: string;
  body: string;
  /** Changes per scan, so the welcome replays for the next person. */
  key?: number;
}

export function KioskMessage({ notice }: { notice: KioskNotice | null }) {
  return (
    <div className="kiosk-message-slot" aria-live="assertive" aria-atomic="true">
      {notice ? (
        <div
          key={`${notice.tone}-${notice.key ?? notice.title}`}
          className={notice.tone === 'welcome' ? 'kiosk-message kiosk-welcome' : 'kiosk-message kiosk-problem'}
        >
          {notice.tone === 'welcome' ? (
            <CheckDraw size={96} className="kiosk-check" />
          ) : (
            <Icon icon={CircleAlert} size={48} className="kiosk-problem-icon" />
          )}
          <p className="kiosk-message-title">{notice.title}</p>
          <p className="kiosk-message-body">{notice.body}</p>
        </div>
      ) : null}
    </div>
  );
}
