import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Loader2, Plus, Save } from 'lucide-react';
import { toast } from 'sonner';
import {
  BUILT_IN_STAGE_TYPES,
  STAGE_TYPES,
  STAGE_TYPE_LABELS,
  StageType,
  customAgentRef,
  pluginAgentRef,
  validateTemplate,
} from '@shipline/shared';
import { useAuth } from '@/contexts/auth-context';
import PageContainer from '@/components/layout/page-container';
import EmptyState from '@/components/shared/empty-state';
import PageLoading from '@/components/shared/page-loading';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { errorCode, errorMessage } from '@/lib/api';
import { useAgents, useCreateTemplate, useSaveTemplate, useTemplateDetail } from '@/services/admin/admin.hooks';
import { AdminService } from '@/services/admin/admin.service';
import { TemplateDetail, adminKeys } from '@/services/admin/admin.types';
import StageList from './components/stage-list';
import StageSheet from './components/stage-sheet';
import VersionHistory from './components/version-history';
import { EditorDraft, EditorStage, blankDraft, newStage, stagesFromDefs, toTemplateDraft } from './editor-state';
import { downloadTemplate } from './export-file';

/** Route `/admin/templates/:templateId`; `new` creates a template. */
export default function TemplateEditorPage() {
  const { user } = useAuth();
  const { templateId = '' } = useParams();
  const isNew = templateId === 'new';
  const detail = useTemplateDetail(templateId, !isNew && !!user?.isAdmin);

  if (!user?.isAdmin) {
    return (
      <PageContainer>
        <EmptyState message="Only admins can open this page." />
      </PageContainer>
    );
  }
  if (isNew) return <Editor key="new" detail={null} />;
  if (detail.isPending) {
    return (
      <PageContainer>
        <PageLoading />
      </PageContainer>
    );
  }
  if (!detail.data) {
    return (
      <PageContainer>
        <EmptyState message={detail.error ? errorMessage(detail.error) : 'Template not found.'} />
      </PageContainer>
    );
  }
  // Remount on a new version so the draft always starts from what was saved.
  return <Editor key={`${detail.data.id}-v${detail.data.latest.version}`} detail={detail.data} />;
}

