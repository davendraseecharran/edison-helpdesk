'use client';

/**
 * Where the person types, or talks.
 *
 * A textarea that grows to six lines, Enter to send and Shift+Enter for a
 * new line, and two buttons: the microphone, when the browser has one to
 * offer, and Send, which becomes Stop while a reply is on its way. On a
 * touch screen the microphone is held; with a pointer or a keyboard it is
 * a toggle. Nothing is sent when the microphone lets go: the words are in
 * the field to be read first.
 */

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { ArrowUp, FileText, Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { PageContext } from './page-context';
import type { SpeechRecognitionHandle } from './useSpeech';

/** Six lines of 14px body text, plus the field's own padding. */
const MAX_HEIGHT = 6 * 21 + 20;

export interface AiComposerHandle {
  focus: () => void;
}

export interface AiComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** A reply is streaming: Send reads Stop. */
  busy: boolean;
  /** The assistant cannot take a message right now. */
  disabled: boolean;
  speech: SpeechRecognitionHandle | null;
  /** What the current page is about, shown so the person knows the assistant knows. */
  page?: PageContext | null;
  placeholder?: string;
}

export const AiComposer = forwardRef<AiComposerHandle, AiComposerProps>(function AiComposer(
  { value, onChange, onSend, onStop, busy, disabled, speech, page, placeholder },
  ref,
) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const holding = useRef(false);

  useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }), []);

  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    field.style.height = '0px';
    const next = Math.min(field.scrollHeight, MAX_HEIGHT);
    field.style.height = `${next}px`;
    field.style.overflowY = field.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [value]);

  const canSend = value.trim() !== '' && !disabled;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) onSend();
  }

  function onMicPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (!speech) return;
    if (event.pointerType === 'touch') {
      event.preventDefault();
      holding.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      if (!speech.listening) speech.start();
      return;
    }
    holding.current = false;
    if (speech.listening) speech.stop();
    else speech.start();
  }

  function onMicPointerUp() {
    if (!speech || !holding.current) return;
    holding.current = false;
    speech.stop();
  }

  function onMicClick(event: React.MouseEvent<HTMLButtonElement>) {
    // Pointer events handled the press; a click with no pointer is the keyboard.
    if (!speech || event.detail !== 0) return;
    if (speech.listening) speech.stop();
    else speech.start();
  }

  return (
    <div className="ai-composer" data-listening={speech?.listening || undefined}>
      {page ? (
        <div className="ai-composer-context">
          <Icon icon={FileText} size={14} />
          <span>
            Working on{' '}
            <span className={page.kind === 'person' ? undefined : 'mono'}>{page.label}</span>
          </span>
        </div>
      ) : null}
      <div className="ai-composer-row">
        <textarea
          ref={textarea}
          className="ai-composer-field"
          rows={1}
          value={value}
          placeholder={speech?.listening ? 'Listening' : (placeholder ?? 'Ask the assistant')}
          aria-label="Message to the assistant"
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          data-autofocus
        />
        <div className="ai-composer-actions">
          {speech ? (
            <button
              type="button"
              className="ai-mic"
              aria-label={speech.listening ? 'Stop listening' : 'Start listening'}
              aria-pressed={speech.listening}
              title="Press to talk. On a touch screen, hold."
              disabled={disabled}
              onPointerDown={onMicPointerDown}
              onPointerUp={onMicPointerUp}
              onPointerCancel={onMicPointerUp}
              onClick={onMicClick}
            >
              <Icon icon={Mic} size={18} />
            </button>
          ) : null}
          {busy ? (
            <Button variant="secondary" icon={Square} aria-label="Stop" title="Stop" onClick={onStop} />
          ) : (
            <Button
              variant="primary"
              icon={ArrowUp}
              aria-label="Send"
              title="Send"
              disabled={!canSend}
              onClick={onSend}
            />
          )}
        </div>
      </div>
      <p className="ai-composer-hint subtle">Enter to send, Shift+Enter for a new line</p>
    </div>
  );
});
