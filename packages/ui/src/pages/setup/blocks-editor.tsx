import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { OtherFields } from '@/pages/setup/other-fields';
import { BLOCK_ACTIONS, isActionsBlock, isBashBlock, regexError } from '@/pages/setup/draft';
import type { Block, Enforcement } from '@/lib/types';

const BLOCK_KEYS = ['tools', 'allow_paths', 'bash', 'actions'];

/** List editor for a stage's `blocks`: "tools + allow paths", "bash regex" and "actions" entries. */
export function BlocksEditor({
  stageId,
  blocks,
  enforcement,
  onChange,
}: {
  stageId: string;
  blocks: Block[];
  enforcement: Enforcement | null | undefined;
  onChange: (blocks: Block[]) => void;
}) {
  const update = (i: number, block: Block) => onChange(blocks.map((b, j) => (j === i ? block : b)));
  const remove = (i: number) => onChange(blocks.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Blocks (held back until this stage is done)</Label>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="xs"
            onClick={() => onChange([...blocks, { tools: '', allow_paths: [] }])}
          >
            <PlusIcon /> Tools rule
          </Button>
          <Button variant="outline" size="xs" onClick={() => onChange([...blocks, { bash: '' }])}>
            <PlusIcon /> Bash rule
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => onChange([...blocks, { actions: ['commit', 'pr'] }])}
          >
            <PlusIcon /> Actions
          </Button>
        </div>
      </div>

      {blocks.length > 0 && enforcement === 'guide' && (
        <p className="text-xs text-enf-warn">
          Has no effect under guide. Set enforcement to warn or block for these rules to apply.
        </p>
      )}

      {blocks.map((block, i) => {
        if (isActionsBlock(block)) {
          const idBase = `blocks-${stageId}-${i}`;
          const chosen = Array.isArray(block.actions) ? block.actions : [];
          // Names this editor doesn't offer are kept as written.
          const unknown = chosen.filter((a) => !BLOCK_ACTIONS.includes(a));
          const toggle = (action: string, on: boolean) =>
            update(i, {
              ...block,
              actions: on ? [...chosen, action] : chosen.filter((a) => a !== action),
            });
          return (
            <div key={i} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Named actions, matched on the parsed command
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Remove rule"
                  onClick={() => remove(i)}
                >
                  <Trash2Icon />
                </Button>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {BLOCK_ACTIONS.map((action) => (
                  <div key={action} className="flex items-center gap-2">
                    <Checkbox
                      id={`${idBase}-${action}`}
                      checked={chosen.includes(action)}
                      onCheckedChange={(on) => toggle(action, on === true)}
                    />
                    <Label htmlFor={`${idBase}-${action}`} className="font-mono text-xs">
                      {action}
                    </Label>
                  </div>
                ))}
              </div>
              {unknown.length > 0 && (
                <p className="text-xs text-enf-warn">
                  Not a known action, so it never matches: {unknown.join(', ')}.
                </p>
              )}
              {chosen.length === 0 && (
                <p className="text-xs text-destructive">Choose at least one action.</p>
              )}
              <OtherFields value={block} known={BLOCK_KEYS} />
            </div>
          );
        }
        const bash = isBashBlock(block);
        const pattern = bash ? block.bash : (block.tools as string);
        const err = pattern ? regexError(pattern) : null;
        const idBase = `blocks-${stageId}-${i}`;
        return (
          <div key={i} className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                {bash ? 'Bash commands matching a regex' : 'Tools, except on allowed paths'}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Remove rule"
                onClick={() => remove(i)}
              >
                <Trash2Icon />
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idBase}-pattern`}>
                {bash ? 'Bash regex' : 'Tool names regex'}
              </Label>
              <Input
                id={`${idBase}-pattern`}
                className="font-mono text-xs"
                value={pattern ?? ''}
                placeholder={bash ? String.raw`\bgit\s+commit\b` : 'Edit|Write|MultiEdit'}
                aria-invalid={err ? true : undefined}
                onChange={(e) =>
                  update(
                    i,
                    bash ? { ...block, bash: e.target.value } : { ...block, tools: e.target.value },
                  )
                }
              />
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
            {!bash && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${idBase}-paths`}>Allowed paths (globs, one per line)</Label>
                {/* Uncontrolled, so a trailing newline survives while typing. */}
                <Textarea
                  key={`${i}-${blocks.length}`}
                  id={`${idBase}-paths`}
                  className="min-h-16 font-mono text-xs"
                  defaultValue={(block.allow_paths ?? []).join('\n')}
                  onChange={(e) =>
                    update(i, {
                      ...block,
                      allow_paths: e.target.value.split('\n').filter((l) => l.trim() !== ''),
                    })
                  }
                />
              </div>
            )}
            <OtherFields value={block} known={BLOCK_KEYS} />
          </div>
        );
      })}
    </div>
  );
}
