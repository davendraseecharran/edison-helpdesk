'use client';

/**
 * A change the assistant wants to make, waiting for a yes or a no.
 *
 * The stream has stopped on this card; nothing else happens until one of
 * the two buttons is pressed (or the person sends something new, which
 * counts as no). The card says exactly what would happen — the backend's
 * own summary and the arguments as it read them — so the decision is about
 * the real call, not a paraphrase. The lamp marks it as the thing that is
 * waiting — it is the one element on the screen wearing the lift, and nothing
 * else has to shout.
 */

import { Button } from '@/components/ui/Button';
import { Orb } from './Orb';
import type { ToolPart } from './useAiChat';

const IDENTIFIER_KEYS = new Set(['ticket', 'asset_tag', 'serial', 'osis', 'device', 'tag', 'number']);
const IDENTIFIER_VALUE = /^(EDT-\d+|[A-Z0-9]{4,}-?[A-Z0-9]*)$/;

function humanKey(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function readable(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(readable).join(', ');
  try {
    const json = JSON.stringify(value);
    return json.length > 240 ? `${json.slice(0, 240)}…` : json;
  } catch {
    return 'value';
  }
}

function isIdentifier(key: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return IDENTIFIER_KEYS.has(key) || IDENTIFIER_VALUE.test(value);
}

export function ToolApprovalCard({
  part,
  busy,
  note,
  onApprove,
  onReject,
}: {
  part: ToolPart;
  /** Another request is running; the buttons wait for it. */
  busy: boolean;
  /** Why this is asking, when the person has turned asking off. */
  note?: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  const entries = Object.entries(part.args).filter(([, value]) => value !== null && value !== undefined && value !== '');

  return (
    <div className="ai-approval" role="group" aria-label={`Approve: ${part.summary}`}>
      <div className="ai-approval-head">
        <Orb size={20} moment="approval" label="Waiting for your decision" />
        <span className="ai-approval-kicker">Needs your approval</span>
      </div>
      <p className="ai-approval-summary">{part.summary}</p>
      {note ? <p className="ai-approval-note">{note}</p> : null}
      {entries.length > 0 ? (
        <dl className="ai-approval-args">
          {entries.map(([key, value]) => (
            <div key={key} className="ai-approval-arg">
              <dt>{humanKey(key)}</dt>
              <dd className={isIdentifier(key, value) ? 'mono' : undefined}>{readable(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="ai-approval-actions">
        <Button variant="primary" size="sm" onClick={onApprove} disabled={busy}>
          Approve
        </Button>
        <Button variant="secondary" size="sm" onClick={onReject} disabled={busy}>
          Reject
        </Button>
      </div>
    </div>
  );
}
