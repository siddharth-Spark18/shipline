import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { DOT_CLASS, DOT_LABEL } from '@/components/app-sidebar';
import { HealthCard, STATE_LABEL } from '@/components/banners';
import { projectLabel } from '@/components/chat-row';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import { useHealth, useProjects } from '@/lib/queries';
import type { HealthData, Project, ProjectHealthRow } from '@/lib/types';
import { DiagnosticsBody } from '@/pages/diagnostics';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border bg-card p-3 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function phoneText(phone: HealthData['machine']['phone']): string {
  if (!phone) return 'unknown';
  if (phone.enabled) return `on, ${phone.url ?? ''}`;
  if (phone.tailscale.state !== 'ok') return `off (${phone.tailscale.message || phone.tailscale.state})`;
  return 'off';
}

function MachineSection({ machine }: { machine: HealthData['machine'] }) {
  const c = machine.claude;
  const claudeText = !c.installed
    ? 'not installed'
    : `${c.version ?? 'unknown version'}${c.meetsMinVersion ? '' : ` (needs ${c.minVersion} or newer)`}, ${c.signedIn ? 'signed in' : 'not signed in'}`;
  return (
    <Section title="This machine">
      <Facts
        rows={[
          ['Shipline server', machine.uiVersion],
          ['Started by CLI', machine.cliVersion],
          ['Claude', claudeText],
          ['Claude path', c.path ?? 'not found'],
          ['Node', machine.node],
          ['Port', String(machine.port)],
          ['Phone access', phoneText(machine.phone)],
        ]}
      />
      <details className="rounded-lg border bg-card p-3 text-sm">
        <summary className="cursor-pointer">Server log (last {machine.logTail.length} lines)</summary>
        {machine.logTail.length === 0 ? (
          <p className="pt-2 text-muted-foreground">The log is empty.</p>
        ) : (
          <pre className="mt-2 max-h-72 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
            {machine.logTail.join('\n')}
          </pre>
        )}
      </details>
    </Section>
  );
}

function ProjectRow({
  project,
  row,
  uiVersion,
  onRemove,
}: {
  project: Project;
  row: ProjectHealthRow;
  uiVersion: string;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const state = STATE_LABEL[row.state] ?? 'Ready';
  const facts = [
    state,
    row.state === 'ok' ? (row.setupDone ? 'setup done' : 'setup not done') : null,
    row.configError ? 'config error' : null,
    row.lock ? `chat lock held (pid ${row.lock.pid ?? '?'}, port ${row.lock.port ?? '?'})` : null,
    row.warnings > 0 ? `${row.warnings} warning${row.warnings === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const needsCard = row.state !== 'ok' || row.upgradeAvailable;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex min-h-12 w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm"
        >
          <span
            role="img"
            aria-label={DOT_LABEL[row.dot]}
            title={DOT_LABEL[row.dot]}
            className={cn('size-2.5 shrink-0 rounded-full', DOT_CLASS[row.dot])}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">
              {projectLabel(project)}
              {project.branch ? ` · ${project.branch}` : ''}
            </span>
            <span className="truncate text-xs text-muted-foreground">{facts.join(' · ')}</span>
          </div>
          <ChevronDownIcon
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t p-3">
        {row.configError && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive break-words">
            config.yml: {row.configError}
          </p>
        )}
        {needsCard && (
          <HealthCard
            health={{
              repoId: project.id,
              name: project.name,
              root: project.root,
              state: row.state,
              version: row.version,
              uiVersion,
              upgradeAvailable: row.upgradeAvailable,
              setupDone: row.setupDone,
              message: row.message,
            }}
            onRemove={onRemove}
          />
        )}
        {row.state === 'ok' ? (
          open && <DiagnosticsBody repoId={project.id} />
        ) : (
          <p className="text-xs text-muted-foreground">Diagnostics are available once the project is served.</p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** `#/health`: the machine (server, Claude, Node, phone access, server log) and one row per project. */
export function HealthPage() {
  const queryClient = useQueryClient();
  const health = useHealth();
  const projects = useProjects();
  const remove = useMutation({
    mutationFn: (id: string) => api.removeProject(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allChats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't remove this project"),
  });

  if (health.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading...</p>;
  if (health.error || !health.data) {
    return (
      <p className="p-4 text-sm text-destructive">{health.error?.message ?? 'Could not load Health.'}</p>
    );
  }
  const { machine, projects: rows } = health.data;
  const byId = new Map((projects.data ?? []).map((p) => [p.id, p]));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Redacted by the server. Safe to paste into a bug report.</p>
        <Button variant="outline" size="sm" disabled={health.isFetching} onClick={() => void health.refetch()}>
          Refresh
        </Button>
      </div>
      <MachineSection machine={machine} />
      <Section title="Projects">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            No projects yet. Run `shipline init` or `shipline ui` in a repo.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((row) => {
              const project = byId.get(row.id);
              return project ? (
                <ProjectRow
                  key={row.id}
                  project={project}
                  row={row}
                  uiVersion={machine.uiVersion}
                  onRemove={(id) => remove.mutate(id)}
                />
              ) : null;
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
