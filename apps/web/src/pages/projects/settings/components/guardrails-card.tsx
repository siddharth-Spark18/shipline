import { toast } from 'sonner';
import { EDIT_POLICIES, EditPolicy, ROLES, ROLE_LABELS, Role } from '@shipline/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import RulesEditor from '@/components/guardrails/rules-editor';
import { errorMessage } from '@/lib/api';
import {
  useCreateProjectRule,
  useDeleteProjectRule,
  useProjectGuardrails,
  useUpdateProject,
  useUpdateProjectRule,
} from '@/services/projects/projects.hooks';
import { ProjectDetail } from '@/services/projects/projects.types';

/**
 * Guardrails for this project: project rules, per-role rules (each role tab also holds that role's
 * code-edit default, which replaces the old "code-edit policy per role" form), and the org baseline
 * read-only. Every tool call is checked against all levels; the strictest wins and lower levels can only tighten.
 */
export default function GuardrailsCard({ project, readOnly }: { project: ProjectDetail; readOnly: boolean }) {
  const { data, isPending } = useProjectGuardrails(project.id);
  const create = useCreateProjectRule(project.id);
  const update = useUpdateProjectRule(project.id);
  const remove = useDeleteProjectRule(project.id);
  const updateProject = useUpdateProject(project.id);

  const setEditDefault = (role: Role, value: string) =>
    updateProject.mutate(
      { editPolicy: { ...project.editPolicy, [role]: value as EditPolicy } },
      { onSuccess: () => toast.success(`${ROLE_LABELS[role]} code-edit default saved`), onError: (err) => toast.error(errorMessage(err)) },
    );

  const editorFor = (scope: 'PROJECT' | 'ROLE', role: Role | undefined, rules: NonNullable<typeof data>['project']) => (
    <RulesEditor
      rules={rules}
      readOnly={readOnly}
      addTitle={role ? `Add ${ROLE_LABELS[role]} rule` : 'Add project rule'}
      emptyMessage={role ? `No ${ROLE_LABELS[role]} rules yet.` : 'No project rules yet.'}
      onCreate={async (rule) => {
        await create.mutateAsync({ scope, role, rule });
        toast.success('Rule added');
      }}
      onUpdate={async (existing, _i, rule) => {
        await update.mutateAsync({ ruleId: existing.id, rule });
        toast.success('Rule saved');
      }}
      onDelete={async (existing) => {
        await remove.mutateAsync(existing.id);
        toast.success('Rule deleted');
      }}
    />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Guardrails</CardTitle>
        <CardDescription>
          Path, Bash command and tool rules, checked server-side on every tool call together with the org baseline and the current stage's rules.
          The strictest wins (deny, then ask, then allow) and the denial names the rule and its level. A person with several roles gets the most
          permissive role. Changes apply to the next tool call.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending || !data ? (
          <Skeleton className="h-32" />
        ) : (
          <Tabs defaultValue="project">
            <TabsList className="flex-wrap">
              <TabsTrigger value="project">Project</TabsTrigger>
              {ROLES.map((r) => (
                <TabsTrigger key={r} value={r}>
                  {ROLE_LABELS[r]}
                </TabsTrigger>
              ))}
              <TabsTrigger value="org">Inherited from org</TabsTrigger>
            </TabsList>
            <TabsContent value="project">{editorFor('PROJECT', undefined, data.project)}</TabsContent>
            {ROLES.map((role) => (
              <TabsContent key={role} value={role} className="space-y-4">
                <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">Code-edit default for {ROLE_LABELS[role]}</p>
                    <p className="text-xs text-muted-foreground">
                      What this role may do with code-editing tools (and file-changing shell commands) when no rule says otherwise. The stage's own limits still apply.
                    </p>
                  </div>
                  <Select value={project.editPolicy[role]} disabled={readOnly || updateProject.isPending} onValueChange={(v) => setEditDefault(role, v)}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EDIT_POLICIES.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {editorFor('ROLE', role, data.roles[role])}
              </TabsContent>
            ))}
            <TabsContent value="org" className="space-y-2">
              <p className="text-xs text-muted-foreground">Set by org admins under Admin. They apply to this project and cannot be loosened here.</p>
              <RulesEditor rules={data.inherited} readOnly emptyMessage="The org has no baseline rules." />
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}
