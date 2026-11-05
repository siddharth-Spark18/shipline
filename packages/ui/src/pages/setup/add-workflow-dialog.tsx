import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { ChangesView } from '@/components/changes-view';
import { FileNotes, previewChanges } from '@/pages/setup/save-dialog';
import { ApiError, api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { AddWorkflowRequest, SetupData } from '@/lib/types';

/**
 * Setup > Add shipped workflow. Picks one of the workflows the repo doesn't have, previews the files it adds
 * (the workflow, its missing rules and missing agents), then writes them through POST /api/setup/add-workflow.
 */
export function AddWorkflowDialog({
  open,
  onOpenChange,
  data,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: SetupData;
  onAdded: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [id, setId] = useState<string>('');
  const [ui, setUi] = useState<boolean | null>(null);
  const uiValue = ui ?? data.uiDetected;
  const chosen = id || data.addableWorkflows[0]?.id || '';

  const request = (paths: string[] = []): AddWorkflowRequest => ({
    id: chosen,
    ui: uiValue,
    baseVersionHash: data.versionHash,
    // null = must not exist yet; the save refuses if what it would write differs from this preview.
    baseHashes: Object.fromEntries(paths.map((p) => [p, null])),
  });

  const preview = useMutation({ mutationFn: () => api.addWorkflowPreview(request()) });
  const apply = useMutation({
    mutationFn: () => api.addWorkflow(request(preview.data?.paths ?? [])),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
      toast.success(`Added the ${chosen} workflow. Commit the new files so teammates get it.`);
      onAdded(chosen);
      close(false);
    },
  });

  const close = (o: boolean) => {
    if (!o) {
      preview.reset();
      apply.reset();
      setId('');
      setUi(null);
    }
    onOpenChange(o);
  };

  const conflict = apply.error instanceof ApiError && apply.error.status === 409;
  const stale = apply.error instanceof ApiError && apply.error.code === 'changed';
  const reset = () => {
    preview.reset();
    apply.reset();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Add shipped workflow</DialogTitle>
          <DialogDescription>
            Adds a workflow Shipline ships, with the rules for its stages and the agents it needs.
            Nothing is written until you confirm.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="flex flex-col gap-4 pr-3">
            {data.addableWorkflows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This repo already has every workflow Shipline ships.
              </p>
            ) : (
              <>
                <RadioGroup
                  value={chosen}
                  onValueChange={(v) => {
                    setId(v);
                    reset();
                  }}
                >
                  {data.addableWorkflows.map((w) => (
                    <div key={w.id} className="flex items-start gap-2">
                      <RadioGroupItem value={w.id} id={`add-wf-${w.id}`} className="mt-0.5" />
                      <Label htmlFor={`add-wf-${w.id}`} className="flex flex-col items-start gap-0">
                        <span>{w.name}</span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {w.description}
                        </span>
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
                <div className="flex items-center gap-3">
                  <Switch
                    id="add-wf-ui"
                    checked={uiValue}
                    onCheckedChange={(v) => {
                      setUi(v);
                      reset();
                    }}
                  />
                  <Label htmlFor="add-wf-ui">Does this repo have a UI?</Label>
                  <span className="text-xs text-muted-foreground">
                    (detected: {data.uiDetected ? 'yes' : 'no'}) Without one, UI-only stages such as
                    wireframes are left out.
                  </span>
                </div>
              </>
            )}
            {preview.error && <p className="text-sm text-destructive">{preview.error.message}</p>}
            {preview.data && <FileNotes files={preview.data.files} />}
            {preview.data && (
              <ChangesView changes={previewChanges(preview.data.files)} defaultExpanded />
            )}
            {conflict && (
              <Alert variant="destructive">
                <AlertTitle>{stale ? 'Files changed on disk' : 'Already there'}</AlertTitle>
                <AlertDescription>
                  {stale
                    ? 'A file changed outside this page, so nothing was written. Preview again.'
                    : apply.error?.message}
                </AlertDescription>
              </Alert>
            )}
            {apply.error && !conflict && (
              <Alert variant="destructive">
                <AlertTitle>Add failed</AlertTitle>
                <AlertDescription>{apply.error.message}</AlertDescription>
              </Alert>
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          {preview.data && !conflict ? (
            <Button disabled={apply.isPending} onClick={() => apply.mutate()}>
              {apply.isPending ? 'Adding...' : 'Add workflow'}
            </Button>
          ) : (
            <Button
              disabled={!chosen || preview.isPending}
              onClick={() => {
                apply.reset();
                preview.mutate();
              }}
            >
              {preview.isPending ? 'Preparing preview...' : 'Preview'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
