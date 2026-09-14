'use client';

/**
 * Everything the panel asks a server for, behind one interface.
 *
 * The real implementation is the set of server actions in `lib/ai/ai-actions`
 * plus the chat route; the dev demo swaps in scripted versions so every
 * state of the panel can be seen without a ChatGPT account. Components take
 * `services` and never import an action directly.
 */

import {
  aiStatusAction,
  deleteConversationAction,
  disconnectCodexAction,
  listConversationsAction,
  loadConversationAction,
  pollCodexAuthAction,
  startCodexAuthAction,
  updateAiPreferencesAction,
  type AiActionResult,
  type AiPreferencePatch,
  type AiStatus,
  type ConversationListResult,
  type ConversationTranscriptResult,
  type DeviceAuthPolled,
  type DeviceAuthStarted,
} from '@/lib/ai/ai-actions';
import { defaultTransport, type ChatTransport } from './useAiChat';

export type { AiActionResult, AiPreferencePatch, AiStatus, ConversationListResult, ConversationTranscriptResult };

export interface AiServices {
  status: () => Promise<AiStatus>;
  updatePreferences: (patch: AiPreferencePatch) => Promise<AiActionResult>;
  startAuth: () => Promise<DeviceAuthStarted>;
  pollAuth: (userCode: string) => Promise<DeviceAuthPolled>;
  disconnect: () => Promise<AiActionResult>;
  listConversations: () => Promise<ConversationListResult>;
  loadConversation: (id: string) => Promise<ConversationTranscriptResult>;
  deleteConversation: (id: string) => Promise<AiActionResult>;
  transport: ChatTransport;
}

export const serverServices: AiServices = {
  status: () => aiStatusAction(),
  updatePreferences: (patch) => updateAiPreferencesAction(patch),
  startAuth: () => startCodexAuthAction(),
  pollAuth: (userCode) => pollCodexAuthAction(userCode),
  disconnect: () => disconnectCodexAction(),
  listConversations: () => listConversationsAction(),
  loadConversation: (id) => loadConversationAction(id),
  deleteConversation: (id) => deleteConversationAction(id),
  transport: defaultTransport,
};
