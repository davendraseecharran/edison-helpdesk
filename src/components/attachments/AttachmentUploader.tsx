'use client';

/**
 * Adding a photograph or a PDF to a record.
 *
 * The work happens in four steps and the person sees three of them.
 *
 *   1. The picture is shrunk in the browser — 1600px, JPEG 0.85 — because the
 *      file came off a phone and is four megabytes of detail nobody will look
 *      at. See `@/lib/image/resize`.
 *   2. The server is asked for permission and answers with a URL good for one
 *      path and one file. The browser never picks where anything lands.
 *   3. The bytes go straight to storage, with a real progress bar: this is a
 *      technician on school wifi holding a phone, and a spinner that might mean
 *      anything is not good enough.
 *   4. The server reads the object back and records it. Only then is the file
 *      on the ticket, which is why the bar sits at "Saving" for a beat.
 *
 * Every failure is reported against the file it belongs to and leaves the rest
 * of the batch alone, because half the point of uploading four photographs at
 * once is not having to work out which one the machine disliked.
 */

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, Paperclip, Upload } from 'lucide-react';
import type { Attachment, AttachmentTarget } from '@/lib/attachments';
import { ATTACHMENT_ACCEPT, attachmentRefusal, formatBytes } from '@/lib/attachments';
import { prepareUpload } from '@/lib/image/resize';
import { registerAttachmentAction, requestUploadAction } from '@/lib/data/attachment-actions';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { usePhone } from '@/components/ui/media';

export interface AttachmentUploaderProps {
  target: AttachmentTarget;
  /** Each file as it lands, so the grid fills in without waiting for the rest. */
  onUploaded: (attachment: Attachment) => void;
}

type Stage = 'preparing' | 'uploading' | 'saving' | 'done' | 'error';

interface QueuedFile {
  key: string;
  name: string;
  size: number;
  stage: Stage;
  /** 0 to 1, from the request's own upload events. */
  progress: number;
  error?: string;
}

const STAGE_LABEL: Record<Stage, string> = {
  preparing: 'Preparing',
  uploading: 'Uploading',
  saving: 'Saving',
  done: 'Added',
  error: 'Not added',
};

/** Storage answers in JSON. One of its messages is worth passing on verbatim. */
function uploadFailure(status: number, body: string): string {
  let message = '';
  try {
    message = String((JSON.parse(body) as { message?: string }).message ?? '');
  } catch {
    message = '';
  }
  const text = message.toLowerCase();
  if (text.includes('mime') || status === 415) {
    return 'Attach a JPEG, PNG, WebP, GIF or PDF.';
  }
  if (text.includes('maximum allowed size') || status === 413) {
    return 'Attachments are limited to 8 MB. Compress the file and try again.';
  }
  if (status === 0) {
    return 'The upload was interrupted. Check your connection and try again.';
  }
  return 'That file could not be uploaded. Try again.';
}

/**
 * The bytes, straight to storage, over a request that reports its own progress.
 *
 * `fetch` cannot say how far through an upload it is, and this is the one place
 * in the application where that matters, so the older interface earns its keep.
 * The body is the multipart form the storage API expects from a signed upload.
 */
function putToSignedUrl(
  signedUrl: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', signedUrl, true);
    request.setRequestHeader('x-upsert', 'false');

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve();
        return;
      }
      reject(new Error(uploadFailure(request.status, request.responseText)));
    });
    request.addEventListener('error', () => reject(new Error(uploadFailure(0, ''))));
    request.addEventListener('abort', () => reject(new Error(uploadFailure(0, ''))));

    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', file, file.name);
    request.send(form);
  });
}

