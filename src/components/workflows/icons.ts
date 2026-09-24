import { ArchiveRestore, Boxes, HandHelping, ScanEye, ScanSearch, Tags, type LucideIcon } from 'lucide-react';
import type { WorkflowKind } from '@/lib/domain/workflows';

/** One glyph a job, the same on the hub, in the palette and on a recent run. */
export const WORKFLOW_ICONS: Record<WorkflowKind, LucideIcon> = {
  move: Boxes,
  handout: HandHelping,
  collect: ArchiveRestore,
  audit: ScanSearch,
  status: Tags,
};

/** "Check a device": read-only, so not one of the jobs above, but on the same hub. */
export const CHECK_ICON: LucideIcon = ScanEye;
