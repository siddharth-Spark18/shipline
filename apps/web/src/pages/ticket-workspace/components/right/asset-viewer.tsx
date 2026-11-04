import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileQuestion } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import EmptyState from '@/components/shared/empty-state';
import { errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/formatters';
import { useAsset } from '@/services/local/local.hooks';
import { AssetRef } from '@/pages/ticket-workspace/types';

interface AssetViewerProps {
  ticketId: string;
  asset: AssetRef | null;
  localReady: boolean;
}

/** What the viewer needs once the content is known, whether it came from the worktree or the chat. */
interface Resolved {
  name: string;
  kind: 'markdown' | 'html' | 'image' | 'text' | 'other';
  content: string | null;
  base64: string | null;
  mime: string;
  size: number;
  absolutePath: string | null;
}

export default function AssetViewer({ ticketId, asset, localReady }: AssetViewerProps) {
  const worktree = asset?.source === 'worktree' ? asset : null;
  const query = useAsset(ticketId, worktree?.path ?? '', !!worktree && localReady);

  if (!asset) return <EmptyState message="Click a file chip in the chat to open it here." />;

  let resolved: Resolved | null = null;
  if (asset.source === 'inline') {
    resolved = {
      name: asset.name,
      kind: asset.type === 'HTML' ? 'html' : 'markdown',
      content: asset.content,
      base64: null,
      mime: asset.type === 'HTML' ? 'text/html' : 'text/markdown',
      size: new Blob([asset.content]).size,
      absolutePath: null,
    };
  } else if (query.data) {
    resolved = { ...query.data, absolutePath: query.data.absolutePath };
  }

  if (!resolved) {
    if (!localReady) return <EmptyState message="Shipline Local is not connected, so this file cannot be read." />;
    if (query.error) {
      return (
        <Alert variant="destructive" className="m-3">
          <AlertDescription>{errorMessage(query.error)}</AlertDescription>
        </Alert>
      );
    }
    return <Skeleton className="m-3 h-40" />;
  }

  return <ResolvedAsset key={asset.source === 'worktree' ? asset.path : asset.name} asset={resolved} />;
}

function ResolvedAsset({ asset }: { asset: Resolved }) {
  const [raw, setRaw] = useState(false);
  const canToggle = asset.kind === 'markdown' || asset.kind === 'html';
  const showRawText = asset.kind === 'text' || (canToggle && raw);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={asset.absolutePath ?? asset.name}>
            {asset.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {asset.kind} · {formatBytes(asset.size)}
          </p>
        </div>
        {canToggle && (
          <ToggleGroup type="single" variant="outline" size="sm" value={raw ? 'raw' : 'rendered'} onValueChange={(v) => v && setRaw(v === 'raw')}>
            <ToggleGroupItem value="rendered">{asset.kind === 'html' ? 'Preview' : 'Rendered'}</ToggleGroupItem>
            <ToggleGroupItem value="raw">Raw</ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {asset.kind === 'markdown' && !raw && (
          <div className="prose prose-sm max-w-none p-4 dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{asset.content ?? ''}</ReactMarkdown>
          </div>
        )}
        {asset.kind === 'html' && !raw && (
          // Untrusted HTML mockup: scripts may run (wireframes are interactive) but with no
          // same-origin access, no forms, no top navigation.
          <iframe title={asset.name} sandbox="allow-scripts" srcDoc={asset.content ?? ''} className="h-full min-h-96 w-full bg-white" />
        )}
        {showRawText && (
          <pre className="p-4 font-mono text-xs break-words whitespace-pre-wrap">{asset.content}</pre>
        )}
        {asset.kind === 'image' && asset.base64 && (
          <div className="flex justify-center p-4">
            <img src={`data:${asset.mime};base64,${asset.base64}`} alt={asset.name} className="max-w-full" />
          </div>
        )}
        {asset.kind === 'other' && (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <FileQuestion className="size-6" />
            <p>This file type cannot be previewed. Open it in your editor:</p>
            {asset.absolutePath && <code className="rounded bg-muted px-2 py-1 text-xs break-all">{asset.absolutePath}</code>}
          </div>
        )}
      </div>
    </div>
  );
}
