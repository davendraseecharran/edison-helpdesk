'use client';

/**
 * The assistant panel.
 *
 * On a wide screen it docks to the right edge under the top bar and leaves
 * the page alive: no scrim, no focus trap, `Escape` only closes it when the
 * focus is inside. Between 720 and 1023px it overlays the page behind a
 * light scrim and behaves as a modal; below 720px it is a full-screen sheet
 * from the bottom with the composer pinned above the keyboard. One
 * component, three layouts, the same conversation.
 *
 * What it shows depends on what the server says: nothing is possible when
 * the deployment has no `AI_TOKEN_KEY`; the connection card when there is no
 * ChatGPT account linked; otherwise the conversation, with the welcome when
 * it is empty. The orb is the one status indicator: it sits in the welcome
 * while there is nothing else to look at, and takes its place in the header
 * once the conversation has begun.
 *
 * Opening: the top-bar toggle, `Ctrl/Cmd+J`, or the `edison:open-assistant`
 * event, which can carry a prompt to send at once or ask for the
 * connection step. Closing hands focus back to the toggle. Work in flight is
 * not cancelled by closing; the toggle shows it instead.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis, MessagesSquare, SquarePen, Unplug, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useBodyScrollLock, useEscape, useFocusTrap, useOutsidePress } from '@/components/ui/focus';
import { useMediaQuery, usePhone, useReducedMotion } from '@/components/ui/media';
import { AnimatePresence, DURATION, EASE_OUT_FAST, INSTANT, SPRING } from '@/components/ui/Motion';
import { OpenBeam } from '@/components/ui/OpenBeam';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import type { ConversationSummary } from '@/lib/ai/conversations';
import type { Reasoning } from '@/lib/ai/responses-client';
import { AiComposer, type AiComposerHandle } from './AiComposer';
import { AiConnectCard } from './AiConnectCard';
import { AiMessage } from './AiMessage';
import { OPEN_ASSISTANT_EVENT, readOpenDetail, setAssistant } from './assistant-store';
import { ConversationList } from './ConversationList';
import { Orb } from './Orb';
import type { Moment } from './orb-state';
import { readPageContext, usePageContext } from './page-context';
import { serverServices, type AiServices, type AiStatus } from './services';
import { turnsFromTranscript, useAiChat, type ChatBlock, type Turn } from './useAiChat';
import { useSpeaker, useSpeechRecognition } from './useSpeech';
import '@/styles/ai.css';

/** What the header says before the server has told the panel which model it runs. */
const MODEL_LABEL = 'GPT-5.6 Luna';

