import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { GuardrailRuleInput, RULE_KIND_LABELS } from '@shipline/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import EmptyState from '@/components/shared/empty-state';
import { errorMessage } from '@/lib/api';
import RuleFormDialog from './rule-form-dialog';

const EFFECT_VARIANT = { deny: 'destructive', ask: 'secondary', allow: 'outline' } as const;

interface RulesEditorProps<T extends GuardrailRuleInput> {
  rules: T[];
  /** Hides add, edit and delete (the inherited-from-org view, or a person who cannot edit). */
  readOnly?: boolean;
  emptyMessage?: string;
  /** What the "add" dialog is titled, e.g. "Add org rule". */
  addTitle?: string;
  onCreate?: (rule: GuardrailRuleInput) => Promise<unknown> | void;
  onUpdate?: (rule: T, index: number, input: GuardrailRuleInput) => Promise<unknown> | void;
  onDelete?: (rule: T, index: number) => Promise<unknown> | void;
}

/**
 * A rules table (kind, pattern, action, effect, reason) with add, edit and delete. The persistence is
 * the caller's: org, project and role rules call the API; a stage's rules are part of the template draft.
 */
export default function RulesEditor<T extends GuardrailRuleInput>({
  rules,
  readOnly,
  emptyMessage = 'No rules yet.',
  addTitle = 'Add rule',
  onCreate,
  onUpdate,
  onDelete,
}: RulesEditorProps<T>) {
  const [dialog, setDialog] = useState<{ index: number | null } | null>(null);
  const editing = dialog && dialog.index !== null ? rules[dialog.index] : undefined;

  const remove = async (rule: T, index: number) => {
    try {
      await onDelete?.(rule, index);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-3">
      {rules.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Pattern</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Effect</TableHead>
              <TableHead>Reason</TableHead>
              {!readOnly && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule, i) => (
              <TableRow key={'id' in rule ? String((rule as { id: unknown }).id) : i}>
                <TableCell>{RULE_KIND_LABELS[rule.kind]}</TableCell>
                <TableCell>
                  <code className="text-xs break-all">{rule.pattern}</code>
                </TableCell>
                <TableCell>{rule.kind === 'path' ? rule.actions.join(' + ') : <span className="text-muted-foreground">-</span>}</TableCell>
                <TableCell>
                  <Badge variant={EFFECT_VARIANT[rule.effect]}>{rule.effect}</Badge>
                </TableCell>
                <TableCell className="max-w-64 whitespace-normal">{rule.reason}</TableCell>
                {!readOnly && (
                  <TableCell className="text-right whitespace-nowrap">
                    <Button size="icon-xs" variant="ghost" aria-label="Edit rule" onClick={() => setDialog({ index: i })}>
                      <Pencil />
                    </Button>
                    <Button size="icon-xs" variant="ghost" aria-label="Delete rule" onClick={() => void remove(rule, i)}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {!readOnly && onCreate && (
        <Button size="sm" variant="outline" onClick={() => setDialog({ index: null })}>
          <Plus /> Add rule
        </Button>
      )}
      <RuleFormDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        initial={editing}
        title={editing ? 'Edit rule' : addTitle}
        onSubmit={(input) => (dialog && dialog.index !== null ? onUpdate?.(rules[dialog.index], dialog.index, input) : onCreate?.(input))}
      />
    </div>
  );
}
