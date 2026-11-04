import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import LocalBanner from '@/components/local/local-banner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import EmptyState from '@/components/shared/empty-state';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import StatusBar from '@/pages/ticket-workspace/components/status-bar/status-bar';
import { useChatStates } from '@/pages/ticket-workspace/components/chat-list/use-chat-states';
import { useLocalProjects, useLocalReady } from '@/services/local/local.hooks';
import { useProjectTemplates, useProjects } from '@/services/projects/projects.hooks';
import { useCreateChat } from '@/services/tickets/tickets.hooks';

/**
 * Home is the new-chat screen: pick a project (recent first), describe the work, start. The chat
 * gets its per-project key (e.g. LL-12) straight away; Jira is optional and Claude asks about it in
 * its first reply.
 */
export default function HomePage() {
  const navigate = useNavigate();
  const projects = useProjects();
  const local = useLocalReady();
  const localProjects = useLocalProjects(local.state === 'ready');
  const { states, waiting } = useChatStates();
  const create = useCreateChat();

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  // The template picked for the chat; null means the project's default. Reset when the project changes.
  const [picked, setPickedTemplate] = useState<{ projectId: string; templateId: string } | null>(null);

  // Recent first: projects ordered by their newest chat; the rest alphabetically (the API order).
  const ordered = useMemo(() => {
    const list = projects.data ?? [];
    const recency = new Map<string, number>();
    for (const { chat } of states) {
      const at = Date.parse(chat.updatedAt);
      if (at > (recency.get(chat.projectId) ?? 0)) recency.set(chat.projectId, at);
    }
    return [...list].sort((a, b) => (recency.get(b.id) ?? 0) - (recency.get(a.id) ?? 0));
  }, [projects.data, states]);

  const project = ordered.find((p) => p.id === pickedId) ?? ordered[0] ?? null;
  const templates = useProjectTemplates(project?.id ?? '');
  const offered = (templates.data ?? []).filter((t) => t.enabled);
  const defaultTemplate = offered.find((t) => t.isDefault) ?? offered[0] ?? null;
  const template = offered.find((t) => t.templateId === (picked?.projectId === project?.id ? picked?.templateId : undefined)) ?? defaultTemplate;
  const localPath = (id: string): string | null => localProjects.data?.find((p) => p.id === id)?.localPath ?? null;
  const canStart = !!project && !!template && !!message.trim() && local.ready && !create.isPending;

  const start = () => {
    if (!project || !template || !canStart) return;
    const text = message.trim();
    create.mutate(
      { projectId: project.id, message: text, templateId: template.templateId },
      {
        // The workspace starts the session with this message as Claude's first turn.
        onSuccess: (chat) => navigate(`/chats/${chat.ticketId}`, { state: { firstMessage: text } }),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <LocalBanner />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        <div className="w-full max-w-[620px] space-y-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">What are we shipping?</h1>
            <p className="text-sm text-muted-foreground">Pick a project first (like opening a folder), then describe the work. Jira is optional.</p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Project</p>
            {projects.isPending ? (
              <Skeleton className="h-14" />
            ) : ordered.length === 0 ? (
              <EmptyState message="You are not on any project yet. Ask an admin to add you." />
            ) : (
              <div className="space-y-2">
                {ordered.map((p) => {
                  const path = localPath(p.id);
                  const selected = p.id === project?.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPickedId(p.id)}
                      aria-pressed={selected}
                      className={cn(
                        'flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2 text-left text-sm',
                        selected ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{p.name}</span>{' '}
                        <span className="text-xs text-muted-foreground">{path ?? p.githubRepo}</span>
                        {local.state === 'ready' && localProjects.isSuccess && !path && (
                          <span className="block text-xs text-amber-700 dark:text-amber-400">
                            No local folder yet:{' '}
                            {/* A <Link> can't sit inside the row <button>; navigate from a span instead. */}
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate(`/projects/${p.id}/settings`);
                              }}
                              className="underline"
                            >
                              choose one in project settings
                            </span>
                            .
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Badge variant="outline">{p.keyPrefix}-n</Badge>
                        <Badge variant="secondary">{p.baseBranch}</Badge>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-xl border bg-card p-3 shadow-xs">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  start();
                }
              }}
              rows={3}
              autoFocus
              placeholder="Describe the work, or paste a Jira key..."
              className="resize-none border-0 p-0 shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-2">
              <Select
                value={template?.templateId ?? ''}
                onValueChange={(templateId) => project && setPickedTemplate({ projectId: project.id, templateId })}
                disabled={offered.length === 0}
              >
                <SelectTrigger size="sm" className="w-auto min-w-40" aria-label="Workflow template" title={template?.stages.map((s) => s.name).join(' > ')}>
                  <SelectValue placeholder={templates.isPending ? 'Loading...' : 'No template enabled'} />
                </SelectTrigger>
                <SelectContent>
                  {offered.map((t) => (
                    <SelectItem key={t.templateId} value={t.templateId}>
                      {t.name}
                      {t.isDefault && <span className="text-xs text-muted-foreground"> (default)</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={start} disabled={!canStart}>
                {create.isPending ? <Loader2 className="animate-spin" /> : <Send />} Start
              </Button>
            </div>
          </div>
          {project && templates.isSuccess && offered.length === 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {project.name} has no workflow template enabled. A project admin can enable one in{' '}
              <Link to={`/projects/${project.id}/settings`} className="underline">
                project settings
              </Link>
              .
            </p>
          )}
          {!local.ready && (
            <p className="text-xs text-muted-foreground">
              Shipline Local must be running and ready to start a chat (see the banner above, or <Link to="/settings" className="underline">Settings</Link>).
            </p>
          )}
        </div>
      </div>
      <StatusBar projectName={project?.name ?? null} waiting={waiting} />
    </div>
  );
}
