import { ChevronRightIcon, PlusIcon, SparklesIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { isWorkflowDirty, type Drafts } from '@/pages/setup/draft';
import { workflowHash } from '@/lib/routes';
import type { SetupData } from '@/lib/types';

/** The workflow list: one row per workflow with its name, stage count and state, and the ways to add one. */
export function WorkflowsPage({
  repoId,
  data,
  drafts,
  readOnly,
  designerSupported,
  startingChat,
  upgradeHint,
  onNew,
  onAddShipped,
  onDescribe,
}: {
  repoId: string;
  data: SetupData;
  drafts: Drafts;
  readOnly: boolean;
  designerSupported: boolean;
  startingChat: boolean;
  upgradeHint: string;
  onNew: () => void;
  onAddShipped: () => void;
  onDescribe: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-extrabold tracking-tight">Workflows</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="max-md:h-11" disabled={readOnly} onClick={onNew}>
            <PlusIcon /> New workflow
          </Button>
          <Button
            variant="outline"
            className="max-md:h-11"
            disabled={readOnly || data.addableWorkflows.length === 0}
            onClick={onAddShipped}
          >
            <PlusIcon /> Add shipped workflow
          </Button>
          {designerSupported && (
            <Button
              className="max-md:h-11"
              disabled={readOnly || startingChat}
              onClick={onDescribe}
            >
              <SparklesIcon /> Describe a workflow
            </Button>
          )}
        </div>
      </div>
      {!designerSupported && <p className="text-xs text-muted-foreground">{upgradeHint}</p>}

      {data.workflows.length === 0 ? (
        <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
          This repo has no workflows yet.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {data.workflows.map((w) => {
            const id = w.id!;
            const broken = w.parseError !== undefined;
            const model = drafts.workflows[id]?.model ?? w.model;
            const stages = model?.stages?.length ?? 0;
            return (
              <li key={id}>
                <a
                  href={workflowHash(repoId, id)}
                  className="flex min-h-14 items-center gap-3 px-3 py-3 outline-none hover:bg-accent/50 focus-visible:bg-accent"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <b className="text-sm">{model?.name || id}</b>
                      <span className="font-mono text-xs text-muted-foreground">{id}</span>
                      {isWorkflowDirty(data, drafts, id) && (
                        <Badge variant="outline">unsaved</Badge>
                      )}
                      {broken && <Badge variant="destructive">invalid</Badge>}
                    </span>
                    {model?.description && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {model.description}
                      </span>
                    )}
                  </span>
                  {!broken && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {stages} {stages === 1 ? 'stage' : 'stages'}
                    </span>
                  )}
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
