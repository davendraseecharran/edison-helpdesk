import { requireTicketWorker } from '@/lib/auth/session';
import { isAdmin } from '@/lib/auth/roles';
import { loadTodayBriefing } from '@/lib/data/today';
import { requestTime, schoolHour, schoolWeekday } from '@/lib/format';
import { TodayScreen } from '@/components/today/TodayScreen';
import { TODAY_BOOT_SCRIPT } from '@/components/today/today-boot';

export const metadata = { title: 'Today — Edison Helpdesk' };

/**
 * `/today` — where signing in lands.
 *
 * One read (`app_today_briefing`, SECURITY INVOKER) and one client component.
 * The hour and the weekday are computed here, in the school's own timezone,
 * and handed down rather than read from the browser: a greeting that says
 * "good evening" on a machine set to UTC would be the first thing a reader saw
 * and the first thing they distrusted.
 *
 * A skills officer is redirected by `requireTicketWorker`. Their landing page
 * is the directory, which is the work they actually have.
 */
export default async function TodayPage() {
  const actor = await requireTicketWorker();
  const briefing = await loadTodayBriefing();
  const now = new Date();

  // The first name, because that is what a colleague would say. A display name
  // that is one word is already the first name.
  const firstName = actor.displayName.trim().split(/\s+/)[0] || actor.displayName;

  return (
    <>
      {/* Runs before the body paints, so a reload inside the same session does
          not replay the entrance. See today-boot.ts. */}
      <script dangerouslySetInnerHTML={{ __html: TODAY_BOOT_SCRIPT }} />
      <TodayScreen
        briefing={briefing}
        now={requestTime()}
        firstName={firstName}
        hour={schoolHour(now)}
        weekday={schoolWeekday(now)}
        ticketWorker
        admin={isAdmin(actor.roles)}
      />
    </>
  );
}
