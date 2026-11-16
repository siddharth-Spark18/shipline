import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from 'cn';
import { DOT_CLASS, DOT_LABEL } from '@/components/app-sidebar';
import { STATE_LABEL } from '@/components/banners';
import { WAITING_LABEL } from '@/components/chat-row';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StageTrail } from '@/components/stage-dots';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import { useOverview } from '@/lib/queries';
import type { Overview } from '@/lib/types';

type Card = Overview['projects'][number];

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        {count !== undefined && count > 0 && (
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {count}
          </Badge>
        )}
      </h2>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">{children}</p>
);

const rowClass =
  'flex min-h-12 w-full min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-sm hover:bg-muted active:bg-muted';

/** The current stage of a task: the first one that isn't done or skipped. */
const currentStage = (stages: Overview['tasks'][number]['stages']) =>
  stages.find((s) => s.status === 'in_progress') ?? stages.find((s) => s.status === 'pending');

interface Group {
  key: string;
  label: string;
  items: Card[];
}

/** Worktrees of one repo share a `group` (git's common dir) and sit together under the repo's folder name. */
function groupProjects(projects: Card[]): Group[] {
  const groups = new Map<string, Group>();
  for (const p of projects) {
    const key = p.group ?? `solo:${p.id}`;
    const g = groups.get(key) ?? { key, label: p.groupName ?? p.name, items: [] };
    g.items.push(p);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => a.root.localeCompare(b.root)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function ProjectCard({
  p,
  onNewChat,
  onSetup,
  onRemove,
}: {
  p: Card;
  onNewChat: (id: string) => void;
  onSetup: (id: string) => void;
  onRemove: (p: Card) => void;
}) {
  const state = STATE_LABEL[p.state];
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span
          role="img"
          aria-label={DOT_LABEL[p.dot]}
          title={DOT_LABEL[p.dot]}
          className={cn('size-2.5 shrink-0 rounded-full', DOT_CLASS[p.dot])}
        />
        <span className="min-w-0 truncate font-medium">{p.name}</span>
        {p.branch && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{p.branch}</span>
        )}
        {p.waiting > 0 && (
          <Badge
            className="ml-auto h-4 min-w-4 px-1.5 text-[10px]"
            aria-label={`${p.waiting} waiting for you`}
          >
            {p.waiting}
          </Badge>
        )}
      </div>
      <div className="truncate text-xs text-muted-foreground" title={p.root}>
        {p.root}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        {state && <span className={cn(p.state !== 'install' && 'text-destructive')}>{state}</span>}
        {p.state === 'ok' && !p.setupDone && (
          <span className="text-notice-reminder">Setup not done</span>
        )}
        {p.state === 'ok' && (
          <span>
            {p.unfinished} unfinished {p.unfinished === 1 ? 'task' : 'tasks'}
          </span>
        )}
        {p.upgradeAvailable && <span className="text-notice-reminder">Upgrade available</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {p.state === 'ok' && (
          <Button size="xs" onClick={() => onNewChat(p.id)}>
            New chat here
          </Button>
        )}
        {(p.state === 'ok' || p.state === 'install') && (
          <Button size="xs" variant="outline" onClick={() => onSetup(p.id)}>
            Setup
          </Button>
        )}
        <Button size="xs" variant="outline" onClick={() => onRemove(p)}>
          Remove from list
        </Button>
      </div>
    </div>
  );
}

/**
 * `#/all`: what needs you across projects, one card per project (worktrees grouped under their repo), the unfinished
 * tasks, and a one-line health summary. It reads GET /api/overview, which never opens a repo.
 */
export function OverviewPage({
  onOpenChat,
  onNewChat,
  onSetup,
  onOpenHealth,
}: {
  onOpenChat: (chatId: string) => void;
  onNewChat: (repoId: string) => void;
  onSetup: (repoId: string) => void;
  onOpenHealth: () => void;
}) {
  const queryClient = useQueryClient();
  const overview = useOverview();
  const [removing, setRemoving] = useState<Card | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.removeProject(id),
    onSuccess: () => {
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allChats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't remove this project"),
  });
  const groups = useMemo(() => groupProjects(overview.data?.projects ?? []), [overview.data]);

  if (overview.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading...</p>;
  if (overview.error || !overview.data) {
    return (
      <p className="p-4 text-sm text-destructive">
        {overview.error?.message ?? 'Could not load the overview.'}
      </p>
    );
  }
  const { needsYou, projects, tasks, attention } = overview.data;
  const tasksByProject = new Map<string, typeof tasks>();
  for (const t of tasks) tasksByProject.set(t.repoId, [...(tasksByProject.get(t.repoId) ?? []), t]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
      <Section title="Needs you" count={needsYou.length}>
        {needsYou.length === 0 ? (
          <Empty>Nothing is waiting for you.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {needsYou.map((n) => (
              <li key={`${n.repoId}:${n.chatId}`}>
                <button type="button" className={rowClass} onClick={() => onOpenChat(n.chatId)}>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{n.title || 'Untitled chat'}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {n.repoName} · {WAITING_LABEL[n.reason]}
                    </span>
                  </div>
                  <Badge className="h-4 px-1.5 text-[10px]">Needs you</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Projects" count={projects.length}>
        {projects.length === 0 ? (
          <Empty>No projects yet. Run `shipline init` or `shipline ui` in a repo.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((g) => {
              const lone = g.items.length === 1;
              return (
                <div key={g.key} className="flex flex-col gap-2">
                  {!lone && <h3 className="truncate text-xs text-muted-foreground">{g.label}</h3>}
                  <div className={cn('grid gap-2 sm:grid-cols-2', !lone && 'pl-3')}>
                    {g.items.map((p) => (
                      <ProjectCard
                        key={p.id}
                        p={p}
                        onNewChat={onNewChat}
                        onSetup={onSetup}
                        onRemove={setRemoving}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Unfinished tasks" count={tasks.length}>
        {tasks.length === 0 ? (
          <Empty>No unfinished tasks.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {projects
              .filter((p) => tasksByProject.has(p.id))
              .map((p) => (
                <div key={p.id} className="flex flex-col gap-2">
                  <h3 className="truncate text-xs text-muted-foreground">
                    {p.name}
                    {p.branch ? ` · ${p.branch}` : ''}
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {(tasksByProject.get(p.id) ?? []).map((t) => {
                      const stage = currentStage(t.stages);
                      return (
                        <li key={t.dir}>
                          <button
                            type="button"
                            className={rowClass}
                            onClick={() => onNewChat(t.repoId)}
                          >
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                              <span className="truncate font-medium">{t.title || t.slug}</span>
                              <span className="truncate text-xs text-muted-foreground">
                                {t.workflow}
                                {stage ? ` · ${stage.name}` : ''}
                              </span>
                            </div>
                            <StageTrail stages={t.stages} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </Section>

      <Section title="Health">
        {attention > 0 ? (
          <button
            type="button"
            className="self-start text-sm underline underline-offset-2"
            onClick={onOpenHealth}
          >
            {attention} {attention === 1 ? 'project needs' : 'projects need'} attention → Health
          </button>
        ) : (
          <p className="text-sm text-muted-foreground">All projects healthy</p>
        )}
      </Section>

      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !remove.isPending && !o && setRemoving(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing?.name} from the list?</DialogTitle>
            <DialogDescription>
              This only forgets the project here. The folder, its Shipline files and its task data
              stay where they are, and `shipline init`, `ui` or `upgrade` in it adds it back.
            </DialogDescription>
          </DialogHeader>
          <code className="rounded bg-muted px-2 py-1 font-mono text-xs break-all">
            {removing?.root}
          </code>
          <DialogFooter>
            <Button variant="outline" disabled={remove.isPending} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing.id)}
            >
              {remove.isPending ? 'Removing...' : 'Remove from list'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
