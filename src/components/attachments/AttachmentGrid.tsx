'use client';

/**
 * The files on a record, as a wall of thumbnails.
 *
 * A photograph is recognised, not read, so the picture is the control: the tile
 * IS the button that opens it, and the name, the person and the time sit under
 * it as the caption. A PDF has no picture to show, so it gets a glyph and its
 * name does the recognising instead.
 *
 * Thumbnails are signed URLs, fetched once when the grid appears and valid for
 * a minute. That is long enough for the browser to load the image and keep the
 * bytes; anything shown later — the lightbox, a download — asks for its own
 * fresh link rather than reusing one that has since expired.
 */

import { useEffect, useState } from 'react';
import { FileText, Trash2 } from 'lucide-react';
import type { Attachment } from '@/lib/attachments';
import { formatBytes, isImageMime } from '@/lib/attachments';
import { attachmentUrlAction, deleteAttachmentAction } from '@/lib/data/attachment-actions';
import { nameOf } from '@/lib/directory';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { TimeAgo } from '@/components/Primitives';
import { ActorLabel } from '@/components/ui/ActorLabel';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { Lightbox } from './Lightbox';

export interface AttachmentGridProps {
  items: Attachment[];
  /** Called once the row is gone, so the panel can drop it from its list. */
  onDeleted: (id: string) => void;
}

export function AttachmentGrid({ items, onDeleted }: AttachmentGridProps) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();

  const [urls, setUrls] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<Attachment | null>(null);

  // Only the pictures need a link up front: a PDF tile shows a glyph, and asks
  // for its URL when somebody actually opens it.
  const imageKey = items
    .filter((item) => isImageMime(item.mime))
    .map((item) => item.id)
    .join(',');

  useEffect(() => {
    const wanted = imageKey === '' ? [] : imageKey.split(',');
    if (wanted.length === 0) return;
    let current = true;

    void Promise.all(
      wanted.map(async (id) => {
        const result = await attachmentUrlAction(id);
        return result.ok ? ([id, result.url] as const) : null;
      }),
    ).then((pairs) => {
      if (!current) return;
      const next: Record<string, string> = {};
      for (const pair of pairs) if (pair) next[pair[0]] = pair[1];
      setUrls(next);
    });

    return () => {
      current = false;
    };
  }, [imageKey]);

  async function onConfirmDelete() {
    const target = confirming;
    if (!target) return;
    const result = await run(`attachment:delete:${target.id}`, () =>
      deleteAttachmentAction(target.id),
    );
    if (result.ok) {
      setConfirming(null);
      setOpen(null);
      onDeleted(target.id);
    }
  }

  if (items.length === 0) return null;

  return (
    <>
      <ul className="attachments-grid">
        {items.map((item, index) => {
          const image = isImageMime(item.mime);
          const url = urls[item.id];
          const mayRemove = actor.role === 'admin' || item.uploadedBy === actor.id;

          return (
            <li className="attachment" key={item.id}>
              <button
                type="button"
                className="attachment-open"
                onClick={() => setOpen(index)}
                aria-label={`Open ${item.filename}`}
              >
                {image ? (
                  url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="attachment-thumb"
                      src={url}
                      alt={item.filename}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <Skeleton className="attachment-thumb" />
                  )
                ) : (
                  <span className="attachment-glyph">
                    <Icon icon={FileText} size={28} />
                    <span className="attachment-kind">PDF</span>
                  </span>
                )}
              </button>

              <div className="attachment-meta">
                <span className="attachment-name" title={item.filename}>
                  {item.filename}
                </span>
                <span className="attachment-sub">
                  <ActorLabel name={nameOf(directory, item.uploadedBy)} />
                  {', '}
                  <TimeAgo iso={item.uploadedAt} />
                </span>
                <span className="attachment-size">{formatBytes(item.bytes)}</span>
              </div>

              {mayRemove ? (
                <Button
                  className="attachment-remove"
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  aria-label={`Remove ${item.filename}`}
                  disabled={pendingKey !== null}
                  onClick={() => setConfirming(item)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>

      <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Remove this attachment?"
        description={
          confirming
            ? `${confirming.filename} will be deleted from the record and from storage.`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={onConfirmDelete}
              loading={pendingKey === `attachment:delete:${confirming?.id}`}
            >
              Remove attachment
            </Button>
          </>
        }
      >
        <p className="muted">
          The removal is recorded in the history. This cannot be undone, so upload the file again if
          it is still needed.
        </p>
      </Dialog>
    </>
  );
}
