import { FORM_STATE_LABELS, type FormState } from '@/lib/domain/forms';

/**
 * Whether a form takes responses. A dot beside a word, like every status in
 * the product: open is the live green, closed is simply quiet, full is the
 * warm mark that says "somebody set a limit and it was reached".
 */
export function FormStateBadge({ state }: { state: FormState }) {
  return (
    <span className={`badge badge-status form-state-${state}`}>
      <span className="badge-dot" aria-hidden="true" />
      <span className="badge-label">{FORM_STATE_LABELS[state]}</span>
    </span>
  );
}
