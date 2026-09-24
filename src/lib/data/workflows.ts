import 'server-only';

/**
 * Reads for the Workflows hub, in the caller's own session.
 *
 * A failure is an empty list, never an error screen: the hub's tiles work
 * without the shortcuts and without the history, and a list that could not be
 * read is not a reason to stop somebody loading a cart.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import {
  runFromRow,
  shortcutFromRow,
  type WorkflowRun,
  type WorkflowShortcut,
} from '@/lib/domain/workflows';

export const loadWorkflowShortcuts = cache(async (): Promise<WorkflowShortcut[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_workflow_shortcuts');
  if (error || !Array.isArray(data)) return [];
  return data.map(shortcutFromRow).filter((row): row is WorkflowShortcut => row !== null);
});

export async function loadWorkflowRuns(limit = 8): Promise<WorkflowRun[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_workflow_runs', { p_limit: limit });
  if (error || !Array.isArray(data)) return [];
  return data.map(runFromRow).filter((row): row is WorkflowRun => row !== null);
}
