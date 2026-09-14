'use client';

/**
 * The Attachments panel, on a ticket and on a device.
 *
 * One component for both because the rule about who may add a file is the
 * database's, not the screen's: `listAttachmentsAction` asks `app_can_attach`
 * in the caller's own session and the panel shows the upload control if and
 * only if the answer was yes. A ticket follows the contributor rule and closes
 * to new files when it is resolved; a device is shared inventory any active
 * account may photograph. Neither of those decisions is made here.
 *
 * The list is fetched rather than server-rendered because the thumbnails need
 * signed URLs the browser has to ask for anyway, and because the device page
 * hands its panel to a client component that has no server props to extend.
 * Both hosts therefore get the same skeleton and the same empty state.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Attachment, AttachmentTarget } from '@/lib/attachments';
import { listAttachmentsAction } from '@/lib/data/attachment-actions';
import { LoadingRegion, Skeleton } from '@/components/ui/Skeleton';
import { AttachmentGrid } from './AttachmentGrid';
import { AttachmentUploader } from './AttachmentUploader';
import '@/styles/attachments.css';

export interface AttachmentsPanelProps extends AttachmentTarget {
  /** Distinguishes the heading when two panels could share a page. */
  headingId?: string;
}

export function AttachmentsPanel({ ticketId, deviceId, headingId }: AttachmentsPanelProps) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [mayAttach, setMayAttach] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = ticketId ?? deviceId ?? '';
  const id = headingId ?? `attachments-heading-${key}`;

  useEffect(() => {
    let current = true;
    void listAttachmentsAction({ ticketId, deviceId }).then((result) => {
      if (!current) return;
      if (result.ok) {
        setItems(result.attachments);
        setMayAttach(result.canAttach);
      } else {
        setItems([]);
        setError(result.error);
      }
    });
    return () => {
      current = false;
    };
  }, [ticketId, deviceId]);

  const onUploaded = useCallback((attachment: Attachment) => {
    // Appended rather than re-fetched: the list is oldest first, and the file
    // that just landed is the newest.
    setItems((current) => [...(current ?? []), attachment]);
  }, []);

  const onDeleted = useCallback((removed: string) => {
    setItems((current) => (current ?? []).filter((item) => item.id !== removed));
  }, []);

  const count = items?.length ?? 0;

  return (
    <section className="panel attachments-panel" aria-labelledby={id}>
      <div className="panel-head">
        <h2 className="panel-title" id={id}>
          Attachments
        </h2>
        {items !== null ? (
          <span className="panel-aside">
            {count} {count === 1 ? 'file' : 'files'}
          </span>
        ) : null}
      </div>
      <div className="panel-body stack">
        {items === null ? (
          <LoadingRegion label="Loading attachments">
            <div className="attachments-grid">
              <Skeleton height={116} />
              <Skeleton height={116} />
              <Skeleton height={116} />
            </div>
          </LoadingRegion>
        ) : (
          <>
            {error ? <p className="callout">{error}</p> : null}
            {count === 0 && !error ? <p className="panel-empty">No attachments yet.</p> : null}
            <AttachmentGrid items={items} onDeleted={onDeleted} />
            {mayAttach ? (
              <AttachmentUploader target={{ ticketId, deviceId }} onUploaded={onUploaded} />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
