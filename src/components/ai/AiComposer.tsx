'use client';

/**
 * Where the person types, talks, or shows.
 *
 * A textarea that grows to six lines, Enter to send and Shift+Enter for a
 * new line, and three buttons: attach, the microphone when the browser has one
 * to offer, and Send, which becomes Stop while a reply is on its way. On a
 * touch screen the microphone is held; with a pointer or a keyboard it is
 * a toggle. Nothing is sent when the microphone lets go: the words are in
 * the field to be read first.
 *
 * Pictures arrive three ways — paste, drop, and the picker — because all three
 * are how somebody actually has one. A screenshot is on the clipboard, a photo
 * off a phone is a file in a folder, and a picture already on screen gets
 * dragged. Each becomes a chip above the field: the thumbnail, because a
 * filename is not how anybody recognises a photograph they just took, and a
 * remove button, because the wrong one gets attached.
 *
 * The rules live in `src/lib/ai/images.ts` and the file work in
 * `useAttachments`; this file is the arrangement and the events.
 */

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { ArrowUp, Check, ChevronDown, FileText, Mic, Plus, Square, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { OpenBeam } from '@/components/ui/OpenBeam';
import { IMAGE_TYPES, MAX_IMAGES } from '@/lib/ai/images';
import type { PageContext } from './page-context';
import { imageFilesFrom, type Attachment } from './useAttachments';
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
  /** The pictures waiting to go with the next message. */
  images?: Attachment[];
  /** Files from a paste, a drop or the picker. */
  onAttach?: (files: readonly File[]) => void;
  onRemoveImage?: (id: string) => void;
  /** What went wrong with the last picture offered. */
  imageNotice?: string | null;
  /** The reasoning level shown in the bar; absent when the panel owns no setting. */
  reasoning?: string;
  reasoningOptions?: readonly { value: string; label: string }[];
  onReasoning?: (value: string) => void;
}

export const AiComposer = forwardRef<AiComposerHandle, AiComposerProps>(function AiComposer(
  {
    value,
    onChange,
    onSend,
    onStop,
    busy,
    disabled,
    speech,
    page,
    placeholder,
    images = [],
    onAttach,
    onRemoveImage,
    imageNotice = null,
    reasoning,
    reasoningOptions,
    onReasoning,
  },
  ref,
) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const holding = useRef(false);
  // A counter rather than a flag: dragging over a child fires dragleave on the
  // parent, and a flag would flicker the frame off every time the pointer
  // crossed the Send button.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const canAttach = onAttach !== undefined;
  const full = images.length >= MAX_IMAGES;

  useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }), []);

  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    field.style.height = '0px';
    const next = Math.min(field.scrollHeight, MAX_HEIGHT);
    field.style.height = `${next}px`;
    field.style.overflowY = field.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [value]);

  // A photograph on its own is a question worth asking.
  const canSend = (value.trim() !== '' || images.length > 0) && !disabled;

  function attach(files: readonly File[]) {
    if (!onAttach || files.length === 0) return;
    onAttach(files);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return;
    const files = imageFilesFrom(event.clipboardData);
    if (files.length === 0) return;
    // Only when there really are pictures: a paste that is text as well as an
    // image should still put the text in the field.
    if (event.clipboardData.getData('text/plain') === '') event.preventDefault();
    attach(files);
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!canAttach || !event.dataTransfer?.types.includes('Files')) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragLeave() {
    if (!canAttach) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!canAttach || !event.dataTransfer?.types.includes('Files')) return;
    // Without this the browser opens the dropped file in the tab, which loses
    // the whole conversation.
    event.preventDefault();
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!canAttach) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    attach(imageFilesFrom(event.dataTransfer));
  }

  function onPicked(event: ChangeEvent<HTMLInputElement>) {
    attach(Array.from(event.target.files ?? []));
    // Cleared so choosing the same file twice in a row still fires a change.
    event.target.value = '';
  }

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
    <div
      className="ai-composer"
      data-listening={speech?.listening || undefined}
      data-dragging={dragging || undefined}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {page ? (
        <div className="ai-composer-context">
          <Icon icon={FileText} size={14} />
          <span>
            Working on{' '}
            <span className={page.kind === 'person' ? undefined : 'mono'}>{page.label}</span>
          </span>
        </div>
      ) : null}
      {images.length > 0 ? (
        <ul className="ai-attachments" aria-label="Pictures attached to this message">
          {images.map((image) => (
            <li key={image.id} className="ai-attachment">
              {/* eslint-disable-next-line @next/next/no-img-element -- A data URL
                  the browser just encoded; there is nothing for the image
                  optimiser to fetch or resize. */}
              <img className="ai-attachment-thumb" src={image.dataUrl} alt="" />
              <span className="ai-attachment-name">{image.name}</span>
              <button
                type="button"
                className="ai-attachment-remove pressable"
                aria-label={`Remove ${image.name}`}
                onClick={() => onRemoveImage?.(image.id)}
              >
                <Icon icon={X} size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {imageNotice ? (
        <p className="ai-composer-notice" role="status">
          {imageNotice}
        </p>
      ) : null}
      <OpenBeam className="ai-composer-beam" once="composer">
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
          onPaste={onPaste}
          data-autofocus
        />
        <div className="ai-composer-bar">
          <div className="ai-composer-actions ai-composer-actions-left">
            {canAttach ? (
              <>
                <input
                  ref={picker}
                  type="file"
                  className="visually-hidden"
                  accept={IMAGE_TYPES.join(',')}
                  multiple
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={onPicked}
                />
                <button
                  type="button"
                  className="ai-attach pressable"
                  aria-label="Add a picture"
                  title={full ? `Up to ${MAX_IMAGES} pictures in one message` : 'Add a picture'}
                  disabled={disabled || full}
                  onClick={() => picker.current?.click()}
                >
                  <Icon icon={Plus} size={18} />
                </button>
              </>
            ) : null}
          </div>
          <div className="ai-composer-actions">
            {reasoning && reasoningOptions && onReasoning ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="ai-reasoning-pick pressable"
                    aria-label="Reasoning level"
                  >
                    {reasoningOptions.find((option) => option.value === reasoning)?.label ?? reasoning}
                    <Icon icon={ChevronDown} size={14} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {reasoningOptions.map((option) => (
                    <DropdownMenuItem key={option.value} onSelect={() => onReasoning(option.value)}>
                      {option.label}
                      {option.value === reasoning ? <Icon icon={Check} size={14} /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {busy ? (
              <Button variant="secondary" icon={Square} aria-label="Stop" title="Stop" onClick={onStop} />
            ) : canSend ? (
              <Button
                variant="primary"
                icon={ArrowUp}
                className="ai-send-round"
                aria-label="Send"
                title="Send"
                onClick={onSend}
              />
            ) : speech ? (
              <button
                type="button"
                className="ai-mic pressable"
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
            ) : (
              <Button
                variant="primary"
                icon={ArrowUp}
                className="ai-send-round"
                aria-label="Send"
                title="Send"
                disabled
              />
            )}
          </div>
        </div>
        </div>
      </OpenBeam>
    </div>
  );
});
