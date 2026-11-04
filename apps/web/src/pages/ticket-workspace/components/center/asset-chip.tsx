import { ExternalLink, FileCode2, FileImage, FileText, File as FileIcon } from 'lucide-react';
import { AssetKind } from '@shipline/shared';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/formatters';
import { useAssetMeta } from '@/services/local/local.hooks';
import { AssetRef } from '@/pages/ticket-workspace/types';

const ICONS: Record<AssetKind, typeof FileText> = {
  markdown: FileText,
  html: FileCode2,
  image: FileImage,
  text: FileText,
  other: FileIcon,
};

interface AssetChipProps {
  ticketId: string;
  asset: AssetRef;
  /** Whether the local service can be asked about the file (size/type). */
  localReady: boolean;
  onOpen: (asset: AssetRef) => void;
}

/** Files Claude wrote or artifacts it submitted appear as chips (name, type, size), never inline. */
export default function AssetChip({ ticketId, asset, localReady, onOpen }: AssetChipProps) {
  const meta = useAssetMeta(ticketId, asset.source === 'worktree' ? asset.path : '', asset.source === 'worktree' && localReady);

  let kind: AssetKind;
  let size: number | null;
  if (asset.source === 'inline') {
    kind = asset.type === 'HTML' ? 'html' : 'markdown';
    size = new Blob([asset.content]).size;
  } else {
    kind = meta.data?.kind ?? guessKind(asset.name);
    size = meta.data?.size ?? null;
  }
  const Icon = ICONS[kind];

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-auto max-w-full justify-start gap-2 py-1 font-normal"
      title={asset.source === 'worktree' ? asset.path : asset.name}
      onClick={() => onOpen(asset)}
    >
      <Icon className="text-muted-foreground" />
      <span className="truncate font-medium">{asset.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {kind}
        {size !== null && ` · ${formatBytes(size)}`}
      </span>
    </Button>
  );
}

export function LinkChip({ url, label }: { url: string; label: string }) {
  return (
    <Button variant="outline" size="sm" className="h-auto max-w-full justify-start gap-2 py-1 font-normal" asChild>
      <a href={url} target="_blank" rel="noreferrer">
        <ExternalLink className="text-muted-foreground" />
        <span className="truncate font-medium">{label}</span>
      </a>
    </Button>
  );
}

function guessKind(name: string): AssetKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  return 'text';
}
