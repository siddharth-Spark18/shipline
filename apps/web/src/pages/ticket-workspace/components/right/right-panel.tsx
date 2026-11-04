import { FileDiff, FileText, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AssetRef } from '@/pages/ticket-workspace/types';
import AssetViewer from './asset-viewer';
import ChangesTab from './changes-tab';

export type RightPanelTab = 'changes' | 'asset';

interface RightPanelProps {
  ticketId: string;
  tab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  /** A changed file to expand (set by the chat's summary card). */
  focusPath?: string;
  asset: AssetRef | null;
  localReady: boolean;
  hasWorktree: boolean;
  onClose: () => void;
}

/** The read-only panel: diffs (with the branch/uncommitted toggle) and the file viewer. Hidden until opened. */
export default function RightPanel({ ticketId, tab, onTabChange, focusPath, asset, localReady, hasWorktree, onClose }: RightPanelProps) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as RightPanelTab)} className="h-full min-h-0 gap-0 border-l">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <TabsList>
          <TabsTrigger value="changes">
            <FileDiff /> Changes
          </TabsTrigger>
          <TabsTrigger value="asset">
            <FileText /> {asset ? <span className="max-w-32 truncate">{asset.name}</span> : 'File'}
          </TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-2">
          <Badge variant="outline">Read-only</Badge>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close panel" title="Close">
            <X />
          </Button>
        </div>
      </div>
      <TabsContent value="changes" className="min-h-0">
        <ChangesTab ticketId={ticketId} enabled={localReady && hasWorktree} focusPath={focusPath} />
      </TabsContent>
      <TabsContent value="asset" className="min-h-0">
        <AssetViewer ticketId={ticketId} asset={asset} localReady={localReady} />
      </TabsContent>
    </Tabs>
  );
}
