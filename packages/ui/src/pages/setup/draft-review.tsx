import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SaveDialog } from '@/pages/setup/save-dialog';
import { ApiError, api, getCurrentRepo } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import { useDrafts } from '@/lib/queries';
import type { ValidationIssue } from '@/lib/types';

const failMessage = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

/** Discards a workflow draft. The list updates from the `drafts` event; this refetches too, for a server that is not sending it. */
export function useDiscardDraft(onDone?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string) => api.discardDraft(workflowId),
    onSuccess: async () => {
      onDone?.();
      toast.success('Draft discarded.');
      await queryClient.invalidateQueries({ queryKey: queryKeys.drafts });
    },
    onError: (e) => toast.error(failMessage(e)),
  });
}

/**
 * The route #/setup/<repoId>/draft/<workflowId>: the save dialog fed by the draft's preview. Save writes through the same
 * pipeline as a Setup save (hashes, validation, impact on open tasks) and removes the draft.
 */
export function DraftReview({
  workflowId,
  readOnly,
  onClose,
}: {
  workflowId: string;
  readOnly: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const drafts = useDrafts();
  const info = drafts.data?.find((d) => d.workflowId === workflowId);
  const finished = useRef(false);

  const preview = useQuery({
    queryKey: ['draft-preview', getCurrentRepo(), workflowId, info?.createdAt ?? null],
    queryFn: () => api.previewDraft(workflowId),
    enabled: drafts.data !== undefined && info !== undefined,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  // A draft that is gone (discarded elsewhere, or a stale link).
  useEffect(() => {
    if (drafts.data && !info && !finished.current) {
      toast.info('That draft is no longer there.');
      onClose();
    }
  }, [drafts.data, info, onClose]);

  const done = async () => {
    finished.current = true;
    onClose();
    await queryClient.invalidateQueries({ queryKey: queryKeys.drafts });
  };

  const save = useMutation({
    mutationFn: (overwrite: boolean) => api.saveDraft(workflowId, overwrite),
    onSuccess: async () => {
      toast.success('Saved. Commit these files so teammates get the change.');
      await done();
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
  const discard = useDiscardDraft(() => {
    finished.current = true;
    onClose();
  });

  const saveError = save.error;
  const staleNow = saveError instanceof ApiError && saveError.code === 'draft-stale';
  const conflict = saveError instanceof ApiError && saveError.status === 409 && !staleNow;
  const issues: ValidationIssue[] =
    saveError instanceof ApiError &&
    saveError.code === 'invalid' &&
    Array.isArray(saveError.details)
      ? (saveError.details as ValidationIssue[])
      : [];
  const stale = Boolean(info?.stale || preview.data?.draft?.stale || staleNow);
  const staleRules = preview.data?.draft?.staleRules ?? info?.staleRules ?? [];

  return (
    <SaveDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      preview={preview.data}
      previewLoading={preview.isPending && preview.fetchStatus !== 'idle'}
      previewError={preview.error}
      readOnly={readOnly}
      saving={save.isPending}
      saveError={saveError}
      saveIssues={issues}
      conflict={conflict}
      removedStages={[]}
      onSave={() => save.mutate(false)}
      onReload={() => {
        save.reset();
        void preview.refetch();
      }}
      draft={{
        stale,
        staleRules,
        onOverwrite: () => save.mutate(true),
        onDiscard: () => discard.mutate(workflowId),
        discarding: discard.isPending,
      }}
    />
  );
}
