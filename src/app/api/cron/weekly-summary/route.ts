/**
 * The Monday email: last week in review, to every active account that has not
 * turned it off in Settings.
 *
 * Called by Vercel Cron (vercel.json, Mondays 12:00 UTC, which is 8 AM in New
 * York in term time). Three gates, in order:
 *
 *   1. CRON_SECRET must be set and the request must carry it as a bearer
 *      token; Vercel Cron sends exactly that. Anything else is a 401, so the
 *      route cannot be used to mail the school from outside.
 *   2. Mail must be configured (RESEND_API_KEY and MAIL_FROM). Without it the
 *      route answers "not configured" and sends nothing: the week then
 *      reaches people as an in-app notice instead (WeeklyNudge).
 *   3. The recipients and their documents come from
 *      app_weekly_summary_recipients, which only the service role may call.
 *
 * The documents are counts only, so the email carries no student's name, no
 * ticket and no answer. Weeks with nothing in them are not sent.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { adminClient } from '@/lib/supabase/admin';
import { sendMail } from '@/lib/email/resend';
import { mailConfigured } from '@/lib/data/summary';
import { parseSummary, shiftWeek, summaryText, weekStartOf } from '@/lib/domain/summary';
import { schoolToday } from '@/lib/format';

export const dynamic = 'force-dynamic';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!mailConfigured()) {
    return NextResponse.json({ sent: 0, reason: 'mail not configured' });
  }

  const week = shiftWeek(weekStartOf(schoolToday()), -1);
  const { data, error } = await adminClient().rpc('app_weekly_summary_recipients', { p_week_start: week });
  if (error) {
    console.error(`weekly summary recipients failed (${error.code ?? 'no code'})`);
    return NextResponse.json({ error: 'recipients' }, { status: 500 });
  }

  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? request.nextUrl.origin;
  const link = `${origin}/summary?week=${week}`;
  let sent = 0;
  let skipped = 0;
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as { email?: string; display_name?: string; summary?: unknown };
    const summary = parseSummary(r.summary);
    if (!summary || !r.email) continue;
    const empty =
      (summary.tickets === null || (summary.tickets.youResolved === 0 && summary.tickets.deskResolved === 0)) &&
      summary.events.length === 0 &&
      summary.formResponses === 0;
    if (empty) {
      skipped += 1;
      continue;
    }
    const first = (r.display_name ?? '').split(' ')[0] || 'there';
    const body = summaryText(summary, r.display_name ?? 'Your', `week of ${week}`);
    const text = `Hi ${first},\n\n${body}\n\nThe whole week: ${link}\n\nTurn this email off in Settings → Notifications.`;
    const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#111">
<p>Hi ${escapeHtml(first)},</p>
<pre style="font:14px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(body)}</pre>
<p><a href="${escapeHtml(link)}" style="color:#111">Open your week</a></p>
<p style="color:#666;font-size:12px">Turn this email off in Settings, Notifications.</p></div>`;
    const result = await sendMail({ to: r.email, subject: 'Your week in review', text, html });
    if (result.ok) sent += 1;
  }
  return NextResponse.json({ sent, skipped, week });
}