export function AttachmentUploader({ target, onUploaded }: AttachmentUploaderProps) {
  const { notify } = useRuntime();
  const router = useRouter();
  const phone = usePhone();

  const pickerRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const busy = useRef(false);

  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const describedBy = useId();

  function update(key: string, patch: Partial<QueuedFile>) {
    setQueue((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
  }

  async function uploadOne(chosen: File, key: string): Promise<boolean> {
    // 1. Shrink it, where shrinking helps.
    let file = chosen;
    try {
      file = await prepareUpload(chosen);
    } catch (error) {
      update(key, {
        stage: 'error',
        error: error instanceof Error ? error.message : 'That photo could not be read.',
      });
      return false;
    }

    const refusal = attachmentRefusal({ name: file.name, type: file.type, size: file.size });
    if (refusal) {
      update(key, { stage: 'error', error: refusal });
      return false;
    }
    update(key, { name: file.name, size: file.size });

    // 2. Ask. The answer is a URL for one path, chosen by the server.
    const grant = await requestUploadAction({
      ...target,
      filename: file.name,
      mime: file.type,
      bytes: file.size,
    });
    if (!grant.ok) {
      update(key, { stage: 'error', error: grant.error });
      return false;
    }

    // 3. Send.
    update(key, { stage: 'uploading', progress: 0 });
    try {
      await putToSignedUrl(grant.signedUrl, file, (fraction) =>
        update(key, { progress: fraction }),
      );
    } catch (error) {
      update(key, {
        stage: 'error',
        error: error instanceof Error ? error.message : uploadFailure(0, ''),
      });
      return false;
    }

    // 4. Record it, from what storage actually took.
    update(key, { stage: 'saving', progress: 1 });
    const registered = await registerAttachmentAction({
      ...target,
      path: grant.path,
      filename: grant.filename,
    });
    if (!registered.ok) {
      update(key, { stage: 'error', error: registered.error });
      return false;
    }

    update(key, { stage: 'done' });
    onUploaded(registered.attachment);
    return true;
  }

  async function addFiles(files: File[]) {
    if (files.length === 0 || busy.current) return;
    busy.current = true;

    const entries: QueuedFile[] = files.map((file) => {
      counter.current += 1;
      return {
        key: `upload-${counter.current}`,
        name: file.name,
        size: file.size,
        stage: 'preparing' as Stage,
        progress: 0,
      };
    });
    // Only the failures stay on screen, so a new batch clears the last one's
    // successes rather than growing a list nobody reads.
    setQueue((current) => [...current.filter((entry) => entry.stage === 'error'), ...entries]);

    let added = 0;
    // One at a time: four photographs sharing one phone connection finish
    // sooner in a queue than in a race, and the progress bar means something.
    for (const [index, file] of files.entries()) {
      if (await uploadOne(file, entries[index].key)) added += 1;
    }

    busy.current = false;
    if (added > 0) {
      notify('success', added === 1 ? 'Attachment added.' : `${added} attachments added.`);
      // The history gained an event, so the timeline and the counts re-read.
      router.refresh();
      setQueue((current) => current.filter((entry) => entry.stage === 'error'));
    }
  }

  function onPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    // Cleared so choosing the same file twice in a row still fires a change.
    event.target.value = '';
    void addFiles(files);
  }

  return (
    <div className="attachments-add">
      <div
        className={dragging ? 'attachment-drop attachment-drop-over' : 'attachment-drop'}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void addFiles(Array.from(event.dataTransfer.files ?? []));
        }}
      >
        <Icon icon={Upload} size={20} className="attachment-drop-glyph" />
        <div className="attachment-drop-text">
          {/* The zone is a drop target on a desktop and a plain row of buttons
              on a phone, so the invitation to drag only appears where dragging
              is possible. The button beside it names the action either way. */}
          {phone ? null : <p className="attachment-drop-title">Drag files here</p>}
          <p className="attachment-drop-hint" id={describedBy}>
            Up to 8 MB each. Photos are shrunk before they are sent.
          </p>
        </div>
        <div className="attachment-drop-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={Paperclip}
            aria-describedby={describedBy}
            onClick={() => pickerRef.current?.click()}
          >
            Add photo or PDF
          </Button>
          {phone ? (
            <Button
              variant="secondary"
              size="sm"
              icon={Camera}
              onClick={() => cameraRef.current?.click()}
            >
              Take a photo
            </Button>
          ) : null}
        </div>

        <input
          ref={pickerRef}
          className="visually-hidden"
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={onPicked}
          tabIndex={-1}
          aria-hidden="true"
        />
        {/*
          A second input, for phones only. `capture` opens the camera directly,
          which is what somebody standing over a broken laptop wants — but it
          also takes away the choice of an existing photo or a PDF, so it is
          never the only way in.
        */}
        <input
          ref={cameraRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onPicked}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>

      {queue.length > 0 ? (
        <ul className="attachment-queue" aria-live="polite">
          {queue.map((entry) => (
            <li
              className={entry.stage === 'error' ? 'attachment-job attachment-job-bad' : 'attachment-job'}
              key={entry.key}
            >
              <div className="attachment-job-head">
                <span className="attachment-job-name">{entry.name}</span>
                <span className="attachment-job-stage">
                  {entry.stage === 'uploading'
                    ? `${Math.round(entry.progress * 100)}%`
                    : STAGE_LABEL[entry.stage]}
                </span>
              </div>
              {entry.stage === 'error' ? (
                <p className="attachment-job-error">{entry.error}</p>
              ) : (
                <>
                  <div
                    className="attachment-bar"
                    role="progressbar"
                    aria-label={`Uploading ${entry.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(entry.progress * 100)}
                  >
                    <span
                      className="attachment-bar-fill"
                      style={{ width: `${Math.max(4, Math.round(entry.progress * 100))}%` }}
                    />
                  </div>
                  <p className="attachment-job-size">{formatBytes(entry.size)}</p>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
