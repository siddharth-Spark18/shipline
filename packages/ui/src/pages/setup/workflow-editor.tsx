import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon, CopyIcon, PlusIcon, SparklesIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { OtherFields } from '@/pages/setup/other-fields';
import { StageList } from '@/pages/setup/stage-list';
import { ID_RE, setOptional, type WorkflowDraft } from '@/pages/setup/draft';
import { api } from '@/lib/api';
import { stageHash, workflowHash, workflowsHash } from '@/lib/routes';
import { needsAnswer } from '@/lib/confirmations';
import { queryKeys } from '@/lib/events';
import type { SetupFile, WorkflowModel } from '@/lib/types';

const WORKFLOW_KEYS = ['id', 'name', 'description', 'branch_type', 'stages'];

export interface WorkflowEditorProps {
  file: SetupFile<WorkflowModel>;
  draft: WorkflowDraft | undefined;
  dirty: boolean;
  repoId: string;
  existingIds: string[];
  /** The other workflows, for the chip row at the bottom. */
  otherWorkflows: { id: string; name: string }[];
  /** The `confirmations` value in the drafted config (the saved one when the config isn't being edited). */
  confirmations?: 'standard' | 'light' | null;
  /** The repo is newer than this UI: nothing can be written. */
  readOnly: boolean;
  onChange: (draft: WorkflowDraft) => void;
  /** Go to another address (a hash). */
  navigate: (hash: string) => void;
  /** Starts a chat that drafts a change to this workflow. Undefined: the repo can't (upgrade it) or a chat is starting. */
  onChangeWithClaude?: () => void;
}

