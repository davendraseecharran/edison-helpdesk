'use client';

/**
 * Earlier conversations, newest first.
 *
 * Opening one continues it: the assistant is given the same thread, and what
 * can be shown of it is shown. Deleting one is immediate and its own row's
 * business; the list does not ask twice, because a conversation is the
 * person's own record and the delete policy already scopes it to them.
 */

import { ArrowLeft, MessageSquareText, Trash } from 'lucide-react';
import { TimeAgo } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { SkeletonText } from '@/components/ui/Skeleton';
import type { ConversationSummary } from '@/lib/ai/conversations';

export function ConversationList({
  conversations,
  loading,
  error,
  currentId,
  onOpen,
  onDelete,
  onBack,
}: {
  conversations: ConversationSummary[];
  loading: boolean;
  error: string | null;
  currentId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <section className="ai-conversations" aria-labelledby="ai-conversations-title">
      <div className="ai-conversations-head">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
          Back
        </Button>
        <h3 id="ai-conversations-title" className="ai-conversations-title">
          Conversations
        </h3>
      </div>

      {loading ? (
        <div className="ai-conversations-loading" aria-busy="true">
          <SkeletonText lines={4} />
        </div>
      ) : error ? (
        <p className="ai-error" role="alert">
          {error}
        </p>
      ) : conversations.length === 0 ? (
        <p className="ai-conversations-empty subtle">
          No conversations yet. Ask something and it will be kept here.
        </p>
      ) : (
        <ul className="ai-conversation-rows">
          {conversations.map((conversation) => (
            <li
              key={conversation.id}
              className="ai-conversation-row"
              aria-current={conversation.id === currentId ? 'true' : undefined}
            >
              <button
                type="button"
                className="ai-conversation-open"
                onClick={() => onOpen(conversation.id)}
              >
                <Icon icon={MessageSquareText} size={16} />
                <span className="ai-conversation-text">
                  <span className="ai-conversation-title">{conversation.title}</span>
                  <span className="ai-conversation-when subtle">
                    <TimeAgo iso={conversation.updatedAt} />
                  </span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                icon={Trash}
                aria-label={`Delete conversation: ${conversation.title}`}
                title="Delete conversation"
                onClick={() => onDelete(conversation.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
