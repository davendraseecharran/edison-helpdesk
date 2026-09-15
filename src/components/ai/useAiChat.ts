'use client';

/**
 * One conversation with the assistant, as the panel sees it.
 *
 * Talks to `POST /api/ai/chat` and turns its NDJSON lines into turns: what
 * the person said, and what the assistant did in reply, in order — reasoning,
 * tool calls with their results, text, and any error. A turn is appended to
 * as lines arrive, so the panel renders the reply while it is still being
 * written, and the current `moment` (for the orb) falls out of the last
 * line seen.
 *
 * Approvals are the one place the wire format is stateful: a `tool_call`
 * with `needsApproval` ends the stream, and the next request carries the
 * answer. The hook keeps that call in its turn with a `pending` status and
 * continues the same turn when the answer's stream arrives.
 *
 * Work is not cancelled when the panel closes — the top-bar toggle shows the
 * orb and an unread mark for exactly that case — only when a new message
 * replaces it or the hook unmounts.
 *
 * The transport is injectable so the dev demo can feed a scripted stream.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isRecord, textOf } from '@/lib/guards';
import { isBusyMoment, momentForTool, type Moment } from './orb-state';
import type { PageContext } from './page-context';
import type { TurnImage } from '@/lib/ai/images';

export interface ChatRequest {
  conversationId?: string;
  message?: string;
  /** Pictures attached to this turn, as data URLs. */
  images?: TurnImage[];
  approve?: string[];
  reject?: string[];
  page?: PageContext;
}

/** Sends one chat request and returns the streaming response. */
export type ChatTransport = (body: ChatRequest, signal: AbortSignal) => Promise<Response>;

export const defaultTransport: ChatTransport = (body, signal) =>
  fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    cache: 'no-store',
  });

export type ToolStatus = 'pending' | 'running' | 'ok' | 'failed' | 'rejected';

export interface ToolPart {
  type: 'tool';
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** Pre-execution, sentence case: "Claim ticket (ticket: EDT-1042)". */
  summary: string;
  needsApproval: boolean;
  status: ToolStatus;
  /** Past tense once run: "Claimed EDT-1042". */
  result: string | null;
}

export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  /** Still streaming. */
  live: boolean;
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ErrorPart {
  type: 'error';
  message: string;
}

export type TurnPart = ToolPart | ReasoningPart | TextPart | ErrorPart;

export interface UserTurn {
  id: string;
  role: 'user';
  text: string;
  /** What was attached, so the transcript shows it where it was sent. */
  images?: TurnImage[];
}

export interface AssistantTurn {
  id: string;
  role: 'assistant';
  parts: TurnPart[];
  /** A stream is feeding this turn right now. */
  streaming: boolean;
}

export type Turn = UserTurn | AssistantTurn;

/** Why the assistant cannot take a message, as the server last said. */
export type ChatBlock = 'not_connected' | 'disabled' | 'signed_out';

export interface UseAiChat {
  turns: Turn[];
  conversationId: string | null;
  /** What the assistant is doing, from the stream alone. */
  moment: Moment;
  busy: boolean;
  /** Tool calls waiting for a decision, oldest first. */
  pending: ToolPart[];
  send: (text: string, images?: readonly TurnImage[]) => void;
  approve: (callId: string) => void;
  reject: (callId: string) => void;
  /** Sends the last message again after a failure. */
  retry: () => void;
  stop: () => void;
  newConversation: () => void;
  /** Continues an earlier conversation, with its transcript. */
  resume: (conversationId: string, turns: Turn[]) => void;
}

