'use client';

/**
 * One attachment, filling the screen.
 *
 * A thumbnail is enough to tell a photograph of a cracked screen from a
 * photograph of a docking station. It is not enough to see whether the crack
 * reaches the digitiser, which is the question somebody actually opened the
 * ticket to answer — so the picture gets the whole window, and the arrows walk
 * through the rest without going back to the grid.
 *
 * Every URL here is minted fresh when the file is shown. The thumbnail's link
 * expired sixty seconds after the grid loaded, and the download link is asked
 * for separately so the browser is told to save the file rather than replace
 * the page with it.
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText } from 'lucide-react';
import type { Attachment } from '@/lib/attachments';
import { formatBytes, isImageMime } from '@/lib/attachments';
import { attachmentUrlAction } from '@/lib/data/attachment-actions';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';

export interface LightboxProps {
  items: Attachment[];
  /** Index into `items`, or null when nothing is open. */
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
}

export function Lightbox({ items, index, onIndex, onClose }: LightboxProps) {
  const open = index !== null && index >= 0 && index < items.length;
  const item = open ? items[index] : null;

  /*
   * Both pieces of state carry the id they belong to, so walking to the next
   * picture shows a skeleton rather than the previous one's link: the answer
   * for the file being shown is simply not there yet. Clearing them as the
   * effect runs would be a synchronous setState in an effect body, and a
   * cascading render for something the render can work out for itself.
   */
  const [resolved, setResolved] = useState<{ id: string; url: string } | null>(null);
  const [failed, setFailed] = useState<{ id: string; error: string } | null>(null);
  const [downloading, setDownloading] = useState(false);

  const url = item && resolved?.id === item.id ? resolved.url : null;
  const error = item && failed?.id === item.id ? failed.error : null;

  useEffect(() => {
    if (!item) return;
    let current = true;
    void attachmentUrlAction(item.id).then((result) => {
      if (!current) return;
      if (result.ok) setResolved({ id: item.id, url: result.url });
      else setFailed({ id: item.id, error: result.error });
    });
    return () => {
      current = false;
    };
  }, [item]);

  const step = useCallback(
    (delta: number) => {
      if (index === null || items.length === 0) return;
      // Wraps, so the last picture's "next" is the first one rather than a
      // dead button.
      onIndex((index + delta + items.length) % items.length);
    },
    [index, items.length, onIndex],
  );

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, step]);

  /**
   * The download link is a second signed URL carrying a content-disposition,
   * fetched on the press: minting it up front would have it expire while
   * somebody was still looking at the picture.
   */
  async function onDownload() {
    if (!item || downloading) return;
    setDownloading(true);
    const result = await attachmentUrlAction(item.id, true);
    setDownloading(false);
    if (!result.ok) {
      setFailed({ id: item.id, error: result.error });
      return;
    }
    window.location.href = result.url;
  }

  const many = items.length > 1;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={item?.filename ?? 'Attachment'}
      description={item ? `${formatBytes(item.bytes)}` : undefined}
      className="lightbox"
      footer={
        <div className="lightbox-foot">
          {many ? (
            <div className="lightbox-steps">
              <Button
                variant="secondary"
                size="sm"
                icon={ChevronLeft}
                onClick={() => step(-1)}
                aria-label="Previous attachment"
              />
              <span className="lightbox-count" aria-live="polite">
                {(index ?? 0) + 1} of {items.length}
              </span>
              <Button
                variant="secondary"
                size="sm"
                icon={ChevronRight}
                onClick={() => step(1)}
                aria-label="Next attachment"
              />
            </div>
          ) : (
            <span />
          )}
          <div className="lightbox-actions">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={Download}
              onClick={onDownload}
              loading={downloading}
            >
              Download
            </Button>
          </div>
        </div>
      }
    >
      <div className="lightbox-stage">
        {error ? (
          <p className="lightbox-message">{error}</p>
        ) : !item || !url ? (
          <Skeleton height={260} />
        ) : isImageMime(item.mime) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="lightbox-image" src={url} alt={item.filename} />
        ) : (
          <div className="lightbox-file">
            <Icon icon={FileText} size={40} />
            <p className="lightbox-message">
              This is a PDF. Download it to read it, or open it in a new tab.
            </p>
            <a className="lightbox-link" href={url} target="_blank" rel="noreferrer">
              Open in a new tab
            </a>
          </div>
        )}
      </div>
    </Dialog>
  );
}
