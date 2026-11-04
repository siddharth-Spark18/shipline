import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  EDIT_POLICIES,
  GuardrailRuleInput,
  PATH_ACTIONS,
  PathAction,
  RULE_KINDS,
  RULE_KIND_LABELS,
  RuleKind,
  normalizeRuleInput,
  validateRuleInput,
} from '@shipline/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/api';

const HINTS: Record<RuleKind, { placeholder: string; help: string }> = {
  path: {
    placeholder: '**/.env*',
    help: 'A glob, relative to the chat\'s worktree. ** crosses folders, * stays in one. A pattern without a slash matches at any depth. Example: prisma/migrations/**',
  },
  bash: {
    placeholder: 'Bash(git push --force:*)',
    help: 'Claude Code permission syntax, matched per sub-command (split on &&, ||, ;, |). Bash(npm install:*) is "this prefix, then anything"; Bash(git status) matches only that exact command.',
  },
  tool: {
    placeholder: 'WebFetch',
    help: 'A tool name (WebFetch, WebSearch, NotebookEdit), an MCP tool, or an MCP server wildcard such as mcp__github__*.',
  },
};

const EMPTY: GuardrailRuleInput = { kind: 'path', pattern: '', actions: ['edit'], effect: 'deny', reason: '' };

interface RuleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rule being edited; undefined for a new one. */
  initial?: GuardrailRuleInput;
  title: string;
  onSubmit: (rule: GuardrailRuleInput) => Promise<unknown> | void;
}

/** Add or edit one rule (path, Bash command or tool). The same dialog serves org, project, role and stage rules. */
export default function RuleFormDialog({ open, onOpenChange, initial, title, onSubmit }: RuleFormDialogProps) {
  const [rule, setRule] = useState<GuardrailRuleInput>(initial ?? EMPTY);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setRule(initial ?? EMPTY);
      setProblem(null);
    }
  }, [open, initial]);

  const toggleAction = (action: PathAction, on: boolean) =>
    setRule((r) => ({ ...r, actions: on ? [...new Set([...r.actions, action])] : r.actions.filter((a) => a !== action) }));

  const submit = async () => {
    const issue = validateRuleInput(rule);
    setProblem(issue);
    if (issue) return;
    setSaving(true);
    try {
      await onSubmit(normalizeRuleInput(rule));
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const hint = HINTS[rule.kind];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Every tool call is checked against all matching rules; the strictest wins (deny, then ask, then allow).</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Kind</Label>
              <Select
                value={rule.kind}
                onValueChange={(kind) => setRule((r) => ({ ...r, kind: kind as RuleKind, actions: kind === 'path' ? (r.actions.length ? r.actions : ['edit']) : [] }))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RULE_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {RULE_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Effect</Label>
              <Select value={rule.effect} onValueChange={(effect) => setRule((r) => ({ ...r, effect: effect as GuardrailRuleInput['effect'] }))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...EDIT_POLICIES].reverse().map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rule-pattern">Pattern</Label>
            <Input id="rule-pattern" value={rule.pattern} placeholder={hint.placeholder} onChange={(e) => setRule((r) => ({ ...r, pattern: e.target.value }))} className="font-mono" />
            <p className="text-xs text-muted-foreground">{hint.help}</p>
          </div>
          {rule.kind === 'path' && (
            <div className="space-y-2">
              <Label>Applies to</Label>
              <div className="flex gap-4">
                {PATH_ACTIONS.map((a) => (
                  <label key={a} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={rule.actions.includes(a)} onCheckedChange={(v) => toggleAction(a, v === true)} />
                    {a === 'read' ? 'Read (Read, Grep, Glob)' : 'Edit (Edit, Write, NotebookEdit)'}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="rule-reason">Reason</Label>
            <Input id="rule-reason" value={rule.reason} placeholder="Never touch env files" onChange={(e) => setRule((r) => ({ ...r, reason: e.target.value }))} />
            <p className="text-xs text-muted-foreground">Shown to the user and to Claude when the rule denies or asks: for example "Org rule: Never touch env files".</p>
          </div>
          {problem && <p className="text-sm text-destructive">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />} Save rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