export interface UseAiChatOptions {
  transport?: ChatTransport;
  /** Read when a message is sent, so the request describes the page it came from. */
  page?: () => PageContext | null;
  /** The assistant finished a reply. `text` is everything it wrote, in order. */
  onReply?: (text: string) => void;
  /** The server refused the message for a reason the panel has to show. */
  onBlocked?: (block: ChatBlock, message: string) => void;
  /** A conversation to start from, for the dev demo. */
  initial?: { conversationId: string | null; turns: Turn[] };
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Applies one stream line to the parts of the turn being written. */
export function applyLine(parts: TurnPart[], line: Record<string, unknown>): TurnPart[] {
  const type = textOf(line.type);
  const last = parts[parts.length - 1];

  switch (type) {
    case 'reasoning': {
      const delta = textOf(line.text);
      if (last?.type === 'reasoning' && last.live) {
        return [...parts.slice(0, -1), { ...last, text: last.text + delta }];
      }
      return [...settle(parts), { type: 'reasoning', text: delta, live: true }];
    }
    case 'delta': {
      const delta = textOf(line.text);
      if (last?.type === 'text') {
        return [...parts.slice(0, -1), { ...last, text: last.text + delta }];
      }
      return [...settle(parts), { type: 'text', text: delta }];
    }
    case 'tool_call': {
      const part: ToolPart = {
        type: 'tool',
        callId: textOf(line.callId),
        name: textOf(line.name),
        args: isRecord(line.args) ? line.args : {},
        summary: textOf(line.summary),
        needsApproval: line.needsApproval === true,
        status: line.needsApproval === true ? 'pending' : 'running',
        result: null,
      };
      return [...settle(parts), part];
    }
    case 'tool_result': {
      const callId = textOf(line.callId);
      const ok = line.ok === true;
      const summary = textOf(line.summary);
      let found = false;
      const next = parts.map((part) => {
        if (part.type !== 'tool' || part.callId !== callId) return part;
        found = true;
        const rejected = !ok && summary.startsWith('Not approved');
        return {
          ...part,
          status: rejected ? 'rejected' : ok ? 'ok' : 'failed',
          result: summary,
        } satisfies ToolPart;
      });
      if (found) return settle(next);
      // A result for a call this panel never saw (an approval answered from
      // another tab, say): still worth a chip.
      return [
        ...settle(parts),
        {
          type: 'tool',
          callId,
          name: '',
          args: {},
          summary,
          needsApproval: false,
          status: ok ? 'ok' : 'failed',
          result: summary,
        },
      ];
    }
    case 'error': {
      return [...settle(parts), { type: 'error', message: textOf(line.message) || 'Something went wrong.' }];
    }
    default:
      return parts;
  }
}

/** Marks a streaming reasoning part finished, once something else follows it. */
function settle(parts: TurnPart[]): TurnPart[] {
  const last = parts[parts.length - 1];
  if (last?.type === 'reasoning' && last.live) {
    return [...parts.slice(0, -1), { ...last, live: false }];
  }
  return parts;
}

/** The moment a stream line puts the panel in, or null when it says nothing about that. */
export function momentForLine(line: Record<string, unknown>): Moment | null {
  switch (textOf(line.type)) {
    case 'phase':
      // `tool` says a tool is coming, not which one. The `tool_call` that
      // follows names it, and that is what the orb should show: guessing
      // "reading" here flashes the wrong orb before every write.
      return line.phase === 'writing' ? 'writing' : line.phase === 'tool' ? null : 'sending';
    case 'reasoning':
      return 'reasoning';
    case 'delta':
      return 'writing';
    case 'tool_call':
      return line.needsApproval === true ? 'approval' : momentForTool(textOf(line.name));
    case 'tool_result':
      return 'sending';
    default:
      return null;
  }
}

/** A stored conversation, as `loadConversationAction` describes it. */
export type TranscriptItem =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; callId: string; name: string; summary: string; ok: boolean | null };

export interface TranscriptPending {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
}

/**
 * Turns a stored transcript into turns the panel can show.
 *
 * Consecutive assistant text and tool items form one turn, as they did when
 * they were produced. Calls still waiting for an answer come back as
 * approval cards, so a question left open can be answered after reopening.
 */
