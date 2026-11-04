import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DiffView } from '@/components/diff-view';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ConfigForm } from '@/pages/setup/config-form';
import { SaveDialog, fileLabel } from '@/pages/setup/save-dialog';
import { WorkflowEditor } from '@/pages/setup/workflow-editor';
import {
  buildEntries,
  findRules,
  initDrafts,
  isConfigDirty,
  isWorkflowDirty,
  removedStageIds,
  type Drafts,
  type WorkflowDraft,
} from '@/pages/setup/draft';
import { ApiError, api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { ConfigModel, ValidationIssue, VersionState } from '@/lib/types';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function SetupPage({ versionState }: { versionState: VersionState | undefined }) {
  const queryClient = useQueryClient();
  const readOnly = versionState === 'repo-newer';

  const { data, dataUpdatedAt, error, isPending, refetch } = useQuery({
    queryKey: queryKeys.setup,
    queryFn: api.setup,
    staleTime: Infinity,
  });

  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [selected, setSelected] = useState('config');
  const [dialogOpen, setDialogOpen] = useState(false);

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

  if (isPending || !drafts) {
    return error ? (
      <Alert variant="destructive">
        <AlertTitle>Could not load the setup files</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    ) : (
      <p className="text-sm text-muted-foreground">Loading...</p>
    );
  }
  if (!data) return null;

  const workflowIds = data.workflows.map((w) => w.id!).filter(Boolean);
  const current = selected === 'config' || workflowIds.includes(selected) ? selected : 'config';
  const workflowFile = data.workflows.find((w) => w.id === current);

  const updateWorkflow = (id: string, draft: WorkflowDraft) =>
    setDrafts((d) => (d ? { ...d, workflows: { ...d.workflows, [id]: draft } } : d));
  const updateRules = (stageId: string, text: string) =>
    setDrafts((d) => (d ? { ...d, rules: { ...d.rules, [stageId]: text } } : d));

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

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card/95 px-3 py-2 shadow-xs backdrop-blur">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <span
            className={`size-2 shrink-0 rounded-full ${entries.length === 0 ? 'bg-stage-done' : 'bg-enf-warn'}`}
            aria-hidden
          />
          {entries.length === 0
            ? 'No unsaved changes.'
            : `${entries.length} changed ${entries.length === 1 ? 'file' : 'files'}: ${entries.map(fileLabel).join(', ')}`}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {entries.length === 0 ? 'Reload from disk' : 'Discard and reload'}
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

      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        <nav className="flex flex-row flex-wrap gap-1 md:flex-col md:self-start" aria-label="Setup files">
          <Button
            variant={current === 'config' ? 'secondary' : 'ghost'}
            className="justify-start"
            onClick={() => setSelected('config')}
          >
            config.yml{isConfigDirty(data, drafts) ? ' *' : ''}
          </Button>
          <p className="mt-2 hidden px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase md:block">
            Workflows
          </p>
          {data.workflows.map((w) => (
            <Button
              key={w.id}
              variant={current === w.id ? 'secondary' : 'ghost'}
              className="justify-start"
              onClick={() => setSelected(w.id!)}
            >
              {w.id}
              {isWorkflowDirty(data, drafts, w.id!) ? ' *' : ''}
              {w.parseError !== undefined ? ' (error)' : ''}
            </Button>
          ))}
        </nav>

        <div className="min-w-0">
          {current === 'config' && (
            <ConfigForm
              file={data.config}
              model={drafts.config}
              onChange={(m: ConfigModel) => setDrafts({ ...drafts, config: m })}
            />
          )}
          {workflowFile && (
            <WorkflowEditor
              key={workflowFile.id}
              file={workflowFile}
              draft={drafts.workflows[workflowFile.id!]}
              dirty={isWorkflowDirty(data, drafts, workflowFile.id!)}
              agents={data.agents}
              existingIds={workflowIds}
              readOnly={readOnly}
              rules={(id) => ({ text: drafts.rules[id] ?? '', exists: !!findRules(data, id) })}
              onChange={(d) => updateWorkflow(workflowFile.id!, d)}
              onRulesChange={updateRules}
              onStructureChange={(id) => setSelected(id ?? 'config')}
            />
          )}
        </div>
      </div>

      {entries.length > 0 && (
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
                      <pre className="max-h-96 overflow-auto font-mono text-xs">{f.text}</pre>
                    </TabsContent>
                  </Tabs>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </CardContent>
        </Card>
      )}

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
