import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon, ChevronRightIcon, FileTextIcon } from 'lucide-react';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChangesView } from '@/components/changes-view';
import { FileViewer, type FileTarget } from '@/components/file-viewer';
import { EnforcementBadge, STATUS_LABEL, StageDot } from '@/components/stage-dots';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import { findStage } from '@/lib/stages';
import type { Block, Change, StageModel, Task, TaskChecks } from '@/lib/types';

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
                onClick={() => setTarget({ path: `${dir}/${f.name}` })}
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
  const cfg = (id: string): StageModel | undefined => findStage(wf?.stages, id);

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

/** The latest check run under a `checks` stage: one row per command, its output tail on click. */
function ChecksRows({ checks }: { checks: TaskChecks | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!checks) return <p className="mt-2 text-xs text-muted-foreground">No check run yet.</p>;
  if (checks.results.length === 0)
    return <p className="mt-2 text-xs text-muted-foreground">No commands are configured.</p>;
  return (
    <div className="mt-2 flex flex-col gap-1 text-xs">
      {checks.stale && (
        <div>
          <Badge variant="outline" className="text-enf-warn">
            Out of date
          </Badge>
          <span className="ml-2 text-muted-foreground">The code changed since this run.</span>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {checks.results.map((r) => {
          const ok = r.exit === 0;
          const expanded = open === r.name;
          const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
          return (
            <li key={r.name}>
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : r.name)}
              >
                <Chevron className="size-3 shrink-0 text-muted-foreground" />
                <span className="font-mono">{r.name}</span>
                <span
                  className={ok ? 'text-stage-done' : 'text-destructive'}
                  role="img"
                  aria-label={ok ? 'Passed' : 'Failed'}
                >
                  {ok ? '✓' : '✗'}
                </span>
                <span className="text-muted-foreground">
                  {r.exit === null
                    ? 'did not run'
                    : ok
                      ? `${(r.duration_ms / 1000).toFixed(1)}s`
                      : `exit ${r.exit}`}
                </span>
                {r.accepted && <Badge variant="secondary">accepted</Badge>}
              </button>
              {expanded && (
                <pre className="mt-1 max-h-60 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                  {r.command ? `$ ${r.command}\n` : ''}
                  {r.tail || '(no output)'}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
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
      {curIdx < 0 && <p className="rounded-md bg-muted px-3 py-2 text-sm">All stages are done.</p>}
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
                        enforcement={findStage(wf?.stages, s.id)?.enforcement ?? 'guide'}
                      />
                    </div>
                    <StageFacts task={task} stage={s} />
                    {findStage(wf?.stages, s.id)?.checks === true && (
                      <ChecksRows checks={task.checks} />
                    )}
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
                    {findStage(wf?.stages, s.id)?.checks === true && s.status !== 'pending' && (
                      <ChecksRows checks={task.checks} />
                    )}
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

const normDir = (p: string) => p.replace(/\/+$/, '');

const finished = (t: Task) => t.stages.filter((s) => s.status === 'done' || s.status === 'skipped');

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

/** One task in the chat's list: a one-line summary, and when expanded its stage timeline and files. */
function ChatTaskRow({
  task,
  current,
  expanded,
  onToggle,
}: {
  task: Task;
  current: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const done = finished(task).length;
  const complete = done === task.stages.length;
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <li className="rounded-lg border bg-card">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <Chevron className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          <span className={cn(expanded && 'font-semibold')}>{task.title || task.slug}</span>
          <span className="text-muted-foreground">
            {' · '}
            {task.workflow}
            {' · '}
            {done}/{task.stages.length} stages
          </span>
        </span>
        {complete && (
          <span className="shrink-0 text-stage-done" role="img" aria-label="Complete">
            ✓
          </span>
        )}
        {current && !expanded && (
          <Badge variant="secondary" className="shrink-0">
            Current
          </Badge>
        )}
      </button>
      {expanded && (
        <div className="flex flex-col gap-4 border-t p-3">
          <TaskHeading task={task} />
          <StageTimeline task={task} />
          <div>
            <h4 className="mb-1 text-sm font-medium">Files</h4>
            <ArtifactList task={task} />
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The chat's right panel: every task the chat has worked on, oldest first. The current task is expanded
 * (stage timeline and files); earlier ones are one line each, finished ones included. Below the tasks, a
 * collapsed "Changes" section shows the whole working tree.
 */
export function ChatTasksPanel({
  tasks,
  currentDir,
  changes,
}: {
  tasks: Task[];
  /** The chat's current task folder (`task_dir`). */
  currentDir: string | null | undefined;
  changes: Change[];
}) {
  const current = currentDir ? normDir(currentDir) : null;
  // A task the user opened by hand holds only while the chat's current task stays the same.
  const [picked, setPicked] = useState<{ dir: string | null; forCurrent: string | null } | null>(
    null,
  );
  const currentTask = tasks.find((t) => normDir(t.dir) === current) ?? tasks[tasks.length - 1];
  const defaultDir = currentTask ? normDir(currentTask.dir) : null;
  const expandedDir = picked && picked.forCurrent === defaultDir ? picked.dir : defaultDir;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex flex-col gap-3 p-4">
        <h2 className="text-sm font-semibold">Tasks in this chat</h2>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No task yet. Claude starts one when you ask for a change.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((t) => {
              const dir = normDir(t.dir);
              return (
                <ChatTaskRow
                  key={t.dir}
                  task={t}
                  current={dir === defaultDir}
                  expanded={dir === expandedDir}
                  onToggle={() =>
                    setPicked({ dir: dir === expandedDir ? null : dir, forCurrent: defaultDir })
                  }
                />
              );
            })}
          </ul>
        )}
      </div>
      <Collapsible className="border-t p-4">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 text-sm font-semibold">
          <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90" />
          Changes · {changes.length} {changes.length === 1 ? 'file' : 'files'}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <ChangesView changes={changes} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
