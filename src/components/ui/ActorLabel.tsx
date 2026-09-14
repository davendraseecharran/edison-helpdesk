export type PerformedVia = 'user' | 'ai';

export interface ActorLabelProps {
  name: string;
  /** How the action was performed. Anything but `ai` reads as the person. */
  via?: PerformedVia | null;
  /** The model that acted, shown in the tooltip only. */
  model?: string | null;
  className?: string;
}

/** "Mercedes Ortiz" possessive: apostrophe-s even after a trailing s. */
export function possessive(name: string): string {
  return `${name}'s`;
}

/**
 * Who did a thing, as plain text: `"Tanav"` or `"Tanav's AI"`.
 *
 * The same wording `ActorLabel` renders as markup, for the places that can
 * only hold a string — a `title` attribute, an `aria-label`, a notification
 * row written by the database. Anything but `ai` reads as the bare name;
 * there is no "via AI" form.
 */
export function actorLabelText(name: string, via?: PerformedVia | null): string {
  if (via !== 'ai') return name;
  return `${possessive(name)} AI`;
}

/**
 * Who did a thing: the person, or the person's AI.
 *
 * Attribution never hides behind an icon. The AI form is the possessive name
 * followed by a small mono `AI` tag — real text, so a screen reader, a
 * greyscale print and a quick glance all say the same thing, and it reads as a
 * label rather than as decoration. It replaced a sparkle, which is the mark
 * every generated product wears. The tooltip adds the model.
 */
export function ActorLabel({ name, via, model, className }: ActorLabelProps) {
  if (via !== 'ai') {
    return <span className={className ? `actor ${className}` : 'actor'}>{name}</span>;
  }
  const label = actorLabelText(name, via);
  const title = `Made by ${label}${model ? ` (${model})` : ''}`;
  return (
    <span className={className ? `actor actor-ai ${className}` : 'actor actor-ai'} title={title}>
      {possessive(name)}
      <span className="actor-ai-tag">AI</span>
    </span>
  );
}
