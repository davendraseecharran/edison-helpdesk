'use client';

/**
 * The camera, kept open for a whole run.
 *
 * The palette's scan reads one code and closes; a cart is thirty, so this one
 * stays open and hands every new code to the run. The same label held under
 * the lens is read once, however long it is held (`CameraViewfinder`);
 * pointing at the next laptop reads the next.
 *
 * On a desktop it sits in the page, above the list. On a phone it is a
 * full-height sheet — the picture is what the phone is for while it is open —
 * with the last few answers under it (`feed`), so a NetRider walking a room
 * sees each machine land without closing the camera to look.
 *
 * The scan loop answers each read with its own sound and buzz (`feedback`),
 * so the frame's own buzz is off here unless asked for: one read, one buzz.
 */

import type { ReactNode } from 'react';
import { CameraViewfinder } from '@/components/scan/CameraViewfinder';
import { usePhone } from '@/components/ui/media';
import { Sheet } from '@/components/ui/Sheet';

export interface WorkflowCameraProps {
  onCode: (code: string) => void;
  onClose: () => void;
  /** The sheet's title on a phone: what the camera is scanning for. */
  title?: string;
  /** Under the picture on a phone: the latest answers. */
  feed?: ReactNode;
  /** The frame's own buzz, for a page that does not answer a read with one. */
  haptic?: boolean;
  note?: string;
}

export function WorkflowCamera({
  onCode,
  onClose,
  title = 'Scan with the camera',
  feed,
  haptic = false,
  note = 'Hold each label in the frame until it ticks.',
}: WorkflowCameraProps) {
  const phone = usePhone();

  if (phone) {
    return (
      <Sheet side="bottom" open onClose={onClose} title={title} className="camera-sheet">
        <CameraViewfinder onCode={(code) => onCode(code)} mode="continuous" haptic={haptic} fill />
        {feed ? <div className="camera-sheet-feed">{feed}</div> : <p className="cam-note">{note}</p>}
      </Sheet>
    );
  }

  return (
    <CameraViewfinder
      onCode={(code) => onCode(code)}
      mode="continuous"
      haptic={haptic}
      onClose={onClose}
      note={note}
      className="wf-camera"
    />
  );
}
