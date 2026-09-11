/**
 * Attribution helpers over the minimal account directory.
 *
 * The directory carries labels only (id, name, role, status). Rendering a name
 * for a note author or a work-log contributor therefore never needs, and never
 * has access to, another account's email or credential metadata.
 */

import type { Account } from '@/lib/domain/types';

export function nameOf(directory: Account[], id: string | null | undefined): string {
  if (!id) return 'Unknown user';
  return directory.find((account) => account.id === id)?.displayName ?? 'Unknown user';
}

export function accountById(directory: Account[], id: string | null | undefined): Account | null {
  if (!id) return null;
  return directory.find((account) => account.id === id) ?? null;
}
