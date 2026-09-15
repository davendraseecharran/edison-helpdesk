'use client';

/**
 * The pictures waiting in the composer.
 *
 * Three ways in — paste, drop, and the picker — and one way out, which is
 * sending. This hook is the whole of the browser half: it takes files, applies
 * the rules from `src/lib/ai/images.ts`, shrinks a photograph before it is
 * encoded, and hands back a list of chips.
 *
 * The shrink is not an optimisation, it is the difference between working and
 * not. A phone photograph is twelve megapixels and four megabytes; `prepareUpload`
 * draws it into a canvas at 1600px on its long edge and re-encodes it as JPEG,
 * which is a few hundred kilobytes and loses nothing anybody was going to look
 * at. The same function the attachment uploader uses, for the same reason.
 *
 * Nothing here refuses quietly. A file of the wrong sort, a picture that is
 * still too big after the shrink, a fifth picture: each of those returns the
 * sentence that says what happened, and the panel shows it under the composer.
 */

import { useCallback, useRef, useState } from 'react';
import { prepareUpload } from '@/lib/image/resize';
import {
  MAX_IMAGES,
  fileProblem,
  imageProblem,
  type TurnImage,
} from '@/lib/ai/images';

/** One picture in the composer, with the identity a chip needs. */
export interface Attachment extends TurnImage {
  id: string;
}

export interface Attachments {
  items: Attachment[];
  /** What went wrong with the last thing offered, or null. */
  notice: string | null;
  /** Files from a paste, a drop or the picker. */
  add: (files: readonly File[]) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  dismissNotice: () => void;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A file's bytes as the data URL the Responses API takes. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That picture could not be read. Try attaching it again.'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(file);
  });
}

export function useAttachments(): Attachments {
  const [items, setItems] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Read inside the async loop, where `items` would be the value captured when
  // the paste started rather than the value after the first file landed.
  const live = useRef<Attachment[]>([]);

  const write = useCallback((update: (current: Attachment[]) => Attachment[]) => {
    const next = update(live.current);
    live.current = next;
    setItems(next);
  }, []);

  const add = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      let said: string | null = null;

      for (const file of files) {
        const refused = fileProblem(file, live.current.length);
        if (refused !== null) {
          said = refused;
          continue;
        }

        let dataUrl: string;
        try {
          // Shrunk first, judged after: a twelve-megapixel original that
          // becomes a 300 KB JPEG is a picture that attaches perfectly well.
          const smaller = await prepareUpload(file);
          dataUrl = await readAsDataUrl(smaller);
        } catch (error) {
          said = error instanceof Error ? error.message : 'That picture could not be read.';
          continue;
        }

        const attachment: Attachment = { id: newId(), dataUrl, name: file.name || 'picture' };
        const problem = imageProblem(attachment);
        if (problem !== null) {
          said = problem;
          continue;
        }
        if (live.current.length >= MAX_IMAGES) {
          said = fileProblem(file, live.current.length);
          continue;
        }
        write((current) => [...current, attachment]);
      }

      setNotice(said);
    },
    [write],
  );

  const remove = useCallback(
    (id: string) => {
      write((current) => current.filter((item) => item.id !== id));
      setNotice(null);
    },
    [write],
  );

  const clear = useCallback(() => {
    write(() => []);
    setNotice(null);
  }, [write]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { items, notice, add, remove, clear, dismissNotice };
}

/**
 * The image files on a paste or a drop, in the order they were offered.
 *
 * `files` is the ordinary answer and is what a drop and a clipboard image both
 * fill in. `items` is the fallback: some browsers hand a screenshot over as an
 * item with no entry in `files`, and a paste that produced nothing is the one
 * failure this feature cannot explain to anybody.
 */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith('image/')) out.push(file);
  }
  if (out.length > 0) return out;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}
