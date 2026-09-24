import {
  BookUser,
  Calendar,
  CircleDot,
  Hash,
  Signature,
  SquareCheck,
  SquareChevronDown,
  TextAlignStart,
  TextCursorInput,
  ToggleLeft,
} from 'lucide-react';
import type { LucideIcon } from '@/components/ui/Icon';
import type { FieldType } from '@/lib/domain/forms';

/** One mark per kind of question, shared by the builder and the add menu. */
export const QUESTION_ICONS: Record<FieldType, LucideIcon> = {
  short_text: TextCursorInput,
  long_text: TextAlignStart,
  single_choice: CircleDot,
  multi_choice: SquareCheck,
  dropdown: SquareChevronDown,
  number: Hash,
  date: Calendar,
  yes_no: ToggleLeft,
  signature: Signature,
  directory: BookUser,
};
