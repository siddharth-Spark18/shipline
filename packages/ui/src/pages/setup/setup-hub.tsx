import type { ReactNode } from 'react';
import { ChevronRightIcon, SparklesIcon } from 'lucide-react';
import { cn } from 'cn';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AppearanceCard } from '@/pages/setup/appearance-card';
import { MODES } from '@/pages/setup/ci-check';
import { useDiscardDraft } from '@/pages/setup/draft-review';
import { railCounts } from '@/pages/setup/guardrails-section';
import { isConfigDirty, isWorkflowDirty, type Drafts } from '@/pages/setup/draft';
import { useIsMobile } from '@/hooks/use-mobile';
import { useRemote } from '@/lib/queries';
import { setupSubHash, type SetupSub } from '@/lib/routes';
import type { ConfigModel, SetupData, WorkflowDraftInfo } from '@/lib/types';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One summary card: a title that opens the page (a real link, stretched over the card), the number or state, a
 * line of detail, and optional actions. On a phone it is a list row with a chevron.
 */
function HubCard({
  repoId,
  to,
  title,
  value,
  detail,
  hero,
  mobile,
  children,
}: {
  repoId: string;
  to: SetupSub;
  title: string;
  value: ReactNode;
  detail: ReactNode;
  hero?: boolean;
  mobile: boolean;
  /** Actions that sit above the stretched link. */
  children?: ReactNode;
}) {
  const href = setupSubHash(repoId, to);
  if (mobile) {
    return (
      <div
        className={cn(
          'relative flex min-h-14 flex-col gap-1 border-b bg-card px-3 py-3 last:border-b-0',
          hero && 'bg-primary text-primary-foreground',
        )}
      >
        <a
          href={href}
          className="flex items-center gap-2 outline-none after:absolute after:inset-0 focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
        >
          <b className="text-sm">{title}</b>
          <span className="ml-auto text-sm font-semibold">{value}</span>
          <ChevronRightIcon className="size-4 shrink-0 opacity-70" aria-hidden />
        </a>
        <span className={cn('text-xs', hero ? 'text-primary-foreground' : 'text-muted-foreground')}>
          {detail}
        </span>
        {children && <div className="relative z-10 flex flex-wrap gap-2 pt-1">{children}</div>}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'relative flex min-h-32 flex-col gap-1.5 rounded-xl border bg-card p-4 shadow-[0_1px_0_var(--border)]',
        hero && 'border-0 bg-primary text-primary-foreground',
      )}
    >
      <b className="text-sm">
        <a
          href={href}
          className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
        >
          {title}
        </a>
      </b>
      <span className={cn('text-2xl font-extrabold tracking-tight', !hero && 'text-primary')}>
        {value}
      </span>
      <span className={cn('text-xs', hero ? 'text-primary-foreground' : 'text-muted-foreground')}>
        {detail}
      </span>
      {children && (
        <div className="relative z-10 mt-auto flex flex-wrap gap-2 pt-2">{children}</div>
      )}
    </div>
  );
}

/** The hub while the setup files load. */
export function SetupHubSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-3" aria-busy="true" aria-label="Loading setup">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-32 rounded-xl" />
      ))}
    </div>
  );
}

function DraftCard({
  draft,
  readOnly,
  onReview,
}: {
  draft: WorkflowDraftInfo;
  readOnly: boolean;
  onReview: () => void;
}) {
  const discard = useDiscardDraft();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
      <Badge>Draft ready</Badge>
      <b className="min-w-0 truncate text-sm">{draft.name}</b>
      <span className="text-xs text-muted-foreground">
        {draft.isNew ? 'new workflow' : 'changed workflow'}
      </span>
      {(draft.stale || draft.staleRules.length > 0) && <Badge variant="outline">Stale</Badge>}
      {draft.errors.length > 0 && <Badge variant="destructive">Invalid</Badge>}
      <span className="flex-1" />
      <Button size="sm" className="max-md:h-11" onClick={onReview}>
        Review draft
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="max-md:h-11"
        disabled={readOnly || discard.isPending}
        onClick={() => discard.mutate(draft.workflowId)}
      >
        Discard
      </Button>
    </div>
  );
}

/**
 * Setup's front page: the default-rules call to action, drafts waiting for review, then one summary card per area
 * (Workflows, Guardrails, Agents & skills, CI check, Phone access, Project config) and the Appearance card. Every
 * summary comes from data the Setup page already holds.
 */
