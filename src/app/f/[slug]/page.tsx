import type { Metadata } from 'next';
import { loadPublicForm } from '@/lib/data/forms';
import { FORM_STATE_LABELS } from '@/lib/domain/forms';
import { PublicForm } from '@/components/forms/PublicForm';
import '@/styles/forms.css';

/**
 * The public form: `/f/<slug>`, for somebody with no account.
 *
 * Outside the `(app)` group because it is not the application — no rail, no
 * top bar, no session required — and rendered per request, because a form
 * that was closed a minute ago must not be served open from a cache.
 *
 * Everything on it comes from `app_public_form` through a client that is
 * nobody (see `loadPublicForm`), so what an officer sees when they test the
 * link on their own laptop is exactly what a student sees on a phone.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const form = await loadPublicForm(slug);
  return {
    title: form ? form.title : 'Form not available',
    robots: { index: false, follow: false },
  };
}

export default async function PublicFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const form = await loadPublicForm(slug);

  return (
    <main className="pf">
      <div className="pf-column">
        <p className="pf-school">Thomas A. Edison CTE High School</p>
        {!form ? (
          <section className="pf-closed">
            <h1 className="pf-title">This form is not available</h1>
            <p className="pf-description">
              The link may be mistyped, or the form may have been deleted. Ask whoever sent it
              for a new one.
            </p>
          </section>
        ) : form.state !== 'open' ? (
          <section className="pf-closed">
            <span className="pf-state">{FORM_STATE_LABELS[form.state]}</span>
            <h1 className="pf-title">{form.title}</h1>
            <p className="pf-description">
              {form.state === 'full'
                ? 'This form has all the responses it can take.'
                : 'This form is closed and is not taking responses.'}{' '}
              If you think that is a mistake, ask whoever sent you the link.
            </p>
          </section>
        ) : (
          <PublicForm
            slug={form.slug}
            title={form.title}
            description={form.description}
            audience={form.audience}
            fields={form.fields}
          />
        )}
      </div>
    </main>
  );
}