function Editor({ detail }: { detail: TemplateDetail | null }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const agents = useAgents();
  const create = useCreateTemplate();
  const save = useSaveTemplate(detail?.id ?? '');

  const initial = useMemo<EditorDraft>(
    () => (detail ? { name: detail.name, description: detail.description, stages: stagesFromDefs(detail.latest.stages) } : blankDraft()),
    [detail],
  );
  const [draft, setDraft] = useState<EditorDraft>(initial);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const plugin = agents.data?.plugin ?? [];
  const custom = agents.data?.custom ?? [];
  const agentName = (ref: string): string =>
    plugin.find((a) => pluginAgentRef(a.name) === ref)?.name ?? custom.find((a) => customAgentRef(a.id) === ref)?.name ?? 'missing agent';

  const templateDraft = useMemo(() => toTemplateDraft(draft), [draft]);
  const issues = useMemo(
    () => validateTemplate(templateDraft, agents.data ? { knownCustomAgentIds: new Set(custom.map((a) => a.id)) } : {}),
    [templateDraft, agents.data, custom],
  );
  const dirty = JSON.stringify(templateDraft) !== JSON.stringify(toTemplateDraft(initial));
  const templateIssues = issues.filter((i) => i.stageIndex === null);
  const editing = draft.stages.find((s) => s.uid === editingUid) ?? null;
  const takenTypes = new Set<StageType>(draft.stages.filter((s) => s.uid !== editingUid).map((s) => s.type));
  const usedTypes = new Set<StageType>(draft.stages.map((s) => s.type));

  const patchStage = (uid: string, patch: Partial<EditorStage>) =>
    setDraft((d) => ({ ...d, stages: d.stages.map((s) => (s.uid === uid ? { ...s, ...patch } : s)) }));

  const addStage = (type: StageType) => {
    const stage = newStage(type);
    setDraft((d) => ({ ...d, stages: [...d.stages, stage] }));
    setEditingUid(stage.uid);
  };

  const submit = async () => {
    try {
      if (!detail) {
        const created = await create.mutateAsync(templateDraft);
        toast.success('Template created');
        navigate(`/admin/templates/${created.id}`, { replace: true });
        return;
      }
      const saved = await save.mutateAsync({ baseVersion: detail.latest.version, draft: templateDraft });
      qc.setQueryData(adminKeys.template(detail.id), saved);
      toast.success(`Saved as version ${saved.latest.version}`);
    } catch (err) {
      if (errorCode(err) === 'STALE_TEMPLATE') setStale(true);
      toast.error(errorMessage(err));
    }
  };

  const reload = async () => {
    if (!detail) return;
    const fresh = await AdminService.getTemplate(detail.id);
    qc.setQueryData(adminKeys.template(detail.id), fresh);
    setStale(false);
  };

  const pending = create.isPending || save.isPending;
  return (
    <PageContainer>
      <div>
        <Link to="/admin?tab=templates" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="size-3" /> Back to workflow templates
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              {detail ? detail.name : 'New template'}
              {detail && <Badge variant="secondary">v{detail.latest.version}</Badge>}
              {detail?.archived && <Badge variant="outline">archived</Badge>}
            </h1>
            <p className="text-sm text-muted-foreground">
              {detail
                ? `Saving creates version ${detail.latest.version + 1}. ${detail.chatCount} chat${detail.chatCount === 1 ? '' : 's'} used this template; each stays on its version.`
                : 'Saving creates version 1.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {detail && (
              <>
                <VersionHistory
                  templateId={detail.id}
                  versions={detail.versions}
                  latestVersion={detail.latest.version}
                  onLoadStages={(stages) => {
                    setDraft((d) => ({ ...d, stages: stagesFromDefs(stages) }));
                    toast.message('Stages loaded into the editor. Save to create a new version.');
                  }}
                />
                <Button variant="outline" onClick={() => void downloadTemplate(detail.id, detail.name).catch((err) => toast.error(errorMessage(err)))}>
                  <Download /> Export
                </Button>
              </>
            )}
            <Button onClick={() => void submit()} disabled={pending || issues.length > 0 || (!!detail && (!dirty || detail.archived))}>
              {pending ? <Loader2 className="animate-spin" /> : <Save />} {detail ? 'Save new version' : 'Create template'}
            </Button>
          </div>
        </div>
      </div>

      {stale && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>Someone saved a newer version while you were editing. Reload to see it, then apply your changes again.</span>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Reload
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {detail?.archived && (
        <Alert>
          <AlertDescription>This template is archived. Restore it from the template list before editing.</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="template-name">Name</Label>
            <Input id="template-name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Backend feature" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-description">Description</Label>
            <Textarea id="template-description" rows={2} value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Stages</CardTitle>
            <CardDescription>
              Drag to reorder; open a stage for its instructions, agent, tool policy and rules. Raise PR is not required: a template without it ends when its last stage completes, and no gate applies.
            </CardDescription>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Plus /> Add stage
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {STAGE_TYPES.filter((t) => t !== 'custom').map((t) => (
                <DropdownMenuItem key={t} disabled={BUILT_IN_STAGE_TYPES.includes(t) && usedTypes.has(t)} onSelect={() => addStage(t)}>
                  {STAGE_TYPE_LABELS[t]}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => addStage('custom')}>Custom stage</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardHeader>
        <CardContent className="space-y-3">
          {templateIssues.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {templateIssues.map((i, n) => (
                    <li key={n}>{i.message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {draft.stages.length === 0 ? (
            <EmptyState message="No stages. Add one." />
          ) : (
            <StageList stages={draft.stages} issues={issues} agentName={agentName} onChange={(stages) => setDraft((d) => ({ ...d, stages }))} onEdit={setEditingUid} />
          )}
          {issues.length > 0 && <p className="text-xs text-destructive">Fix the {issues.length} problem{issues.length === 1 ? '' : 's'} above to save.</p>}
        </CardContent>
      </Card>

      <StageSheet
        stage={editing}
        takenTypes={takenTypes}
        pluginAgents={plugin}
        customAgents={custom}
        readOnly={detail?.archived}
        onChange={(patch) => editingUid && patchStage(editingUid, patch)}
        onClose={() => setEditingUid(null)}
      />
    </PageContainer>
  );
}