export function SetupHub({
  repoId,
  data,
  drafts,
  workflowDrafts,
  usesDefaultRules,
  readOnly,
  readOnlyMessage,
  startingChat,
  hasEdits,
  markingDone,
  designerSupported,
  upgradeHint,
  onRunSetup,
  onMarkDone,
  onDescribe,
  onReviewDraft,
}: {
  repoId: string;
  data: SetupData;
  drafts: Drafts;
  workflowDrafts: WorkflowDraftInfo[];
  usesDefaultRules: boolean;
  readOnly: boolean;
  /** Why the repo is read-only (the server's version text), or null for the generic one. */
  readOnlyMessage: string | null;
  startingChat: boolean;
  /** Unsaved edits exist (Mark done reloads the files, which would drop them). */
  hasEdits: boolean;
  markingDone: boolean;
  designerSupported: boolean;
  upgradeHint: string;
  onRunSetup: () => void;
  onMarkDone: () => void;
  onDescribe: () => void;
  onReviewDraft: (workflowId: string) => void;
}) {
  const mobile = useIsMobile();
  const remote = useRemote();

  const workflowIds = data.workflows.map((w) => w.id).filter((id): id is string => !!id);
  const dirtyWorkflows = workflowIds.filter((id) => isWorkflowDirty(data, drafts, id)).length;
  const shown = workflowIds.slice(0, 5).join(', ') + (workflowIds.length > 5 ? ', ...' : '');

  const config: ConfigModel | null = drafts.config;
  const rails = railCounts(config);
  const protectedPaths = config?.protected_paths?.length ?? 0;
  const extraCommands =
    (config?.rails_commands?.deploy?.length ?? 0) + (config?.rails_commands?.migrate?.length ?? 0);

  const shiplineInstalled = data.agents.shipline.filter((a) => a.installed && !a.excluded).length;
  const own =
    data.agents.repo.length + data.agents.shipline.filter((a) => a.installed && a.excluded).length;

  const configDirty = isConfigDirty(data, drafts);
  const ci = data.ci;
  const devices = remote.data?.devices.length ?? 0;

  const cards = (
    <>
      <HubCard
        repoId={repoId}
        to={{ page: 'workflows' }}
        title="Workflows"
        hero
        mobile={mobile}
        value={workflowIds.length}
        detail={
          <>
            {shown || 'No workflows yet'}
            {dirtyWorkflows > 0 ? ` · ${dirtyWorkflows} unsaved` : ''}
          </>
        }
      >
        {designerSupported ? (
          <Button
            variant="secondary"
            size="sm"
            className="max-md:h-11"
            disabled={readOnly || startingChat}
            onClick={onDescribe}
          >
            <SparklesIcon /> Describe a workflow
          </Button>
        ) : (
          <span className="text-xs">{upgradeHint}</span>
        )}
      </HubCard>
      <HubCard
        repoId={repoId}
        to={{ page: 'guardrails' }}
        title="Guardrails"
        mobile={mobile}
        value={config ? `${rails.deny} deny / ${rails.ask} ask` : 'Unreadable'}
        detail={
          config
            ? `${plural(protectedPaths, 'protected path')}, ${plural(extraCommands, 'extra command')}`
            : 'config.yml does not parse'
        }
      />
      <HubCard
        repoId={repoId}
        to={{ page: 'agents' }}
        title="Agents & skills"
        mobile={mobile}
        value={shiplineInstalled + own}
        detail={`${shiplineInstalled} Shipline ${shiplineInstalled === 1 ? 'agent' : 'agents'} installed, ${own} of yours`}
      />
      <HubCard
        repoId={repoId}
        to={{ page: 'ci' }}
        title="CI check"
        mobile={mobile}
        value={ci.installed ? 'Installed' : 'Not installed'}
        detail={
          MODES.find((m) => m.value === ci.missing_block)?.label ?? 'Pull-request check settings'
        }
      />
      <HubCard
        repoId={repoId}
        to={{ page: 'phone' }}
        title="Phone access"
        mobile={mobile}
        value={remote.data ? plural(devices, 'device') : '...'}
        detail={
          remote.data
            ? remote.data.enabled
              ? 'On, over Tailscale'
              : remote.data.tailscale.state === 'ok'
                ? 'Off'
                : 'Off, Tailscale needs attention'
            : 'Checking'
        }
      />
      <HubCard
        repoId={repoId}
        to={{ page: 'config' }}
        title="Project config"
        mobile={mobile}
        value={config?.tracker || 'none'}
        detail={`Tracker, confirmations, branch pattern, commands${configDirty ? ' · 1 unsaved' : ''}`}
      />
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      {usesDefaultRules && (
        <Alert className="bg-accent text-accent-foreground">
          <AlertTitle>This repo uses Shipline&apos;s default rules</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-accent-foreground">
            <span>
              Claude can interview you and tailor the workflows, rules and commands to this repo. Or
              open the cards below and edit them yourself, then mark setup as done.
            </span>
            <span className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="max-md:h-11"
                disabled={readOnly || startingChat}
                onClick={onRunSetup}
              >
                Run setup with Claude
              </Button>
              {!readOnly && (
                <Button
                  size="sm"
                  variant="outline"
                  className="max-md:h-11"
                  disabled={markingDone || hasEdits}
                  title={hasEdits ? 'Save or discard your changes first' : undefined}
                  onClick={onMarkDone}
                >
                  Mark setup as done
                </Button>
              )}
            </span>
          </AlertDescription>
        </Alert>
      )}
      {readOnly && (
        <Alert>
          <AlertTitle>This repo is read-only here</AlertTitle>
          <AlertDescription>
            {readOnlyMessage ??
              'It was set up with a different Shipline than this UI, so nothing can be saved from this page.'}{' '}
            The cards still open so you can look around.
          </AlertDescription>
        </Alert>
      )}

      {workflowDrafts.map((d) => (
        <DraftCard
          key={d.workflowId}
          draft={d}
          readOnly={readOnly}
          onReview={() => onReviewDraft(d.workflowId)}
        />
      ))}

      {mobile ? (
        <div className="overflow-hidden rounded-xl border bg-card">{cards}</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{cards}</div>
      )}

      <AppearanceCard />
    </div>
  );
}
