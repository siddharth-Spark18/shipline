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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ChangesView } from '@/components/changes-view';
import { FileNotes, isError, previewChanges } from '@/pages/setup/save-dialog';
import { ApiError, api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { CiChange, CiMissingBlock, SetupData } from '@/lib/types';

const CONFIG_PATH = '.shipline/config.yml';
const WORKFLOW_PATH = '.github/workflows/shipline.yml';
const SKIP_LABEL_MAX = 50;

const MODES: { value: CiMissingBlock; label: string }[] = [
  { value: 'fail-unless-label', label: 'Fail, unless the PR has the skip label' },
  { value: 'warn', label: 'Pass with a warning' },
  { value: 'fail', label: 'Always fail' },
];

/**
 * Setup > CI check. Adds or removes .github/workflows/shipline.yml and edits config.yml's `ci:`
 * through its own preview-and-confirm save (POST /api/setup/ci), like the agents.
 */
export function CiCheck({
  data,
  readOnly,
  hasOtherEdits,
  onReload,
}: {
  data: SetupData;
  readOnly: boolean;
  /** The page has unsaved edits that a reload after saving would discard. */
  hasOtherEdits: boolean;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const { ci } = data;
  const [install, setInstall] = useState(ci.installed);
  const [mode, setMode] = useState<CiMissingBlock>(ci.missing_block);
  const [label, setLabel] = useState(ci.skip_label);
  const [open, setOpen] = useState(false);

  const labelError = !label.trim()
    ? 'A label name is required'
    : label.length > SKIP_LABEL_MAX
      ? `At most ${SKIP_LABEL_MAX} characters`
      : null;
  const dirty = install !== ci.installed || mode !== ci.missing_block || label !== ci.skip_label;

  const change: CiChange = {
    install,
    missing_block: mode,
    skip_label: label,
    baseVersionHash: data.versionHash,
    baseHashes: {
      [CONFIG_PATH]: data.config.hash ?? null,
      [WORKFLOW_PATH]: ci.workflowHash,
    },
  };

  const preview = useMutation({
    mutationFn: (req: CiChange) => api.ciPreview(req),
    onSuccess: () => setOpen(true),
  });
  const apply = useMutation({
    mutationFn: (req: CiChange) => api.ciApply(req),
    onSuccess: async () => {
      setOpen(false);
      toast.success('Saved. Commit these files so teammates get the change.');
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
    },
  });

  const previewData = preview.data;
  const applyError = apply.error;
  const conflict = applyError instanceof ApiError && applyError.status === 409;
  const previewHasErrors = !!previewData?.files.some((f) => f.errors.some(isError));
  const nothingToWrite = !!previewData && previewData.files.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-sm font-medium">CI check</h2>

      <section className="flex flex-col gap-4" aria-labelledby="ci-heading">
        <div>
          <h3 id="ci-heading" className="text-sm font-medium">
            Pull request check
          </h3>
          <p className="text-xs text-muted-foreground">
            A GitHub Actions job that reads the Shipline summary in the PR description (Claude
            pastes it from <code className="font-mono">stage.mjs pr-summary</code>) and fails the PR
            when a block stage isn't done or a confirmed stage has no answer.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Switch
            id="ci-install"
            checked={install}
            disabled={readOnly}
            onCheckedChange={setInstall}
          />
          <Label htmlFor="ci-install">Install .github/workflows/shipline.yml</Label>
          <span className="ml-auto text-xs text-muted-foreground">
            {install === ci.installed
              ? ci.installed
                ? 'Installed'
                : 'Not installed'
              : install
                ? 'Will be added'
                : 'Will be removed'}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ci-missing-block">When the PR has no Shipline summary</Label>
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as CiMissingBlock)}
            disabled={readOnly}
          >
            <SelectTrigger id="ci-missing-block" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ci-skip-label">Skip label</Label>
          <Input
            id="ci-skip-label"
            value={label}
            disabled={readOnly}
            aria-invalid={labelError !== null}
            onChange={(e) => setLabel(e.target.value)}
          />
          {labelError ? (
            <p className="text-xs text-destructive">{labelError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              A PR with this label passes without a summary (only with the first option above).
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!dirty || !!labelError || readOnly || preview.isPending}
            onClick={() => preview.mutate(change)}
          >
            {preview.isPending ? 'Preparing preview...' : 'Review and save CI check'}
          </Button>
          {dirty && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setInstall(ci.installed);
                setMode(ci.missing_block);
                setLabel(ci.skip_label);
              }}
            >
              Undo
            </Button>
          )}
          {dirty && hasOtherEdits && (
            <span className="text-xs text-muted-foreground">
              Saving reloads the files from disk and discards your other unsaved edits on this page.
            </span>
          )}
        </div>
        {preview.error && !open && (
          <p className="text-sm text-destructive">{preview.error.message}</p>
        )}
      </section>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            apply.reset();
            preview.reset();
          }
        }}
      >
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Review CI check changes</DialogTitle>
            <DialogDescription>
              Nothing is written until you save. Shipline never commits for you.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <div className="flex flex-col gap-4 pr-3">
              {previewData && <FileNotes files={previewData.files} />}
              {previewData && (
                <ChangesView changes={previewChanges(previewData.files)} defaultExpanded />
              )}
              {nothingToWrite && <p className="text-sm text-muted-foreground">No file changes.</p>}
              {conflict && (
                <Alert variant="destructive">
                  <AlertTitle>Files changed on disk</AlertTitle>
                  <AlertDescription>
                    config.yml, the workflow file or VERSION was changed outside this page, so
                    nothing was written. Reload to see the current files; your edits on this page
                    will be discarded.
                    <div className="mt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setOpen(false);
                          apply.reset();
                          onReload();
                        }}
                      >
                        Reload from disk
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              {applyError && !conflict && (
                <Alert variant="destructive">
                  <AlertTitle>Save failed</AlertTitle>
                  <AlertDescription>{applyError.message}</AlertDescription>
                </Alert>
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!previewData || previewHasErrors || apply.isPending || readOnly}
              onClick={() => apply.mutate(change)}
            >
              {apply.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
