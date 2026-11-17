import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, ChevronRightIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DiffView } from '@/components/diff-view';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { AddWorkflowDialog } from '@/pages/setup/add-workflow-dialog';
import { AgentsSkills } from '@/pages/setup/agents-skills';
import { CiCheck } from '@/pages/setup/ci-check';
import { DraftReview } from '@/pages/setup/draft-review';
import { PhoneAccess } from '@/pages/setup/phone-access';
import { ConfigForm } from '@/pages/setup/config-form';
import { GuardrailsSection } from '@/pages/setup/guardrails-section';
import { NewWorkflowDialog } from '@/pages/setup/new-workflow-dialog';
import { SaveDialog, fileLabel } from '@/pages/setup/save-dialog';
import { SetupHub, SetupHubSkeleton } from '@/pages/setup/setup-hub';
import { StagePage } from '@/pages/setup/stage-page';
import { WorkflowEditor } from '@/pages/setup/workflow-editor';
import { WorkflowsPage } from '@/pages/setup/workflows-page';
import {
  buildEntries,
  findRules,
  initDrafts,
  isWorkflowDirty,
  removedStageIds,
  type Drafts,
  type WorkflowDraft,
} from '@/pages/setup/draft';
import { useIsMobile } from '@/hooks/use-mobile';
import { chatStore } from '@/pages/chat/chat-store';
import { ApiError, api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import { useDrafts } from '@/lib/queries';
import { setupHash, stageHash, workflowHash, workflowsHash, type SetupSub } from '@/lib/routes';
import type { ConfigModel, ValidationIssue, VersionState } from '@/lib/types';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const SETUP_MESSAGE = '/shipline-setup';
/** Starts the workflow designer skill in UI mode: it interviews the user and leaves a draft to review here. */
const DESCRIBE_MESSAGE = '/shipline-workflow-designer --draft';
const changeMessage = (workflowId: string) => `${DESCRIBE_MESSAGE} --edit ${workflowId}`;
const UPGRADE_HINT = 'Upgrade this repo to use Describe a workflow';

const PAGE_TITLE = {
  guardrails: 'Guardrails',
  agents: 'Agents & skills',
  ci: 'CI check',
  phone: 'Phone access',
  config: 'Project config',
} as const;

/** The page one step up: stage to workflow, workflow to the list, the list and the other pages to the hub. */
function parentHash(repoId: string, sub: SetupSub): string {
  switch (sub.page) {
    case 'stage':
      return workflowHash(repoId, sub.workflowId);
    case 'workflow':
      return workflowsHash(repoId);
    default:
      return setupHash(repoId);
  }
}

export default function SetupPage({
  repoId,
  sub,
  navigate,
  versionState,
  versionMessage = null,
  onChatStarted,
  draftId,
  onOpenDraft,
  onCloseDraft,
}: {
  repoId: string;
  /** Which page of Setup the address names (see lib/routes.ts). */
  sub: SetupSub;
  /** Go to another address (a hash). */
  navigate: (hash: string) => void;
  versionState: VersionState | undefined;
  /** The server's text for a repo that is read-only here. */
  versionMessage?: string | null;
  /** Called with the id of the chat started by "Set up with Claude", so the app can show it. */
  onChatStarted: (id: string) => void;
  /** The workflow draft open for review (the route #/setup/<repoId>/draft/<workflowId>), or null. */
  draftId: string | null;
  onOpenDraft: (workflowId: string) => void;
  onCloseDraft: () => void;
}) {
  const queryClient = useQueryClient();
  const mobile = useIsMobile();
  const readOnly = versionState === 'repo-newer' || versionState === 'pre-1.0';

  const { data, dataUpdatedAt, error, isPending, refetch } = useQuery({
    queryKey: queryKeys.setup,
    queryFn: api.setup,
    staleTime: Infinity,
  });

  const workflowDrafts = useDrafts();
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newWorkflowOpen, setNewWorkflowOpen] = useState(false);
  const [addWorkflowOpen, setAddWorkflowOpen] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  // On a phone the stage page's Back/Next sit in the same pinned strip as the unsaved bar (see the end of the page).
  const [pagerSlot, setPagerSlot] = useState<HTMLElement | null>(null);

  // Whenever the files are (re)loaded from disk, the edit copies start over from them.
  useEffect(() => {
    if (data) setDrafts(initDrafts(data));
  }, [data, dataUpdatedAt]);

  const entries = useMemo(() => (data && drafts ? buildEntries(data, drafts) : []), [data, drafts]);
  const entriesJson = JSON.stringify(entries);
  const debouncedJson = useDebounced(entriesJson, 300);

  // Live preview, 300 ms after the last edit. The server runs the whole save pipeline without writing.
  const preview = useQuery({
    queryKey: ['setup-preview', debouncedJson],
    queryFn: () => api.previewSetup({ files: JSON.parse(debouncedJson) }),
    enabled: debouncedJson !== '[]',
    staleTime: 0,
    gcTime: 0,
  });
  const previewPending = entriesJson !== debouncedJson || preview.isFetching;
  const previewData =
    entriesJson === debouncedJson && entries.length > 0 ? preview.data : undefined;

  const save = useMutation({
    mutationFn: () => api.saveSetup({ files: entries }),
    onSuccess: async () => {
      setDialogOpen(false);
      toast.success('Saved. Commit these files so teammates get the change.');
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });

  const markDone = useMutation({
    mutationFn: api.markSetupDone,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.setup }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Something went wrong.'),
  });

  // An address that names a workflow or stage that isn't there goes to the nearest page that is. It waits for the files
  // and the edit copies (so it never acts on half-loaded data) and checks the stage list with the unsaved edits applied.
  let redirect: { to: string; message?: string } | null = null;
  if (data && drafts && (sub.page === 'workflow' || sub.page === 'stage')) {
    const file = data.workflows.find((w) => w.id === sub.workflowId);
    if (!file) {
      redirect = { to: workflowsHash(repoId), message: `Workflow ${sub.workflowId} not found` };
    } else if (sub.page === 'stage') {
      if (file.parseError !== undefined) redirect = { to: workflowHash(repoId, sub.workflowId) };
      else {
        const draft = drafts.workflows[sub.workflowId];
        // A workflow created a moment ago has no edit copy until the effect above has run.
        if (draft && sub.n > (draft.model.stages ?? []).length)
          redirect = { to: workflowHash(repoId, sub.workflowId) };
      }
    }
  }
  const redirectTo = redirect?.to ?? null;
  const redirectMessage = redirect?.message;
  useEffect(() => {
    if (!redirectTo) return;
    if (redirectMessage) toast.error(redirectMessage);
    // Replace, so Back does not return to the address that does not exist.
    window.location.replace(redirectTo);
  }, [redirectTo, redirectMessage]);

  if (isPending || !drafts) {
    return error ? (
      <Alert variant="destructive">
        <AlertTitle>Could not load the setup files</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          {error.message}
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    ) : sub.page === 'hub' ? (
      <SetupHubSkeleton />
    ) : (
      <p className="text-sm text-muted-foreground">Loading...</p>
    );
  }
  if (!data) return null;

  const workflowIds = data.workflows.map((w) => w.id!).filter(Boolean);

  const updateWorkflow = (id: string, draft: WorkflowDraft) =>
    setDrafts((d) => (d ? { ...d, workflows: { ...d.workflows, [id]: draft } } : d));
  const updateRules = (stageId: string, text: string) =>
    setDrafts((d) => (d ? { ...d, rules: { ...d.rules, [stageId]: text } } : d));
  const updateConfig = (m: ConfigModel) => setDrafts((d) => (d ? { ...d, config: m } : d));

  // Shown until /shipline-setup writes `setup: done` into config.yml.
  const usesDefaultRules = (data.config.model as ConfigModel | undefined)?.setup !== 'done';
  const startChat = async (message: string) => {
    setStartingChat(true);
    try {
      const { id } = await api.createChat(message);
      chatStore.addUser(id, message, true, []);
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      onChatStarted(id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'chat-active') {
        toast.info('Finish or stop the current chat first.');
      } else toast.error(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setStartingChat(false);
    }
  };

  const startSetupChat = () => startChat(SETUP_MESSAGE);
  const designerSupported = data.designer?.supported === true;

  const saveError = save.error;
  const conflict = saveError instanceof ApiError && saveError.status === 409;
  const saveIssues: ValidationIssue[] =
    saveError instanceof ApiError &&
    saveError.code === 'invalid' &&
    Array.isArray(saveError.details)
      ? (saveError.details as ValidationIssue[])
      : [];

  const reload = async () => {
    save.reset();
    setDialogOpen(false);
    await refetch();
  };

  const workflowFile =
    sub.page === 'workflow' || sub.page === 'stage'
      ? data.workflows.find((w) => w.id === sub.workflowId)
      : undefined;
  const workflowDraft =
    workflowFile?.id && workflowFile.parseError === undefined
      ? drafts.workflows[workflowFile.id]
      : undefined;
  const stageModel =
    sub.page === 'stage' ? (workflowDraft?.model.stages ?? [])[sub.n - 1] : undefined;

  // The breadcrumb: Setup > Workflows > <workflow> > <stage>, or Setup > <page>.
  const crumbs: { label: string; to: string | null }[] = [
    { label: 'Setup', to: setupHash(repoId) },
  ];
  if (sub.page === 'workflows' || sub.page === 'workflow' || sub.page === 'stage')
    crumbs.push({
      label: 'Workflows',
      to: sub.page === 'workflows' ? null : workflowsHash(repoId),
    });
  if (sub.page === 'workflow' || sub.page === 'stage')
    crumbs.push({
      label: sub.workflowId,
      to: sub.page === 'stage' ? workflowHash(repoId, sub.workflowId) : null,
    });
  if (sub.page === 'stage')
    crumbs.push({ label: stageModel?.name || stageModel?.id || `Stage ${sub.n}`, to: null });
  if (sub.page in PAGE_TITLE)
    crumbs.push({ label: PAGE_TITLE[sub.page as keyof typeof PAGE_TITLE], to: null });

  const renderPage = () => {
    switch (sub.page) {
      case 'hub':
        return (
          <SetupHub
            repoId={repoId}
            data={data}
            drafts={drafts}
            workflowDrafts={workflowDrafts.data ?? []}
            usesDefaultRules={usesDefaultRules}
            readOnly={readOnly}
            readOnlyMessage={versionMessage}
            startingChat={startingChat}
            hasEdits={entries.length > 0}
            markingDone={markDone.isPending}
            designerSupported={designerSupported}
            upgradeHint={UPGRADE_HINT}
            onRunSetup={() => void startSetupChat()}
            onMarkDone={() => markDone.mutate()}
            onDescribe={() => void startChat(DESCRIBE_MESSAGE)}
            onReviewDraft={onOpenDraft}
          />
        );
      case 'workflows':
        return (
          <WorkflowsPage
            repoId={repoId}
            data={data}
            drafts={drafts}
            readOnly={readOnly}
            designerSupported={designerSupported}
            startingChat={startingChat}
            upgradeHint={UPGRADE_HINT}
            onNew={() => setNewWorkflowOpen(true)}
            onAddShipped={() => setAddWorkflowOpen(true)}
            onDescribe={() => void startChat(DESCRIBE_MESSAGE)}
          />
        );
      case 'workflow':
      case 'stage': {
        // Not found: the redirect above is on its way.
        if (!workflowFile) return null;
        if (workflowFile.parseError !== undefined) {
          return (
            <WorkflowEditor
              key={workflowFile.id}
              file={workflowFile}
              draft={undefined}
              dirty={false}
              repoId={repoId}
              existingIds={workflowIds}
              otherWorkflows={[]}
              readOnly={readOnly}
              onChange={() => {}}
              navigate={navigate}
            />
          );
        }
        // The edit copy of a workflow created a moment ago is made by the effect above.
        if (!workflowDraft) return null;
        if (sub.page === 'stage') {
          return (
            <StagePage
              key={`${workflowFile.id}:${sub.n}`}
              n={sub.n}
              step={sub.step}
              draft={workflowDraft}
              agents={data.agents}
              rules={(id) => ({ text: drafts.rules[id] ?? '', exists: !!findRules(data, id) })}
              mobile={mobile}
              pagerSlot={pagerSlot}
              onStep={(to) => navigate(stageHash(repoId, workflowFile.id!, sub.n, to))}
              onClose={() => navigate(workflowHash(repoId, workflowFile.id!))}
              onChange={(d) => updateWorkflow(workflowFile.id!, d)}
              onRulesChange={updateRules}
            />
          );
        }
        return (
          <WorkflowEditor
            key={workflowFile.id}
            file={workflowFile}
            draft={workflowDraft}
            dirty={isWorkflowDirty(data, drafts, workflowFile.id!)}
            repoId={repoId}
            existingIds={workflowIds}
            otherWorkflows={data.workflows
              .filter((w) => w.id && w.id !== workflowFile.id)
              .map((w) => ({ id: w.id!, name: drafts.workflows[w.id!]?.model.name || w.id! }))}
            confirmations={(drafts.config ?? data.config.model)?.confirmations}
            readOnly={readOnly}
            onChange={(d) => updateWorkflow(workflowFile.id!, d)}
            navigate={navigate}
            onChangeWithClaude={
              designerSupported && !startingChat
                ? () => void startChat(changeMessage(workflowFile.id!))
                : undefined
            }
          />
        );
      }
      case 'guardrails':
        return (
          <GuardrailsSection
            key={dataUpdatedAt}
            model={drafts.config}
            readOnly={readOnly}
            onChange={updateConfig}
          />
        );
      case 'agents':
        return (
          <AgentsSkills
            data={data}
            config={drafts.config}
            onConfigChange={updateConfig}
            readOnly={readOnly}
            hasOtherEdits={entries.length > 0}
            onReload={() => void reload()}
          />
        );
      case 'ci':
        return (
          <CiCheck
            key={dataUpdatedAt}
            data={data}
            readOnly={readOnly}
            hasOtherEdits={entries.length > 0}
            onReload={() => void reload()}
          />
        );
      case 'phone':
        return <PhoneAccess />;
      case 'config':
        return <ConfigForm file={data.config} model={drafts.config} onChange={updateConfig} />;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {sub.page !== 'hub' && (
          <Button
            variant="outline"
            size="sm"
            className="max-md:h-11"
            onClick={() => navigate(parentHash(repoId, sub))}
          >
            <ArrowLeftIcon /> Back
          </Button>
        )}
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <ChevronRightIcon className="size-3" aria-hidden />}
                <li className="min-w-0 truncate">
                  {c.to ? (
                    <a className="underline-offset-2 hover:underline" href={c.to}>
                      {c.label}
                    </a>
                  ) : (
                    <b
                      className="text-foreground"
                      aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                    >
                      {c.label}
                    </b>
                  )}
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
      </div>

      {!mobile && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card/95 px-3 py-2 shadow-xs backdrop-blur">
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              className={`size-2 shrink-0 rounded-full ${entries.length === 0 ? 'bg-stage-done' : 'bg-enf-warn'}`}
              aria-hidden
            />
            {entries.length === 0
              ? 'No unsaved changes.'
              : `${entries.length} unsaved: ${entries.map(fileLabel).join(', ')}`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              {entries.length === 0 ? 'Reload from disk' : 'Discard'}
            </Button>
            <Button
              size="sm"
              disabled={entries.length === 0 || readOnly}
              onClick={() => setDialogOpen(true)}
            >
              Review and save
            </Button>
          </div>
        </div>
      )}

      <div className="min-w-0">{renderPage()}</div>

      {sub.page === 'hub' && entries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Preview of the files as they will be written
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {previewPending && !previewData && (
              <p className="text-sm text-muted-foreground">Updating...</p>
            )}
            {preview.error && entriesJson === debouncedJson && (
              <p className="text-sm text-destructive">{preview.error.message}</p>
            )}
            {previewData?.files.map((f) => (
              <Collapsible key={fileLabel(f)} className="rounded-lg border bg-card px-3 py-2">
                <CollapsibleTrigger className="font-mono text-sm">
                  {fileLabel(f)}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <Tabs defaultValue="diff" className="mt-2">
                    <TabsList>
                      <TabsTrigger value="diff">Diff</TabsTrigger>
                      <TabsTrigger value="file">Full file</TabsTrigger>
                    </TabsList>
                    <TabsContent value="diff">
                      <DiffView hunks={f.diff} className="max-h-96 overflow-auto" />
                    </TabsContent>
                    <TabsContent value="file">
                      <pre className="max-h-96 overflow-auto font-mono text-xs">
                        {f.text ?? '(file removed)'}
                      </pre>
                    </TabsContent>
                  </Tabs>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </CardContent>
        </Card>
      )}

      {mobile && (
        // Sticks to the bottom of the scrolling page, right above the tab bar: the stage page's Back/Next (portalled
        // into the first div), then the unsaved bar.
        <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-col">
          <div ref={setPagerSlot} />
          {entries.length > 0 && (
            <div className="flex items-center gap-2 border-t bg-card px-4 py-2">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {entries.length} unsaved: {entries.map(fileLabel).join(', ')}
              </span>
              <Button variant="outline" className="h-11 px-3" onClick={() => void reload()}>
                Discard
              </Button>
              <Button className="h-11 px-3" disabled={readOnly} onClick={() => setDialogOpen(true)}>
                Review and save
              </Button>
            </div>
          )}
        </div>
      )}

      <NewWorkflowDialog
        open={newWorkflowOpen}
        onOpenChange={setNewWorkflowOpen}
        existingIds={workflowIds}
        onCreated={(id) => navigate(workflowHash(repoId, id))}
      />

      <AddWorkflowDialog
        open={addWorkflowOpen}
        onOpenChange={setAddWorkflowOpen}
        data={data}
        onAdded={(id) => navigate(workflowHash(repoId, id))}
      />

      {draftId && <DraftReview workflowId={draftId} readOnly={readOnly} onClose={onCloseDraft} />}

      <SaveDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) save.reset();
        }}
        preview={previewData}
        previewLoading={previewPending}
        previewError={entriesJson === debouncedJson ? preview.error : null}
        readOnly={readOnly}
        saving={save.isPending}
        saveError={saveError}
        saveIssues={saveIssues}
        conflict={conflict}
        removedStages={removedStageIds(data, drafts)}
        onSave={() => save.mutate()}
        onReload={() => void reload()}
      />
    </div>
  );
}