const REASONING_OPTIONS: { value: Reasoning; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

const EXAMPLES = [
  'What is waiting in the queue?',
  'Summarise my open tickets',
  'Which devices are out for repair?',
];

const ALWAYS_ASKS = 'This change always asks first, whatever the setting.';

type View = 'chat' | 'connect' | 'conversations';

export interface AiPanelProps {
  services?: AiServices;
  /** Start open, for the dev demo. */
  initialOpen?: boolean;
  /** Start on this view, for the dev demo. */
  initialView?: View;
  /** Start with a conversation on screen, for the dev demo. */
  initialTurns?: Turn[];
}

export function AiPanel({
  services = serverServices,
  initialOpen = false,
  initialView = 'chat',
  initialTurns,
}: AiPanelProps) {
  const { notify } = useRuntime();
  const phone = usePhone();
  const wide = useMediaQuery('(min-width: 1024px)');
  const reduced = useReducedMotion();
  const layout: 'phone' | 'scrim' | 'docked' = phone ? 'phone' : wide ? 'docked' : 'scrim';
  const modal = layout !== 'docked';

  const [open, setOpen] = useState(initialOpen);
  const [exiting, setExiting] = useState(false);
  const [requestedView, setRequestedView] = useState<View>(initialView);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [connectAtOnce, setConnectAtOnce] = useState(false);
  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);

  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<AiComposerHandle>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuRefs = useMemo(() => [menuButtonRef, menuRef], []);
  const queuedPrompt = useRef<string | null>(null);
  const stickToBottom = useRef(true);
  const dictationBase = useRef('');

  // Mirrors for handlers that must see the latest value without re-binding.
  const openRef = useRef(open);
  const statusRef = useRef<AiStatus | null>(null);
  useEffect(() => {
    openRef.current = open;
    statusRef.current = status;
  }, [open, status]);

  const speaker = useSpeaker();

  const onReply = useCallback(
    (text: string) => {
      if (!openRef.current) setUnread(true);
      if (statusRef.current?.speakReplies) speaker.speak(text);
    },
    [speaker],
  );

  // The chat route knows before the panel does when a connection is gone.
  const onBlocked = useCallback(
    (block: ChatBlock, message: string) => {
      if (block === 'not_connected') {
        setStatus((current) => (current ? { ...current, connected: false } : current));
        setRequestedView('connect');
      } else if (block === 'disabled') {
        setStatus((current) => (current ? { ...current, enabled: false } : current));
      } else {
        notify('error', message);
      }
    },
    [notify],
  );

  const chat = useAiChat({
    transport: services.transport,
    page: readPageContext,
    onReply,
    onBlocked,
    initial: initialTurns ? { conversationId: 'demo', turns: initialTurns } : undefined,
  });
  const pageContext = usePageContext();

  const speech = useSpeechRecognition({
    onInterim: (text) => setDraft(`${dictationBase.current}${dictationBase.current ? ' ' : ''}${text}`),
    onFinal: (text) => {
      dictationBase.current = `${dictationBase.current}${dictationBase.current ? ' ' : ''}${text}`;
      setDraft(dictationBase.current);
    },
  });

  // The members, not the objects. `useAiChat`, `useSpeaker` and
  // `useSpeechRecognition` each hand back a fresh object every render, so
  // anything built on one of those objects changes identity every render too —
  // which is how a child's effect ends up torn down and restarted for no
  // reason. These three functions do not change.
  const { send: sendToChat, newConversation: resetConversation } = chat;
  const { cancel: stopSpeaking } = speaker;
  const { stop: stopListening } = speech;

  // Dictation appends to whatever was typed; keep the base in step with edits.
  useEffect(() => {
    if (!speech.listening) dictationBase.current = draft;
  }, [draft, speech.listening]);

  const ready = status?.enabled === true && status.connected;

  // Not connected: the connection card is the only useful thing to show.
  const view: View =
    status && status.enabled && !status.connected && requestedView === 'chat' ? 'connect' : requestedView;

  const moment: Moment = speech.listening ? 'listening' : speaker.speaking ? 'speaking' : chat.moment;

  // --- Sending --------------------------------------------------------------

  const sendText = useCallback(
    (text: string) => {
      stopSpeaking();
      stickToBottom.current = true;
      setRequestedView('chat');
      sendToChat(text);
    },
    [sendToChat, stopSpeaking],
  );

  /** A prompt handed in from elsewhere: sent if the assistant can, kept in the field if not. */
  const deliver = useCallback(
    (prompt: string, known: AiStatus) => {
      if (known.enabled && known.connected) sendText(prompt);
      else setDraft(prompt);
    },
    [sendText],
  );

  // --- Status -----------------------------------------------------------

  /** Takes a fresh status, and sends anything that was waiting for it. */
  const applyStatus = useCallback(
    (next: AiStatus) => {
      setStatus(next);
      const prompt = queuedPrompt.current;
      if (prompt !== null) {
        queuedPrompt.current = null;
        deliver(prompt, next);
      }
    },
    [deliver],
  );

  const refreshStatus = useCallback(async () => {
    const next = await services.status();
    applyStatus(next);
    return next;
  }, [services, applyStatus]);

  // Both are held steady on purpose. The connection card polls ChatGPT from an
  // effect that depends on them, and an inline arrow here would restart that
  // poll — and with it the wait for the person to type the code — every time
  // anything else on the panel re-rendered.
  const onConnected = useCallback(() => {
    setConnectAtOnce(false);
    void refreshStatus().then(() => setRequestedView('chat'));
  }, [refreshStatus]);

  const onDisconnected = useCallback(() => {
    setConnectAtOnce(false);
    resetConversation();
    void refreshStatus();
  }, [resetConversation, refreshStatus]);

  // The first open asks the server where things stand.
  useEffect(() => {
    if (!open || status !== null) return;
    let cancelled = false;
    void services.status().then((next) => {
      if (!cancelled) applyStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [open, status, services, applyStatus]);

  // --- Opening and closing ------------------------------------------------

  const openPanel = useCallback(() => {
    setOpen(true);
    setUnread(false);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setMenuOpen(false);
    if (speech.listening) stopListening();
    // Closing the panel ends the voice, both ways: nothing is listening and
    // nothing carries on reading the last reply out to the room.
    stopSpeaking();
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-ai-toggle]')?.focus();
    });
  }, [speech.listening, stopListening, stopSpeaking]);

  useEffect(() => {
    function onOpenEvent(event: Event) {
      const detail = readOpenDetail(event);
      if (detail.toggle) {
        if (openRef.current) close();
        else openPanel();
        return;
      }
      if (detail.section === 'connect') {
        setRequestedView('connect');
        setConnectAtOnce(true);
      }
      if (detail.prompt) {
        const known = statusRef.current;
        if (known) deliver(detail.prompt, known);
        else queuedPrompt.current = detail.prompt;
      }
      openPanel();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'j' || event.isComposing) return;
      event.preventDefault();
      if (openRef.current) close();
      else openPanel();
    }
    window.addEventListener(OPEN_ASSISTANT_EVENT, onOpenEvent);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener(OPEN_ASSISTANT_EVENT, onOpenEvent);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, openPanel, deliver]);

  // `present` outlives `open` by the length of the exit animation.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setExiting(true);
  }
  const present = open || exiting;

  useFocusTrap(panelRef, present && modal);
  useBodyScrollLock(present && modal);
  useEscape(open && modal && !menuOpen, close);

  // Docked: Escape closes only from inside the panel, so a field on the page
  // keeps its own Escape.
  useEffect(() => {
    if (!open || modal) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || menuOpen) return;
      if (!panelRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, modal, menuOpen, close]);

  // Focus lands inside the panel when it opens: the composer when there is
  // one, otherwise the panel itself, so Escape and Tab start from here.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (view === 'chat' && ready) {
        composerRef.current?.focus();
        return;
      }
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, view, ready]);

  // The phone keyboard: size the sheet to what is still visible.
  useEffect(() => {
    if (!open || layout !== 'phone') return;
    const viewport = window.visualViewport;
    const panel = panelRef.current;
    if (!viewport || !panel) return;
    const apply = () => panel.style.setProperty('--ai-vh', `${Math.round(viewport.height)}px`);
    apply();
    viewport.addEventListener('resize', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      panel.style.removeProperty('--ai-vh');
    };
  }, [open, layout]);

  // --- What the rest of the shell sees ------------------------------------

  useEffect(() => {
    setAssistant({ open, moment, busy: chat.busy, unread });
  }, [open, moment, chat.busy, unread]);

  // --- Menu -----------------------------------------------------------------

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useFocusTrap(menuRef, menuOpen);
  useEscape(menuOpen, closeMenu);
  useOutsidePress(menuOpen, menuRefs, closeMenu);

  async function savePreference(
    patch: Partial<Pick<AiStatus, 'reasoning' | 'confirmChanges' | 'speakReplies'>>,
    failure: string,
  ) {
    const before = status;
    if (!before) return;
    setStatus({ ...before, ...patch });
    const result = await services.updatePreferences(patch);
    if (!result.ok) {
      setStatus(before);
      notify('error', result.error ?? failure);
    }
  }

  async function showConversations() {
    setMenuOpen(false);
    setRequestedView('conversations');
    setConversationsLoading(true);
    setConversationsError(null);
    const result = await services.listConversations();
    setConversationsLoading(false);
    if (!result.ok) setConversationsError(result.error ?? 'Could not load conversations.');
    setConversations(result.conversations);
  }

  async function openConversation(id: string) {
    const result = await services.loadConversation(id);
    if (!result.ok) {
      notify('error', result.error ?? 'Could not open that conversation.');
      return;
    }
    speaker.cancel();
    chat.resume(id, turnsFromTranscript(result.items, result.pending));
    setRequestedView('chat');
  }

  async function deleteConversation(id: string) {
    const result = await services.deleteConversation(id);
    if (!result.ok) {
      notify('error', result.error ?? 'Could not delete that conversation.');
      return;
    }
    setConversations((current) => current.filter((entry) => entry.id !== id));
    if (chat.conversationId === id) chat.newConversation();
  }

  function startNewConversation() {
    setMenuOpen(false);
    speaker.cancel();
    chat.newConversation();
    setDraft('');
    setRequestedView('chat');
  }

  function send() {
    const text = draft.trim();
    if (text === '' || !ready) return;
    if (speech.listening) speech.stop();
    sendText(text);
    setDraft('');
    dictationBase.current = '';
  }

  // Keep the newest line in view while a reply grows, unless the reader has
  // scrolled up to look at something.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !stickToBottom.current) return;
    body.scrollTop = body.scrollHeight;
  }, [chat.turns]);

  function onBodyScroll() {
    const body = bodyRef.current;
    if (!body) return;
    stickToBottom.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
  }

  // --- Render ---------------------------------------------------------------

  const showWelcome = view === 'chat' && chat.turns.length === 0;
  const headerOrb = !showWelcome && view !== 'connect';
  const level = speech.listening ? speech.level : speaker.speaking ? 0.35 : undefined;
  const hidden = layout === 'phone' ? { y: '100%' } : { x: '100%' };
  const shown = layout === 'phone' ? { y: 0 } : { x: 0 };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence onExitComplete={() => setExiting(false)}>
      {open ? (
        <div key="assistant" className="ai-root" data-layout={layout} data-keyboard-owner="true">
          {modal ? (
            <motion.div
              className="ai-scrim"
              aria-hidden="true"
              onClick={close}
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduced ? undefined : { opacity: 0 }}
              transition={reduced ? INSTANT : { duration: DURATION.fast }}
            />
          ) : null}
          <motion.div
            ref={panelRef}
            className="ai-panel"
            role="dialog"
            aria-modal={modal || undefined}
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={reduced ? false : hidden}
            animate={shown}
            exit={reduced ? undefined : { ...hidden, transition: EASE_OUT_FAST }}
            transition={reduced ? INSTANT : SPRING}
          >
            <OpenBeam className="ai-frame">
              <header className="ai-head">
                <div className="ai-head-row">
                  {headerOrb ? (
                    <motion.div
                      className="ai-head-orb"
                      initial={reduced ? false : { opacity: 0, scale: 0.7 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={reduced ? INSTANT : SPRING}
                    >
                      <Orb moment={moment} size={64} level={level} />
                    </motion.div>
                  ) : null}
                  <div className="ai-head-text">
                    <h2 id={titleId} className="ai-title">
                      Assistant
                    </h2>
                    <p className="ai-model">{status?.modelLabel ?? MODEL_LABEL}</p>
                  </div>
                  <div className="ai-head-actions">
                    <span className="menu-anchor">
                      <Button
                        ref={menuButtonRef}
                        variant="ghost"
                        icon={Ellipsis}
                        aria-label="Assistant menu"
                        aria-haspopup="dialog"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOpen((value) => !value)}
                      />
                      {menuOpen ? (
                        <div
                          ref={menuRef}
                          role="dialog"
                          aria-label="Assistant settings"
                          className="popover popover-end ai-menu"
                          tabIndex={-1}
                        >
                          <button
                            type="button"
                            role="switch"
                            className="ai-menu-switch"
                            aria-checked={status?.confirmChanges === true}
                            disabled={!status}
                            onClick={() =>
                              void savePreference(
                                { confirmChanges: !(status?.confirmChanges === true) },
                                'Could not save that setting.',
                              )
                            }
                          >
                            <span>Ask before changes</span>
                            <span className="ai-switch" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            role="switch"
                            className="ai-menu-switch"
                            aria-checked={status?.speakReplies === true}
                            disabled={!status || !speaker.supported}
                            onClick={() => {
                              if (status?.speakReplies) speaker.cancel();
                              void savePreference(
                                { speakReplies: !(status?.speakReplies === true) },
                                'Could not save that setting.',
                              );
                            }}
                          >
                            <span>Speak replies</span>
                            <span className="ai-switch" aria-hidden="true" />
                          </button>
                          <div className="menu-separator" role="separator" />
                          <button
                            type="button"
                            className="menu-item"
                            onClick={() => void showConversations()}
                            disabled={!ready}
                          >
                            <Icon icon={MessagesSquare} size={16} />
                            <span>Conversations</span>
                          </button>
                          <button
                            type="button"
                            className="menu-item"
                            onClick={startNewConversation}
                            disabled={!ready}
                          >
                            <Icon icon={SquarePen} size={16} />
                            <span>New conversation</span>
                          </button>
                          <div className="menu-separator" role="separator" />
                          <button
                            type="button"
                            className="menu-item menu-item-danger"
                            disabled={!status?.connected}
                            onClick={() => {
                              setMenuOpen(false);
                              setConnectAtOnce(false);
                              setRequestedView('connect');
                            }}
                          >
                            <Icon icon={Unplug} size={16} />
                            <span>Disconnect</span>
                          </button>
                        </div>
                      ) : null}
                    </span>
                    <Button variant="ghost" icon={X} aria-label="Close" title="Close" onClick={close} />
                  </div>
                </div>
                {view === 'chat' && status?.enabled !== false ? (
                  <div className="ai-head-row ai-head-reasoning">
                    <span className="ai-reasoning-label">Reasoning</span>
                    <SegmentedControl
                      label="Reasoning effort"
                      size="sm"
                      value={status?.reasoning ?? 'high'}
                      options={REASONING_OPTIONS}
                      onChange={(next) =>
                        void savePreference({ reasoning: next }, 'Could not save the reasoning level.')
                      }
                    />
                  </div>
                ) : null}
              </header>

              <div className="ai-body" ref={bodyRef} onScroll={onBodyScroll}>
                {status?.enabled === false ? (
                  <div className="ai-note">
                    <Orb moment="error" size={64} className="ai-note-orb" />
                    <p>The assistant is not enabled on this deployment.</p>
                    <p className="subtle">An administrator has to set AI_TOKEN_KEY on the server.</p>
                  </div>
                ) : view === 'connect' ? (
                  <AiConnectCard
                    services={services}
                    connection={
                      status?.connected ? { email: status.email, planType: status.planType } : null
                    }
                    notify={notify}
                    autoStart={connectAtOnce}
                    onConnected={onConnected}
                    onDisconnected={onDisconnected}
                  />
                ) : view === 'conversations' ? (
                  <ConversationList
                    conversations={conversations}
                    loading={conversationsLoading}
                    error={conversationsError}
                    currentId={chat.conversationId}
                    onOpen={(id) => void openConversation(id)}
                    onDelete={(id) => void deleteConversation(id)}
                    onBack={() => setRequestedView('chat')}
                  />
                ) : showWelcome ? (
                  <div className="ai-welcome">
                    <div className="ai-welcome-orb">
                      <Orb moment={moment} size={64} level={level} />
                    </div>
                    <p className="ai-welcome-text">Ask anything about tickets, people or devices.</p>
                    {status ? (
                      <div className="ai-examples">
                        {EXAMPLES.map((example) => (
                          <button
                            key={example}
                            type="button"
                            className="ai-example"
                            onClick={() => sendText(example)}
                            disabled={!ready}
                          >
                            {example}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="ai-turns">
                    {chat.turns.map((turn, index) => (
                      <AiMessage
                        key={turn.id}
                        turn={turn}
                        last={index === chat.turns.length - 1}
                        moment={chat.moment}
                        busy={chat.busy}
                        approvalNote={status?.confirmChanges ? undefined : ALWAYS_ASKS}
                        onApprove={chat.approve}
                        onReject={chat.reject}
                        onRetry={chat.retry}
                      />
                    ))}
                  </div>
                )}
              </div>

              {view === 'chat' && status?.enabled !== false ? (
                <AiComposer
                  ref={composerRef}
                  value={draft}
                  onChange={setDraft}
                  onSend={send}
                  onStop={chat.stop}
                  busy={chat.busy}
                  disabled={!ready}
                  speech={speech.supported ? speech : null}
                  page={pageContext}
                  placeholder={status ? undefined : 'Getting ready'}
                />
              ) : null}
            </OpenBeam>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
