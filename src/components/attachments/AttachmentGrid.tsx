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

/** One shared empty map, so a render with no links does not make a new object. */
const NO_URLS: Record<string, string> = {};

/** One shared empty map, so a render with no re-sign rounds does not make a new object. */
const NO_ROUNDS: Record<string, number> = {};

/**
 * How many times a failing thumbnail may ask for a fresh link.
 *
 * A signed download link lives sixty seconds (`SIGNED_URL_SECONDS`), and a
 * ticket page is routinely open for longer. The tiles keep the link they were
 * handed, so anything that makes the browser fetch the bytes again — a restored
 * tab, an evicted cache, a print — asks with an expired signature and shows a
 * broken picture until the page is reloaded.
 *
 * Re-signing on a timer would mean one request per picture per minute for every
 * open ticket page, including the ones nobody is looking at. Re-signing when a
 * tile actually fails costs nothing until the moment the old link mattered.
 * Bounded at two rounds because the other reasons a thumbnail fails — the
 * object is genuinely gone, the network is down — must not become a loop; after
 * that the tile falls back to the same placeholder it shows before its link
 * arrives.
 */
const MAX_RESIGN_ROUNDS = 2;

export interface AttachmentGridProps {
  items: Attachment[];
  /** Called once the row is gone, so the panel can drop it from its list. */
  onDeleted: (id: string) => void;
}

export function AttachmentGrid({ items, onDeleted }: AttachmentGridProps) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();

  // The links, with the exact set of pictures they were fetched for. Holding the
  // key alongside them is what keeps a link from an earlier set off the screen:
  // when the set changes — a file removed, the last picture gone — the map no
  // longer matches and nothing is shown until the new links arrive.
  const [links, setLinks] = useState<{ key: string; urls: Record<string, string> }>({
    key: '',
    urls: {},
  });
  const [open, setOpen] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<Attachment | null>(null);
  // Rounds of re-signing asked for by a failing tile, keyed by attachment id
  // so one attachment's exhausted budget does not stop another's tile from
  // asking for its own fresh link, and tied to the set of pictures they were
  // asked for so a new set starts over.
  const [resign, setResign] = useState<{ key: string; rounds: Record<string, number> }>({
    key: '',
    rounds: NO_ROUNDS,
  });

  // Only the pictures need a link up front: a PDF tile shows a glyph, and asks
  // for its URL when somebody actually opens it.
  const imageKey = items
    .filter((item) => isImageMime(item.mime))
    .map((item) => item.id)
    .join(',');

  const urls = links.key === imageKey ? links.urls : NO_URLS;
  const rounds = resign.key === imageKey ? resign.rounds : NO_ROUNDS;

  /** A tile whose link has expired asks for a new one, a bounded number of times. */
  function onThumbnailError(id: string) {
    setResign((previous) => {
      const current = previous.key === imageKey ? previous.rounds : NO_ROUNDS;
      const attempts = current[id] ?? 0;
      if (attempts >= MAX_RESIGN_ROUNDS) return previous;
      return { key: imageKey, rounds: { ...current, [id]: attempts + 1 } };
    });
    // Drop the dead link so the tile shows its placeholder rather than a broken
    // image while the new one is being signed.
    setLinks((previous) => {
      if (previous.key !== imageKey || !(id in previous.urls)) return previous;
      const next = { ...previous.urls };
      delete next[id];
      return { key: imageKey, urls: next };
    });
  }

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
      setLinks({ key: imageKey, urls: next });
    });

    return () => {
      current = false;
    };
    // `rounds` is in the list on purpose: a failing tile bumps it, and that is
    // what re-runs this effect and re-signs the set.
  }, [imageKey, rounds]);

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
                      onError={() => onThumbnailError(item.id)}
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
                  <ActorLabel
                    name={nameOf(directory, item.uploadedBy)}
                    via={item.performedVia}
                    model={item.aiModel}
                  />
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
                  disabled={pendingKey === `attachment:delete:${item.id}`}
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
