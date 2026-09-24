import { ArchiveRestore, Boxes, HandHelping, ScanSearch, Tags, type LucideIcon } from 'lucide-react';
import type { WorkflowKind } from '@/lib/domain/workflows';

/** One glyph a job, the same on the hub, in the palette and on a recent run. */
export const WORKFLOW_ICONS: Record<WorkflowKind, LucideIcon> = {
  move: Boxes,
  handout: HandHelping,
  collect: ArchiveRestore,
  audit: ScanSearch,
  status: Tags,
};