export function turnsFromTranscript(items: TranscriptItem[], pending: TranscriptPending[] = []): Turn[] {
  const turns: Turn[] = [];
  let current: AssistantTurn | null = null;

  const assistant = (): AssistantTurn => {
    if (!current) {
      current = { id: newId(), role: 'assistant', parts: [], streaming: false };
      turns.push(current);
    }
    return current;
  };

  for (const item of items) {
    if (item.role === 'user') {
      current = null;
      turns.push({ id: newId(), role: 'user', text: item.text });
      continue;
    }
    if (item.role === 'assistant') {
      assistant().parts.push({ type: 'text', text: item.text });
      continue;
    }
    assistant().parts.push({
      type: 'tool',
      callId: item.callId,
      name: item.name,
      args: {},
      summary: item.summary,
      needsApproval: false,
      status: item.ok === null ? 'rejected' : item.ok ? 'ok' : 'failed',
      result: null,
    });
  }

  for (const call of pending) {
    assistant().parts.push({
      type: 'tool',
      callId: call.callId,
      name: call.name,
      args: call.args,
      summary: call.summary,
      needsApproval: true,
      status: 'pending',
      result: null,
    });
  }

  return turns;
}

function replyText(parts: TurnPart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

export function useAiChat({
  transport = defaultTransport,
  page,
  onReply,
  onBlocked,
  initial,
}: UseAiChatOptions = {}): UseAiChat {
  const [turns, setTurns] = useState<Turn[]>(() => initial?.turns ?? []);
  const [conversationId, setConversationId] = useState<string | null>(
    () => initial?.conversationId ?? null,
  );
  const [moment, setMoment] = useState<Moment>(() =>
    (initial?.turns ?? []).some(
      (turn) =>
        turn.role === 'assistant' &&
        turn.parts.some((part) => part.type === 'tool' && part.status === 'pending'),
    )
      ? 'approval'
      : 'idle',
  );

  // Everything that writes turns goes through `writeTurns`, which keeps this
  // ref in step. A stream has to read the turn it is feeding part-way through,
  // and reading it from here rather than from inside a `setTurns` updater keeps
  // the updater pure — React calls those twice in development.
  const turnsRef = useRef<Turn[]>(turns);
  const writeTurns = useCallback((update: (current: Turn[]) => Turn[]) => {
    const next = update(turnsRef.current);
    turnsRef.current = next;
    setTurns(next);
  }, []);

  const controller = useRef<AbortController | null>(null);
  const lastMessage = useRef<{ text: string; images: TurnImage[] } | null>(null);
  const conversationRef = useRef<string | null>(initial?.conversationId ?? null);
  const callbacks = useRef({ page, onReply, onBlocked });
  useEffect(() => {
    callbacks.current = { page, onReply, onBlocked };
  });

  const busy = isBusyMoment(moment);

  const pending = useMemo(() => {
    const out: ToolPart[] = [];
    for (const turn of turns) {
      if (turn.role !== 'assistant') continue;
      for (const part of turn.parts) {
        if (part.type === 'tool' && part.status === 'pending') out.push(part);
      }
    }
    return out;
  }, [turns]);

  const updateTurn = useCallback(
    (id: string, update: (turn: AssistantTurn) => AssistantTurn) => {
      writeTurns((current) =>
        current.map((turn) => (turn.role === 'assistant' && turn.id === id ? update(turn) : turn)),
      );
    },
    [writeTurns],
  );

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
  }, []);

  /**
   * Runs one request and feeds its lines into `turnId`. The moment moves with
   * the lines and settles to idle, approval or error when the stream ends.
   */
  const run = useCallback(
    async (body: ChatRequest, turnId: string) => {
      stop();
      const abort = new AbortController();
      controller.current = abort;
      setMoment('sending');
      updateTurn(turnId, (turn) => ({ ...turn, streaming: true }));

      let parts: TurnPart[] = [];
      let seeded = false;
      // Typed through a cast: it is assigned inside `handle`, which TypeScript's
      // narrowing cannot see, and would otherwise be taken for a constant.
      let ended = 'done' as 'done' | 'approval' | 'error';

      const commit = () => {
        const snapshot = parts;
        updateTurn(turnId, (turn) => ({ ...turn, parts: snapshot }));
      };

      try {
        const response = await transport(body, abort.signal);

        if (!response.ok) {
          let message = 'The assistant could not answer. Try again.';
          let code = '';
          try {
            const problem: unknown = await response.json();
            if (isRecord(problem)) {
              message = textOf(problem.message) || message;
              code = textOf(problem.error);
            }
          } catch {
            // No body; the status is the message.
          }
          const block: ChatBlock | null =
            response.status === 409 || code === 'not_connected'
              ? 'not_connected'
              : response.status === 503 || code === 'ai_disabled'
                ? 'disabled'
                : response.status === 401
                  ? 'signed_out'
                  : null;
          if (block) {
            // Not a failed turn: the panel has been told and shows the
            // connection card, the disabled note or a toast. Saying it twice —
            // once there and once as an error inside the turn — is one time too
            // many, so the empty turn goes.
            callbacks.current.onBlocked?.(block, message);
            writeTurns((current) => current.filter((turn) => turn.id !== turnId));
            setMoment('idle');
            return;
          }
          updateTurn(turnId, (turn) => ({
            ...turn,
            streaming: false,
            parts: [...turn.parts, { type: 'error', message }],
          }));
          setMoment('error');
          return;
        }

        if (!response.body) throw new Error('The reply had no body.');

        // The answer continues an existing turn (an approval) or starts a fresh one.
        const existing = turnsRef.current.find((entry) => entry.id === turnId);
        if (existing?.role === 'assistant') parts = existing.parts;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const handle = (raw: string) => {
          let line: unknown;
          try {
            line = JSON.parse(raw);
          } catch {
            return;
          }
          if (!isRecord(line)) return;
          const type = textOf(line.type);
          if (type === 'conversation') {
            const id = textOf(line.id);
            if (id !== '') {
              conversationRef.current = id;
              setConversationId(id);
            }
            return;
          }
          if (type === 'done') {
            ended = ended === 'error' ? 'error' : 'done';
            return;
          }
          if (!seeded) {
            seeded = true;
            // The turn continues from what was there, minus any pending marker
            // this request is answering.
            parts = parts.map((part) =>
              part.type === 'tool' && part.status === 'pending'
                ? {
                    ...part,
                    status: body.approve?.includes(part.callId) ? 'running' : 'rejected',
                    result: body.approve?.includes(part.callId) ? null : `Not approved: ${part.summary}`,
                  }
                : part,
            );
          }
          parts = applyLine(parts, line);
          // An `error` line is a notice, not the end: the route can say
          // something went wrong and carry on. Only the LAST substantive line
          // decides how the turn ended.
          if (type === 'error') ended = 'error';
          else if (type === 'tool_call' && line.needsApproval === true) ended = 'approval';
          else if (type === 'reasoning' || type === 'delta' || type === 'tool_call' || type === 'tool_result') {
            ended = 'done';
          }
          const next = momentForLine(line);
          if (next) setMoment(next);
          commit();
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const raw = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (raw !== '') handle(raw);
            newline = buffer.indexOf('\n');
          }
        }
        if (buffer.trim() !== '') handle(buffer.trim());
      } catch (error) {
        if (abort.signal.aborted) {
          // Stopped on purpose: leave what arrived, say nothing.
          updateTurn(turnId, (turn) => ({ ...turn, streaming: false, parts: settle(turn.parts) }));
          if (controller.current === abort) controller.current = null;
          setMoment(parts.some((part) => part.type === 'tool' && part.status === 'pending') ? 'approval' : 'idle');
          return;
        }
        const message =
          error instanceof Error && error.message.trim() !== ''
            ? `The connection dropped: ${error.message}`
            : 'The connection dropped. Check your network and try again.';
        parts = [...settle(parts), { type: 'error', message }];
        ended = 'error';
        commit();
      }

      if (controller.current === abort) controller.current = null;
      parts = settle(parts);
      const snapshot = parts;
      updateTurn(turnId, (turn) => ({ ...turn, streaming: false, parts: snapshot }));

      if (ended === 'error') {
        setMoment('error');
      } else if (ended === 'approval') {
        setMoment('approval');
      } else {
        setMoment('idle');
        const reply = replyText(parts);
        if (reply !== '') callbacks.current.onReply?.(reply);
      }
    },
    [stop, transport, updateTurn, writeTurns],
  );

  const send = useCallback(
    (raw: string, images: readonly TurnImage[] = []) => {
      const message = raw.trim();
      // A photograph on its own is a message. Only a turn with neither words
      // nor pictures in it is nothing to send.
      if (message === '' && images.length === 0) return;
      const attached = [...images];
      lastMessage.current = { text: message, images: attached };

      // A new message answers any open approvals with "no": the person has
      // moved on, and the server treats an unanswered call the same way.
      const unanswered = pending.map((part) => part.callId);

      const userTurn: UserTurn = {
        id: newId(),
        role: 'user',
        text: message,
        ...(attached.length > 0 ? { images: attached } : {}),
      };
      const assistantTurn: AssistantTurn = { id: newId(), role: 'assistant', parts: [], streaming: true };
      writeTurns((current) => [...current, userTurn, assistantTurn]);

      const pageContext = callbacks.current.page?.() ?? undefined;
      void run(
        {
          conversationId: conversationRef.current ?? undefined,
          message,
          images: attached.length > 0 ? attached : undefined,
          reject: unanswered.length > 0 ? unanswered : undefined,
          page: pageContext ?? undefined,
        },
        assistantTurn.id,
      );
    },
    [pending, run, writeTurns],
  );

  const answer = useCallback(
    (callId: string, decision: 'approve' | 'reject') => {
      const turn = [...turns]
        .reverse()
        .find(
          (entry): entry is AssistantTurn =>
            entry.role === 'assistant' &&
            entry.parts.some((part) => part.type === 'tool' && part.callId === callId),
        );
      if (!turn || !conversationRef.current) return;
      void run(
        {
          conversationId: conversationRef.current,
          approve: decision === 'approve' ? [callId] : undefined,
          reject: decision === 'reject' ? [callId] : undefined,
        },
        turn.id,
      );
    },
    [run, turns],
  );

  const approve = useCallback((callId: string) => answer(callId, 'approve'), [answer]);
  const reject = useCallback((callId: string) => answer(callId, 'reject'), [answer]);

  const retry = useCallback(() => {
    const last = lastMessage.current;
    if (!last) return;
    // The failed turn stays as the record; the retry is a fresh exchange, and
    // it carries the same pictures — they never reached the model.
    send(last.text, last.images);
  }, [send]);

  const newConversation = useCallback(() => {
    stop();
    conversationRef.current = null;
    lastMessage.current = null;
    setConversationId(null);
    writeTurns(() => []);
    setMoment('idle');
  }, [stop, writeTurns]);

  const resume = useCallback(
    (id: string, transcript: Turn[]) => {
      stop();
      conversationRef.current = id;
      lastMessage.current = null;
      setConversationId(id);
      writeTurns(() => transcript);
      setMoment(
        transcript.some(
          (turn) =>
            turn.role === 'assistant' &&
            turn.parts.some((part) => part.type === 'tool' && part.status === 'pending'),
        )
          ? 'approval'
          : 'idle',
      );
    },
    [stop, writeTurns],
  );

  useEffect(() => stop, [stop]);

  return {
    turns,
    conversationId,
    moment,
    busy,
    pending,
    send,
    approve,
    reject,
    retry,
    stop,
    newConversation,
    resume,
  };
}
