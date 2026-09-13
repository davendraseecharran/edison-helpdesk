import { Sparkles } from 'lucide-react';
import { Icon } from './Icon';

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
 * Who did a thing: the person, or the person's AI.
 *
 * Attribution never hides behind an icon alone. The AI form carries the words
 * "'s AI" in the text itself, so a screen reader, a greyscale print and a
 * quick glance all say the same thing; the sparkle is decoration and the
 * tooltip adds the model for anyone who wants it.
 */
export function ActorLabel({ name, via, model, className }: ActorLabelProps) {
  if (via !== 'ai') {
    return <span className={className ? `actor ${className}` : 'actor'}>{name}</span>;
  }
  const owner = possessive(name);
  const title = `Made by ${owner} AI${model ? ` (${model})` : ''}`;
  return (
    <span className={className ? `actor actor-ai ${className}` : 'actor actor-ai'} title={title}>
      {owner} AI
      <Icon icon={Sparkles} size={14} className="actor-sparkle" />
    </span>
  );
}
