import { useState } from 'react';
import { toast } from 'sonner';
import { ProjectTemplateDTO } from '@shipline/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { useProjectTemplates, useSaveProjectTemplates } from '@/services/projects/projects.hooks';

/**
 * Which of the org's workflow templates this project offers for new chats, and which one the new-chat
 * screen preselects. Disabling a template does not touch chats already running on it.
 */
export default function TemplatesCard({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const { data, isPending } = useProjectTemplates(projectId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workflow templates</CardTitle>
        <CardDescription>
          Templates are defined by org admins. Tick the ones this project offers; the default is preselected for new chats. Chats already
          running keep their template even if you disable it here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className="h-24" />
        ) : data && data.length > 0 ? (
          // key: the form seeds its state from the saved choice once; remount after a save.
          <TemplatesForm key={JSON.stringify(data.map((t) => [t.templateId, t.enabled, t.isDefault]))} projectId={projectId} templates={data} readOnly={readOnly} />
        ) : (
          <p className="text-sm text-muted-foreground">No templates exist yet. An org admin creates them under Admin.</p>
        )}
      </CardContent>
    </Card>
  );
}

function TemplatesForm({ projectId, templates, readOnly }: { projectId: string; templates: ProjectTemplateDTO[]; readOnly: boolean }) {
  const save = useSaveProjectTemplates(projectId);
  const [enabled, setEnabled] = useState<Set<string>>(new Set(templates.filter((t) => t.enabled).map((t) => t.templateId)));
  const [defaultId, setDefaultId] = useState<string | null>(templates.find((t) => t.isDefault)?.templateId ?? null);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(enabled);
    if (on) next.add(id);
    else next.delete(id);
    setEnabled(next);
    if (!on && defaultId === id) setDefaultId([...next][0] ?? null);
    if (on && !defaultId) setDefaultId(id);
  };

  const canSave = enabled.size > 0 && !!defaultId && enabled.has(defaultId);
  const submit = () =>
    save.mutate(
      { enabledTemplateIds: [...enabled], defaultTemplateId: defaultId },
      { onSuccess: () => toast.success('Templates saved'), onError: (err) => toast.error(errorMessage(err)) },
    );

  return (
    <div className="space-y-4">
      <RadioGroup value={defaultId ?? ''} onValueChange={setDefaultId} disabled={readOnly}>
        <ul className="divide-y rounded-lg border">
          {templates.map((t) => (
            <li key={t.templateId} className="flex items-start gap-3 p-3 text-sm">
              <Checkbox
                id={`tpl-${t.templateId}`}
                className="mt-0.5"
                checked={enabled.has(t.templateId)}
                disabled={readOnly}
                onCheckedChange={(v) => toggle(t.templateId, v === true)}
              />
              <label htmlFor={`tpl-${t.templateId}`} className="min-w-0 flex-1">
                <span className="font-medium">{t.name}</span> <span className="text-xs text-muted-foreground">v{t.latestVersion}</span>
                {t.description && <span className="block text-xs text-muted-foreground">{t.description}</span>}
                <span className="block text-xs text-muted-foreground">{t.stages.map((s) => `${s.name}${s.optional ? '*' : ''}`).join(' > ')}</span>
              </label>
              <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <RadioGroupItem value={t.templateId} disabled={readOnly || !enabled.has(t.templateId)} />
                Default
              </label>
            </li>
          ))}
        </ul>
      </RadioGroup>
      {!canSave && !readOnly && <p className="text-xs text-destructive">Enable at least one template and pick one of the enabled ones as the default.</p>}
      {!readOnly && (
        <Button onClick={submit} disabled={!canSave || save.isPending}>
          Save templates
        </Button>
      )}
    </div>
  );
}
