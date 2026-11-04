import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileTextIcon } from 'lucide-react';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileViewer, type FileTarget } from '@/components/file-viewer';
import { EnforcementBadge, STATUS_LABEL, StageDot, StageTrail } from '@/components/stage-dots';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { Block, Change, StageModel, Task } from '@/lib/types';

function changeCode(c: Change): string {
  const code = `${c.index}${c.worktree}`.replace(/ /g, '');
  return code === '' ? '?' : code;
}

/** "Working tree changes" from `git status`. Clicking a file opens its diff. `bare` drops the card. */
export function ChangesList({ changes, bare }: { changes: Change[]; bare?: boolean }) {
  const [target, setTarget] = useState<FileTarget | null>(null);
  const list =
    changes.length === 0 ? (
      <p className="text-sm text-muted-foreground">No changes.</p>
    ) : (
      <ul className="flex flex-col gap-1">
        {changes.map((c) => (
          <li key={c.path} className="flex items-center gap-2">
            <Badge variant="outline" className="w-8 justify-center font-mono">
              {changeCode(c)}
            </Badge>
            <Button
              variant="link"
              size="xs"
              className="h-auto min-w-0 px-0 font-mono"
              onClick={() => setTarget({ path: c.path, mode: 'diff' })}
            >
              <span className="truncate">{c.path}</span>
            </Button>
            {c.oldPath && (
              <span className="truncate text-xs text-muted-foreground">from {c.oldPath}</span>
            )}
          </li>
        ))}
      </ul>
    );
  if (bare) {
    return (
      <>
        {list}
        <FileViewer target={target} onClose={() => setTarget(null)} />
      </>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Working tree changes</CardTitle>
      </CardHeader>
      <CardContent>{list}</CardContent>
      <FileViewer target={target} onClose={() => setTarget(null)} />
    </Card>
  );
}

/** The files in the task folder; clicking one opens it read-only. */
export function ArtifactList({ task }: { task: Task }) {
  const [target, setTarget] = useState<FileTarget | null>(null);
  const dir = task.dir.replace(/\/+$/, '');
  return (
    <>
      {task.files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files in the task folder yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {task.files.map((f) => (
            <li key={f.name}>
              <Button
                variant="link"
                size="xs"
                className="h-auto px-0 font-mono"
                onClick={() => setTarget({ path: `${dir}/${f.name}`, mode: 'content' })}
              >
                <FileTextIcon />
                {f.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <FileViewer target={target} onClose={() => setTarget(null)} />
    </>
  );
}

function describeBlock(b: Block): string {
  if (typeof b.bash === 'string' && b.bash) return `commands matching ${b.bash}`;
  if (typeof b.tools === 'string' && b.tools) {
    const allow = Array.isArray(b.allow_paths) ? (b.allow_paths as string[]) : [];
    const paths = allow.length ? ` outside ${allow.join(', ')}` : '';
    return `${b.tools.replace(/\|/g, ', ')}${paths}`;
  }
  return 'some actions';
}

/** What the current stage needs, as plain sentences. Read-only; nothing here changes the task. */
function StageFacts({ task, stage }: { task: Task; stage: Task['stages'][number] }) {
  const { data: setup } = useQuery({ queryKey: queryKeys.setup, queryFn: api.setup });
  const wf = setup?.workflows.find((w) => w.id === task.workflow)?.model;
  const cfg = (id: string): StageModel | undefined => wf?.stages?.find((s) => s.id === id);

  const curIdx = task.stages.findIndex((s) => s.id === stage.id);
  const next = task.stages.slice(curIdx + 1).find((s) => s.status === 'pending');
  const c = cfg(stage.id);
  const artifact = stage.artifact ?? c?.artifact ?? null;
  const hasArtifact = artifact ? task.files.some((f) => f.name === artifact) : false;
  const enforcement = c?.enforcement ?? 'guide';
  const blocks = c?.blocks ?? [];
  const nextCfg = next ? cfg(next.id) : undefined;

  return (
    <div className="mt-2 flex flex-col gap-2 text-xs text-muted-foreground">
      <ul className="flex list-disc flex-col gap-1 pl-4">
        <li>
          {artifact ? (
            <>
              Finishes when <span className="font-mono text-foreground">{artifact}</span> exists
              {hasArtifact ? ' (written)' : ' (not written yet)'}.
            </>
          ) : (
            'No file is required to finish this stage.'
          )}
        </li>
        {c?.confirm_to_advance && <li>Claude asks you before moving on.</li>}
        {enforcement !== 'guide' && blocks.length > 0 && (
          <li>
            Until it is done, {blocks.map(describeBlock).join('; ')}{' '}
            {enforcement === 'block' ? 'are blocked' : 'trigger a reminder'}.
          </li>
        )}
      </ul>
      <p>
        <span className="font-medium text-foreground">Next: </span>
        {next ? (
          <>
            {next.name}
            {nextCfg?.condition === 'ui_only' && <span> (only for UI work)</span>}
          </>
        ) : (
          'nothing; this is the last stage.'
        )}
      </p>
    </div>
  );
}

/**
 * Vertical stage timeline, read-only. The current stage (the first one not done or skipped) is
 * expanded with its Now/Next facts; every other stage is one line.
 */
export function StageTimeline({ task }: { task: Task }) {
  const { data: setup } = useQuery({ queryKey: queryKeys.setup, queryFn: api.setup });
  const wf = setup?.workflows.find((w) => w.id === task.workflow)?.model;
  const curIdx = task.stages.findIndex((s) => s.status !== 'done' && s.status !== 'skipped');

  return (
    <div className="flex flex-col gap-3">
      {curIdx < 0 && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">All stages are done.</p>
      )}
      <ol className="flex flex-col">
        {task.stages.map((s, i) => {
          const current = i === curIdx;
          const last = i === task.stages.length - 1;
          return (
            <li
              key={s.id}
              className={cn(
                'relative flex gap-3 py-2 pl-0 text-sm',
                !last &&
                  !current &&
                  'before:absolute before:top-6 before:bottom-[-0.5rem] before:left-[4.5px] before:w-px before:bg-border',
                current && '-mx-1 rounded-lg border bg-card p-3 shadow-xs',
              )}
              aria-current={current ? 'step' : undefined}
            >
              <StageDot status={s.status} className="mt-1.5" />
              <div className="min-w-0 flex-1">
                {current ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{s.name}</span>
                      <EnforcementBadge
                        enforcement={wf?.stages?.find((x) => x.id === s.id)?.enforcement ?? 'guide'}
                      />
                    </div>
                    <StageFacts task={task} stage={s} />
                  </>
                ) : (
                  <>
                    <span
                      className={cn(
                        s.status === 'skipped' && 'text-stage-skipped line-through',
                        s.status === 'pending' && 'text-muted-foreground',
                      )}
                    >
                      {s.name}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {s.status === 'skipped' && s.reason
                        ? `Skipped: ${s.reason}`
                        : STATUS_LABEL[s.status]}
                    </span>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TaskHeading({ task }: { task: Task }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{task.title || task.slug}</h3>
        <Badge variant="secondary">{task.workflow}</Badge>
      </div>
      <p className="font-mono text-xs text-muted-foreground">{task.branch}</p>
    </div>
  );
}

/** The chat's "Task canvas": Progress, Artifacts and Changes tabs. `task` is absent before a task starts. */
export function TaskCanvas({ task, changes }: { task?: Task; changes: Change[] }) {
  return (
    <Tabs defaultValue="progress" className="h-full min-h-0 gap-0">
      <TabsList variant="line" className="h-10 w-full shrink-0 justify-start border-b px-2">
        <TabsTrigger value="progress" className="flex-none px-3">
          Progress
        </TabsTrigger>
        <TabsTrigger value="artifacts" className="flex-none px-3">
          Artifacts
          {task && task.files.length > 0 && <Badge variant="secondary">{task.files.length}</Badge>}
        </TabsTrigger>
        <TabsTrigger value="changes" className="flex-none px-3">
          Changes
          {changes.length > 0 && <Badge variant="secondary">{changes.length}</Badge>}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="progress" className="min-h-0 overflow-y-auto p-4">
        {task ? (
          <div className="flex flex-col gap-4">
            <TaskHeading task={task} />
            <StageTimeline task={task} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No task yet. Its stages appear here when Claude starts one in this chat.
          </p>
        )}
      </TabsContent>
      <TabsContent value="artifacts" className="min-h-0 overflow-y-auto p-4">
        {task ? (
          <ArtifactList task={task} />
        ) : (
          <p className="text-sm text-muted-foreground">No task yet, so no files.</p>
        )}
      </TabsContent>
      <TabsContent value="changes" className="min-h-0 overflow-y-auto p-4">
        <ChangesList changes={changes} bare />
      </TabsContent>
    </Tabs>
  );
}

/** One task as a card (Tasks page): heading, the same stage timeline, then artifacts. */
export function TaskPanel({ task, changes }: { task: Task; changes?: Change[] }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="flex flex-wrap items-center gap-2">
              {task.title || task.slug}
              <Badge variant="secondary">{task.workflow}</Badge>
            </span>
            <StageTrail stages={task.stages} />
          </CardTitle>
          <p className="font-mono text-xs text-muted-foreground">{task.branch}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <StageTimeline task={task} />
          <div>
            <h3 className="mb-1 text-sm font-medium">Artifacts</h3>
            <ArtifactList task={task} />
          </div>
        </CardContent>
      </Card>
      {changes && <ChangesList changes={changes} />}
    </div>
  );
}
