import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { BlocksEditor } from '@/pages/setup/blocks-editor';
import { OtherFields } from '@/pages/setup/other-fields';
import { RulesEditor } from '@/pages/setup/rules-editor';
import { ID_RE, setOptional } from '@/pages/setup/draft';
import type { Enforcement, SetupAgents, StageModel } from '@/lib/types';

const NONE = '__none__';
const STAGE_KEYS = [
  'id',
  'name',
  'artifact',
  'description',
  'optional',
  'confirm_to_advance',
  'condition',
  'agent',
  'enforcement',
  'blocks',
  'checks',
  'sections',
];

export interface StageEditorProps {
  stage: StageModel;
  /** True for a stage added in this session: only then can the id be edited. */
  isFresh: boolean;
  /** Ids of the other stages in this workflow. */
  otherIds: string[];
  agents: SetupAgents;
  rules: { text: string; exists: boolean };
  onChange: (stage: StageModel) => void;
  onRulesChange: (text: string) => void;
}

export function StageEditor({
  stage,
  isFresh,
  otherIds,
  agents,
  rules,
  onChange,
  onRulesChange,
}: StageEditorProps) {
  const base = `stage-${stage.id || 'new'}`;
  const setText = (key: string, value: string) => {
    const next = { ...stage };
    setOptional(next, key, value);
    onChange(next);
  };
  const setField = (key: string, value: unknown) => onChange({ ...stage, [key]: value });

  const idError = !stage.id
    ? 'Required'
    : !ID_RE.test(stage.id)
      ? 'Use letters, digits, - and _ only'
      : otherIds.includes(stage.id)
        ? 'Another stage already has this id'
        : null;

  // Shipline's installed agents, then the repo's own (which includes a Shipline name whose file is
  // the team's own, kept instead of ours).
  const shiplineNames = agents.shipline
    .filter((a) => a.installed && !a.excluded)
    .map((a) => a.name);
  const repoNames = [
    ...new Set([
      ...agents.repo,
      ...agents.shipline.filter((a) => a.installed && a.excluded).map((a) => a.name),
    ]),
  ].filter((n) => !shiplineNames.includes(n));
  const unknownAgent =
    stage.agent && !shiplineNames.includes(stage.agent) && !repoNames.includes(stage.agent)
      ? stage.agent
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-id`}>Id</Label>
          <Input
            id={`${base}-id`}
            className="font-mono"
            value={stage.id}
            readOnly={!isFresh}
            disabled={!isFresh}
            aria-invalid={idError ? true : undefined}
            onChange={(e) => setField('id', e.target.value)}
          />
          {isFresh ? (
            idError && <p className="text-xs text-destructive">{idError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">A saved stage id can't change.</p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-name`}>Name</Label>
          <Input
            id={`${base}-name`}
            value={stage.name ?? ''}
            onChange={(e) => setText('name', e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-artifact`}>Artifact (file name in the task folder)</Label>
          <Input
            id={`${base}-artifact`}
            className="font-mono"
            value={stage.artifact ?? ''}
            onChange={(e) => setText('artifact', e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-description`}>Description</Label>
          <Input
            id={`${base}-description`}
            value={stage.description ?? ''}
            onChange={(e) => setText('description', e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-enforcement`}>Enforcement</Label>
          <Select
            value={stage.enforcement ?? ''}
            onValueChange={(v) => setField('enforcement', v as Enforcement)}
          >
            <SelectTrigger id={`${base}-enforcement`} className="w-full">
              <SelectValue placeholder="Choose guide, warn or block" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="guide">guide: rules are ignored</SelectItem>
              <SelectItem value="warn">warn: allowed, with a reminder</SelectItem>
              <SelectItem value="block">block: denied</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-condition`}>Condition</Label>
          <Select
            value={stage.condition ?? NONE}
            onValueChange={(v) => {
              const next = { ...stage };
              if (v === NONE) delete next.condition;
              else next.condition = v as 'ui_only';
              onChange(next);
            }}
          >
            <SelectTrigger id={`${base}-condition`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>none</SelectItem>
              <SelectItem value="ui_only">ui_only: runs only for UI work</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-agent`}>Agent</Label>
          <Select
            value={stage.agent ?? NONE}
            onValueChange={(v) => {
              const next = { ...stage };
              if (v === NONE) delete next.agent;
              else next.agent = v;
              onChange(next);
            }}
          >
            <SelectTrigger id={`${base}-agent`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {shiplineNames.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Shipline agents</SelectLabel>
                  {shiplineNames.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {repoNames.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Your agents</SelectLabel>
                  {repoNames.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {unknownAgent && (
                <SelectGroup>
                  <SelectLabel>Not installed</SelectLabel>
                  <SelectItem value={unknownAgent}>{unknownAgent} (agent not installed)</SelectItem>
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col justify-end gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id={`${base}-optional`}
              checked={stage.optional === true}
              onCheckedChange={(v) => setField('optional', v)}
            />
            <Label htmlFor={`${base}-optional`}>Optional (may be skipped)</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={`${base}-confirm`}
              checked={stage.confirm_to_advance === true}
              onCheckedChange={(v) => setField('confirm_to_advance', v)}
            />
            <Label htmlFor={`${base}-confirm`}>Confirm to advance</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={`${base}-checks`}
              checked={stage.checks === true}
              onCheckedChange={(v) => setField('checks', v)}
            />
            <Label htmlFor={`${base}-checks`}>Run checks before finishing</Label>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${base}-sections`}>Required sections (headings, one per line)</Label>
        {/* Uncontrolled, so a trailing newline survives while typing. */}
        <Textarea
          id={`${base}-sections`}
          className="min-h-16 text-xs"
          defaultValue={(stage.sections ?? []).join('\n')}
          placeholder="Scope"
          onChange={(e) =>
            setField(
              'sections',
              e.target.value.split('\n').filter((l) => l.trim() !== ''),
            )
          }
        />
        <p className="text-xs text-muted-foreground">
          The artifact must have each as a Markdown heading with some text under it before the stage
          can finish.
        </p>
      </div>

      <BlocksEditor
        stageId={stage.id || 'new'}
        blocks={stage.blocks ?? []}
        enforcement={stage.enforcement}
        onChange={(blocks) => {
          const next = { ...stage };
          if (blocks.length === 0) delete next.blocks;
          else next.blocks = blocks;
          onChange(next);
        }}
      />

      {stage.id && ID_RE.test(stage.id) && (
        <RulesEditor
          stageId={stage.id}
          exists={rules.exists}
          value={rules.text}
          onChange={onRulesChange}
        />
      )}

      <OtherFields value={stage} known={STAGE_KEYS} />
    </div>
  );
}
