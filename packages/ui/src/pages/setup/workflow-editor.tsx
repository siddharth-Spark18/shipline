import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, Trash2Icon } from 'lucide-react';
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
import { OtherFields } from '@/pages/setup/other-fields';
import { StageList } from '@/pages/setup/stage-list';
import { ID_RE, setOptional, type WorkflowDraft } from '@/pages/setup/draft';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { SetupFile, WorkflowModel } from '@/lib/types';

const WORKFLOW_KEYS = ['id', 'name', 'description', 'branch_type', 'stages'];

export interface WorkflowEditorProps {
  file: SetupFile<WorkflowModel>;
  draft: WorkflowDraft | undefined;
  dirty: boolean;
  agents: string[];
  existingIds: string[];
  /** The repo is newer than this UI: nothing can be written. */
  readOnly: boolean;
  rules: (stageId: string) => { text: string; exists: boolean };
  onChange: (draft: WorkflowDraft) => void;
  onRulesChange: (stageId: string, text: string) => void;
  /** Called after a copy or delete, with the id to show next. */
  onStructureChange: (selectId: string | null) => void;
}

export function WorkflowEditor({
  file,
  draft,
  dirty,
  agents,
  existingIds,
  readOnly,
  rules,
  onChange,
  onRulesChange,
  onStructureChange,
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
      onStructureChange(id);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.workflowAction({ action: 'delete', id: file.id! }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
      setDeleteOpen(false);
      toast.success(`Deleted workflow ${file.id}. Commit the change so teammates get it.`);
      onStructureChange(null);
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-mono text-sm">workflows/{file.id}.yml</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={readOnly} onClick={() => setCopyOpen(true)}>
            <CopyIcon /> Copy as new workflow
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2Icon /> Delete
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
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

      {dirty && (
        <p className="text-xs text-muted-foreground">
          Unsaved changes. Open tasks keep the stage list they started with; the save dialog lists
          the ones that differ from your new list.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Stages</h3>
        <StageList
          draft={draft}
          agents={agents}
          rules={rules}
          onChange={onChange}
          onRulesChange={onRulesChange}
        />
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
