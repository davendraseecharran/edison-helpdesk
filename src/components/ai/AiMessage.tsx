'use client';

/**
 * One turn of the conversation.
 *
 * The person's words sit right, in a quiet bubble. The assistant's turn sits
 * left with no bubble at all, because it is not one thing: a thinking line
 * that can be opened, chips for what each tool did, the reply itself, and,
 * when something went wrong, one plain sentence with a way to try again.
 * Chips and cards slide in as they arrive; text simply grows.
 */

import { Brain, Check, CircleAlert, CircleMinus, CircleX } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useReducedMotion } from '@/components/ui/media';
import { EASE_OUT, INSTANT } from '@/components/ui/Motion';
import { runningLabel } from './chip-copy';
import { renderMarkdown } from './markdown';
import { Orb } from './Orb';
import { momentForTool, type Moment } from './orb-state';
import { ToolApprovalCard } from './ToolApprovalCard';
import type { AssistantTurn, ToolPart, Turn } from './useAiChat';

const RISE = { opacity: 0, y: 6 };
const SETTLED = { opacity: 1, y: 0 };

function Arrive({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : RISE}
      animate={SETTLED}
      transition={reduced ? INSTANT : EASE_OUT}
    >
      {children}
    </motion.div>
  );
}

function ToolChip({ part }: { part: ToolPart }) {
  // Past tense once the tool has answered, present participle while it works,
  // and the server's fuller description for anything the chip cannot phrase.
  const label = part.result ?? runningLabel(part.name, part.args) ?? part.summary;
  return (
    <Arrive className="ai-chip-row">
      <span className="ai-chip" data-status={part.status}>
        {part.status === 'running' ? (
          <Orb size={20} moment={momentForTool(part.name)} />
        ) : part.status === 'ok' ? (
          <Icon icon={Check} size={14} />
        ) : part.status === 'failed' ? (
          <Icon icon={CircleX} size={14} />
        ) : (
          <Icon icon={CircleMinus} size={14} />
        )}
        <span className="ai-chip-text">{label}</span>
      </span>
    </Arrive>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  return (
    <details className="ai-thinking" data-live={live || undefined}>
      <summary className="ai-thinking-summary">
        {live ? <Orb size={20} moment="reasoning" /> : <Icon icon={Brain} size={16} />}
        <span>{live ? 'Thinking' : 'Thought about it'}</span>
      </summary>
      {text.trim() !== '' ? (
        <div className="ai-thinking-body ai-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      ) : (
        <p className="ai-thinking-body subtle">Nothing to show yet.</p>
      )}
    </details>
  );
}

export function AiMessage({
  turn,
  last,
  moment,
  busy,
  approvalNote,
  onApprove,
  onReject,
  onRetry,
}: {
  turn: Turn;
  /** The most recent turn, which is the only one that can offer a retry. */
  last: boolean;
  moment: Moment;
  busy: boolean;
  /** Why a card is asking when "Ask before changes" is off. */
  approvalNote?: string;
  onApprove: (callId: string) => void;
  onReject: (callId: string) => void;
  onRetry: () => void;
}) {
  if (turn.role === 'user') {
    return (
      <div className="ai-turn ai-turn-user">
        <div className="ai-bubble">{turn.text}</div>
      </div>
    );
  }

  return (
    <AssistantMessage
      turn={turn}
      last={last}
      moment={moment}
      busy={busy}
      approvalNote={approvalNote}
      onApprove={onApprove}
      onReject={onReject}
      onRetry={onRetry}
    />
  );
}

function AssistantMessage({
  turn,
  last,
  moment,
  busy,
  approvalNote,
  onApprove,
  onReject,
  onRetry,
}: {
  turn: AssistantTurn;
  last: boolean;
  moment: Moment;
  busy: boolean;
  approvalNote?: string;
  onApprove: (callId: string) => void;
  onReject: (callId: string) => void;
  onRetry: () => void;
}) {
  const lastIndex = turn.parts.length - 1;

  return (
    <div className="ai-turn ai-turn-assistant" data-streaming={turn.streaming || undefined}>
      {turn.parts.length === 0 && turn.streaming ? (
        <div className="ai-pending" aria-live="polite">
          <Orb size={20} moment={moment === 'idle' ? 'sending' : moment} />
          <span className="subtle">Working on it</span>
        </div>
      ) : null}

      {turn.parts.map((part, index) => {
        const key = `${turn.id}-${index}`;
        switch (part.type) {
          case 'reasoning':
            return <Thinking key={key} text={part.text} live={part.live && turn.streaming} />;
          case 'tool':
            if (part.needsApproval && part.status === 'pending') {
              return (
                <Arrive key={key}>
                  <ToolApprovalCard
                    part={part}
                    busy={busy}
                    note={approvalNote}
                    onApprove={() => onApprove(part.callId)}
                    onReject={() => onReject(part.callId)}
                  />
                </Arrive>
              );
            }
            return <ToolChip key={key} part={part} />;
          case 'text':
            return (
              <div
                key={key}
                className={turn.streaming && index === lastIndex ? 'ai-md ai-md-live' : 'ai-md'}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }}
              />
            );
          case 'error':
            return (
              <div key={key} className="ai-error" role="alert">
                <Icon icon={CircleAlert} size={16} />
                <span className="ai-error-text">{part.message}</span>
                {last && index === lastIndex && !turn.streaming && !busy ? (
                  <Button variant="ghost" size="sm" onClick={onRetry}>
                    Retry
                  </Button>
                ) : null}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
