import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import RulesEditor from '@/components/guardrails/rules-editor';
import { useDeleteOrgRule, useOrgRules, useSaveOrgRule } from '@/services/admin/admin.hooks';

/** The org baseline: rules that apply to every chat in every project. Projects, roles and stages can only tighten them. */
export default function OrgGuardrailsTab() {
  const { data, isPending } = useOrgRules();
  const save = useSaveOrgRule();
  const remove = useDeleteOrgRule();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Org guardrails</CardTitle>
        <CardDescription>
          Path, Bash command and tool rules for every project. A denial names the rule ("Org rule: ..."). Changes apply to the next
          tool call and are written to the audit log.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className="h-24" />
        ) : (
          <RulesEditor
            rules={data ?? []}
            addTitle="Add org rule"
            emptyMessage="No org rules yet. For example: deny read and edit of **/.env*."
            onCreate={async (rule) => {
              await save.mutateAsync({ id: null, rule });
              toast.success('Rule added');
            }}
            onUpdate={async (existing, _i, rule) => {
              await save.mutateAsync({ id: existing.id, rule });
              toast.success('Rule saved');
            }}
            onDelete={async (existing) => {
              await remove.mutateAsync(existing.id);
              toast.success('Rule deleted');
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
