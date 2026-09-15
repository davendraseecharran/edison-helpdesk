import { ButtonLink } from '@/components/ui/Button';
import { NotFoundHeading } from '@/components/shell/NotFoundHeading';

export const metadata = { title: 'Page not found — Edison Helpdesk' };

/**
 * Where `notFound()` lands for somebody who is signed in.
 *
 * Nested inside this group, so it renders through `(app)/layout.tsx`: the rail,
 * the top bar and — the part that was actually wrong — the account's own theme.
 * Next's built-in 404 is a bare white page outside the shell, so a NetRider who
 * typed `/admin` was thrown out of the application into a document that looked
 * like a different product and offered no way back.
 *
 * On the copy. Two routes send people here for two different reasons — a URL
 * that does not exist, and a page above this account's roles — and both get the
 * same sentence on purpose. `admin/page.tsx` calls `notFound()` rather than
 * redirecting precisely so that a technician is not told the administration
 * section exists; "You do not have access to Administration" would hand back
 * exactly the fact the refusal is protecting. What a person can do about it is
 * the same either way, and it is the button.
 *
 * Today rather than the previous page: this is reached by typing or by
 * following a stale link, so "back" is often where the bad link was.
 */
export default function AppNotFound() {
  return (
    <div className="empty">
      <NotFoundHeading>This page does not exist</NotFoundHeading>
      <p className="empty-body">
        The address may be mistyped, or the page may have moved. Nothing has gone wrong with your
        account.
      </p>
      <div className="empty-action">
        <ButtonLink href="/today" variant="primary">
          Go to Today
        </ButtonLink>
      </div>
    </div>
  );
}
