'use client';

import type { ReactNode } from 'react';
import { Overlay } from './Overlay';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Usually a cancel button and one primary action. */
  footer?: ReactNode;
  className?: string;
}

/**
 * A centred modal for a decision that needs an answer before anything else:
 * confirmations, short forms. Same contract as `Sheet`, different placement.
 */
export function Dialog(props: DialogProps) {
  return <Overlay kind="dialog" {...props} />;
}
