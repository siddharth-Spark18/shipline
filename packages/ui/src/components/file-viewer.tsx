import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Markdown } from '@/components/markdown';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';

export interface FileTarget {
  path: string;
}

function FileBody({ target }: { target: FileTarget }) {
  const { data, error, isPending } = useQuery({
    queryKey: queryKeys.file(target.path, 'content'),
    queryFn: () => api.file(target.path, 'content'),
  });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!('content' in data))
    return <p className="text-sm text-muted-foreground">Binary file, not shown.</p>;
  if (/\.(md|markdown)$/i.test(data.path)) return <Markdown>{data.content}</Markdown>;
  return <pre className="font-mono text-xs whitespace-pre-wrap">{data.content}</pre>;
}

/** Read-only viewer for an artifact (markdown rendered, or plain text), in a dialog. Diffs live in ChangesView. */
export function FileViewer({
  target,
  onClose,
}: {
  target: FileTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm break-all">{target?.path}</DialogTitle>
          <DialogDescription>Read-only view</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">
          <div className="pr-3">{target && <FileBody target={target} />}</div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
