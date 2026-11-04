import { useState } from 'react';
import { History } from 'lucide-react';
import { STAGE_TYPE_LABELS, StageTemplateDef, TemplateVersionRowDTO } from '@shipline/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useTemplateVersion } from '@/services/admin/admin.hooks';
import { formatDateTime } from '@/lib/formatters';

interface VersionHistoryProps {
  templateId: string;
  versions: TemplateVersionRowDTO[];
  latestVersion: number;
  /** Copies a past version's stages into the editor (saving then creates a new version). */
  onLoadStages: (stages: StageTemplateDef[]) => void;
}

/** Read-only view of every saved version. Versions are immutable: "load into editor" makes a new draft from one. */
export default function VersionHistory({ templateId, versions, latestVersion, onLoadStages }: VersionHistoryProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const detail = useTemplateVersion(templateId, selected);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSelected(null);
      }}
    >
      <SheetTrigger asChild>
        <Button variant="outline">
          <History /> Version history
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto p-0 data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Version history</SheetTitle>
          <SheetDescription>Each save is a new immutable version. Chats stay on the version they started on.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <ul className="divide-y rounded-lg border text-sm">
            {versions.map((v) => (
              <li key={v.version}>
                <button
                  type="button"
                  onClick={() => setSelected(v.version === selected ? null : v.version)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left hover:bg-accent"
                >
                  <span>
                    <span className="font-medium">v{v.version}</span>
                    {v.version === latestVersion && (
                      <Badge className="ml-2" variant="secondary">
                        latest
                      </Badge>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {formatDateTime(v.createdAt)} · {v.createdBy?.name ?? 'seed'} · {v.stageCount} stages
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">{selected === v.version ? 'Hide' : 'View'}</span>
                </button>
              </li>
            ))}
          </ul>
          {selected !== null &&
            (detail.isPending ? (
              <Skeleton className="h-32" />
            ) : detail.data ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    v{detail.data.version}: {detail.data.name}
                  </p>
                  {detail.data.version !== latestVersion && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        onLoadStages(detail.data.stages);
                        setOpen(false);
                      }}
                    >
                      Load stages into editor
                    </Button>
                  )}
                </div>
                <ol className="space-y-2">
                  {detail.data.stages.map((s, i) => (
                    <li key={s.key} className="rounded-lg border p-2 text-sm">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">{i + 1}</span>
                        <span className="font-medium">{s.name}</span>
                        <Badge variant="outline">{STAGE_TYPE_LABELS[s.type]}</Badge>
                        {s.optional && <Badge variant="outline">optional</Badge>}
                        {s.requiredForGate && <Badge variant="secondary">gate</Badge>}
                        {s.rules.length > 0 && <Badge variant="secondary">{s.rules.length} rules</Badge>}
                      </div>
                      {s.instructions && <p className="mt-1 line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">{s.instructions}</p>}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null)}
        </div>
      </SheetContent>
    </Sheet>
  );
}
