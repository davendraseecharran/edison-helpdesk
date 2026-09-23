'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ImportSheetDialog } from '@/components/ticket/ImportSheetDialog';

/**
 * The Resolved page's second header action: the desk's sheet, in.
 *
 * `openOnLoad` is `?import=1`, which is where the New ticket menu and the
 * palette send somebody who asked for the import from another page. Closing
 * takes the parameter off the address, so a refresh afterwards is the list
 * and not the dialog again.
 */
export function ImportSheetButton({ openOnLoad = false }: { openOnLoad?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(openOnLoad);

  function close() {
    setOpen(false);
    if (openOnLoad) router.replace('/resolved', { scroll: false });
  }

  return (
    <>
      <Button size="sm" icon={FileUp} onClick={() => setOpen(true)}>
        Import
      </Button>
      <ImportSheetDialog open={open} onClose={close} />
    </>
  );
}
