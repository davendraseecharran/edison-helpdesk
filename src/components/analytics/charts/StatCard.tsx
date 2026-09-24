import type { ReactNode } from 'react';
import type { Delta } from '@/lib/domain/analytics';
import { RollingNumber } from '@/components/ui/RollingNumber';

const ARROW: Record<Delta['direction'], string> = { up: '↑', down: '↓', same: '–' };

/**
 * The change beside a figure: an arrow and a whole percent, with the sentence
 * on the title so a hover or a screen reader gets "Up 15% on the period
 * before" rather than a glyph. All time has nothing to compare with and
 * shows nothing rather than a dash that would have to be explained.
 */
export function DeltaMark({ delta }: { delta: Delta }) {
  if (delta.percent === null && delta.direction === 'same') return null;
  const text =
    delta.percent === null
      ? ARROW[delta.direction]
      : `${ARROW[delta.direction]} ${delta.percent}%`;
  return (
    <span className="stat-card-delta" title={delta.text} aria-label={delta.text}>
      {text}
    </span>
  );
}

/**
 * One figure with its name, and beneath it whatever a person would ask next
 * — the previous period, the p90, what is unassigned. The value is a node so
 * a caller can pass "5h 30m" as readily as a number.
 */
export function StatCard({
  label,
  value,
  delta,
  lines = [],
}: {
  label: string;
  value: ReactNode;
  delta?: Delta;
  lines?: ReactNode[];
}) {
  return (
    <div className="stat-card">
      <span className="stat-card-label">{label}</span>
      <span className="stat-card-value">
        {/* Figures roll to their new values when the period changes. */}
        <span>{typeof value === 'number' || typeof value === 'string' ? <RollingNumber value={value} /> : value}</span>
        {delta ? <DeltaMark delta={delta} /> : null}
      </span>
      {lines.map((line, i) => (
        <span key={i} className="stat-card-line">
          {line}
        </span>
      ))}
    </div>
  );
}
