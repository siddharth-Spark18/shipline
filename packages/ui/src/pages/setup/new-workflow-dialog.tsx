import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
import { ApiError, api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import { ID_RE } from '@/pages/setup/draft';

/** Asks for an id and a name, creates a blank workflow with one `implement` stage, then selects it. */
export function NewWorkflowDialog({
  open,
  onOpenChange,
  existingIds,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: string[];
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [id, setId] = useState('');
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => api.createWorkflow(id, name.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
      toast.success(`Created workflow ${id}. Commit the new file so teammates get it.`);
      onCreated(id);
      onOpenChange(false);
    },
  });

  const idError = !id
    ? null
    : !ID_RE.test(id)
      ? 'Use letters, digits, - and _ only'
      : existingIds.includes(id)
        ? 'A workflow with this id already exists'
        : null;
  // A 409 `exists` from the server (someone else created it meanwhile) is shown on the id field too.
  const serverError =
    create.error instanceof ApiError && create.error.code === 'exists'
      ? 'A workflow with this id already exists'
      : (create.error?.message ?? null);

  const change = (setter: (v: string) => void) => (v: string) => {
    create.reset();
    setter(v);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          create.reset();
          setId('');
          setName('');
        }
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>
            Creates workflows/&lt;id&gt;.yml with one stage, <code>implement</code>, that only
            guides. Add stages and rules after it is created.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wf-create-id">Id</Label>
            <Input
              id="wf-create-id"
              className="font-mono"
              value={id}
              autoFocus
              aria-invalid={idError || serverError ? true : undefined}
              onChange={(e) => change(setId)(e.target.value)}
            />
            {(idError ?? serverError) && (
              <p className="text-xs text-destructive">{idError ?? serverError}</p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wf-create-name">Name</Label>
            <Input
              id="wf-create-name"
              value={name}
              onChange={(e) => change(setName)(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!id || !name.trim() || !!idError || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