export function WorkflowEditor({
  file,
  draft,
  dirty,
  repoId,
  existingIds,
  otherWorkflows,
  confirmations,
  readOnly,
  onChange,
  navigate,
  onChangeWithClaude,
}: WorkflowEditorProps) {
  const queryClient = useQueryClient();
  const [copyOpen, setCopyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [newId, setNewId] = useState('');

  const copy = useMutation({
    mutationFn: (id: string) => api.workflowAction({ action: 'copy', from: file.id!, id }),
    onSuccess: async (_r, id) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
      setCopyOpen(false);
      setNewId('');
      toast.success(`Created workflow ${id}. Commit the new file so teammates get it.`);
      navigate(workflowHash(repoId, id));
    },
  });

  const remove = useMutation({
    mutationFn: () => api.workflowAction({ action: 'delete', id: file.id! }),
    onSuccess: async () => {
      // Leave first: once the files reload this workflow is gone, and its page would redirect with a "not found".
      navigate(workflowsHash(repoId));
      setDeleteOpen(false);
      toast.success(`Deleted workflow ${file.id}. Commit the change so teammates get it.`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
    },
  });

  if (file.parseError !== undefined) {
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertTitle>workflows/{file.id}.yml does not parse</AlertTitle>
          <AlertDescription>
            It is shown read-only. Fix it by hand, then reload.
            <br />
            {file.parseError}
          </AlertDescription>
        </Alert>
        <pre className="overflow-auto rounded-md border bg-muted p-3 font-mono text-xs">
          {file.raw}
        </pre>
      </div>
    );
  }
  if (!draft) return null;

  const model = draft.model;
  const setText = (key: string, value: string) => {
    const next = { ...model };
    setOptional(next, key, value);
    onChange({ ...draft, model: next });
  };

  const idError = !newId
    ? null
    : !ID_RE.test(newId)
      ? 'Use letters, digits, - and _ only'
      : existingIds.includes(newId)
        ? 'A workflow with this id already exists'
        : null;

  const branchTypeError =
    model.branch_type && !/^[A-Za-z0-9_-]*$/.test(model.branch_type)
      ? 'Use letters, digits, - and _ only'
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xl font-extrabold tracking-tight">{model.name || file.id}</h2>
          <p className="text-sm text-muted-foreground">
            {model.description || <span className="font-mono">workflows/{file.id}.yml</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {onChangeWithClaude && (
            <Button
              variant="outline"
              className="max-md:h-11"
              // The draft is made against the file on disk, so unsaved edits here would not be part of it.
              disabled={readOnly || dirty}
              title={dirty ? 'Save or discard your edits first' : undefined}
              onClick={onChangeWithClaude}
            >
              <SparklesIcon /> Change with Claude
            </Button>
          )}
          <Button
            variant="outline"
            className="max-md:h-11"
            disabled={readOnly}
            onClick={() => setCopyOpen(true)}
          >
            <CopyIcon /> Copy as new workflow
          </Button>
          <Button
            variant="outline"
            className="max-md:h-11"
            disabled={readOnly}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2Icon /> Delete
          </Button>
        </div>
      </div>

      <Collapsible className="rounded-xl border bg-card px-3 py-2">
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-1 text-sm font-medium">
          <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90" />
          Rename and details
          <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
            workflows/{file.id}.yml
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-4 pt-3 pb-1 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-id">Id</Label>
              <Input id="wf-id" className="font-mono" value={model.id} readOnly disabled />
              <p className="text-xs text-muted-foreground">Must equal the file name.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-name">Name</Label>
              <Input
                id="wf-name"
                value={model.name ?? ''}
                onChange={(e) => setText('name', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-description">Description</Label>
              <Input
                id="wf-description"
                value={model.description ?? ''}
                onChange={(e) => setText('description', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-branch-type">Branch type</Label>
              <Input
                id="wf-branch-type"
                className="font-mono"
                value={model.branch_type ?? ''}
                aria-invalid={branchTypeError ? true : undefined}
                onChange={(e) => setText('branch_type', e.target.value)}
              />
              {branchTypeError && <p className="text-xs text-destructive">{branchTypeError}</p>}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {dirty && (
        <p className="text-xs text-muted-foreground">
          Unsaved changes. Open tasks keep the stage list they started with; the save dialog lists
          the ones that differ from your new list.
        </p>
      )}

      {confirmations === 'light' &&
        !(model.stages ?? []).some((s) => needsAnswer(s, { confirmations: 'light' })) && (
          <p className="text-xs text-muted-foreground">
            In light mode this workflow never asks before advancing.
          </p>
        )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Stages</h3>
        <StageList
          draft={draft}
          onChange={onChange}
          onEdit={(n) => navigate(stageHash(repoId, file.id!, n))}
          onAdded={(n) => navigate(stageHash(repoId, file.id!, n))}
        />
      </div>

      <div className="flex flex-col gap-2 rounded-xl border bg-card p-3">
        <b className="text-sm">Other workflows</b>
        <div className="flex flex-wrap gap-2">
          {otherWorkflows.map((w) => (
            <Button
              key={w.id}
              variant="outline"
              className="rounded-full max-md:h-11"
              title={w.name}
              onClick={() => navigate(workflowHash(repoId, w.id))}
            >
              {w.id}
            </Button>
          ))}
          <Button
            variant="outline"
            className="rounded-full text-primary max-md:h-11"
            onClick={() => navigate(workflowsHash(repoId))}
          >
            <PlusIcon /> New / Add shipped
          </Button>
        </div>
      </div>

      <OtherFields value={model} known={WORKFLOW_KEYS} />

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy workflow {file.id}</DialogTitle>
            <DialogDescription>
              Creates a new workflow from the saved version of this one. Unsaved edits are not
              copied.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wf-new-id">New workflow id</Label>
            <Input
              id="wf-new-id"
              className="font-mono"
              value={newId}
              aria-invalid={idError ? true : undefined}
              onChange={(e) => setNewId(e.target.value)}
            />
            {idError && <p className="text-xs text-destructive">{idError}</p>}
            {copy.error && <p className="text-xs text-destructive">{copy.error.message}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newId || !!idError || copy.isPending}
              onClick={() => copy.mutate(newId)}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete workflow {file.id}?</DialogTitle>
            <DialogDescription>
              The file workflows/{file.id}.yml is removed. Its rules files stay in place. A workflow
              that an open task uses can't be deleted.
            </DialogDescription>
          </DialogHeader>
          {remove.error && <p className="text-sm text-destructive">{remove.error.message}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
