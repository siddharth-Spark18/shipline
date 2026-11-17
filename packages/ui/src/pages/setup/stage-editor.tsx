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
import { OtherFields } from '@/pages/setup/other-fields';
import { ID_RE, isBashBlock, regexError, setOptional } from '@/pages/setup/draft';
import type { StageStep } from '@/lib/routes';
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
  'checkpoint',
];

/** The stage fields shared by every step component: the stage, and a callback with its updated copy. */
interface StageFieldsProps {
  stage: StageModel;
  onChange: (stage: StageModel) => void;
}

/** The text and field setters the steps share. An empty text removes an optional key. */
function setters(stage: StageModel, onChange: (stage: StageModel) => void) {
  return {
    setText: (key: string, value: string) => {
      const next = { ...stage };
      setOptional(next, key, value);
      onChange(next);
    },
    setField: (key: string, value: unknown) => onChange({ ...stage, [key]: value }),
  };
}

/** Why the stage's id is not usable, or null. */
export function stageIdError(stage: StageModel, otherIds: string[]): string | null {
  return !stage.id
    ? 'Required'
    : !ID_RE.test(stage.id)
      ? 'Use letters, digits, - and _ only'
      : otherIds.includes(stage.id)
        ? 'Another stage already has this id'
        : null;
}

/** The steps whose fields hold something the save would reject (the stepper marks them with a dot). */
export function stepErrors(
  stage: StageModel,
  otherIds: string[],
  isFresh: boolean,
): Partial<Record<StageStep, boolean>> {
  const errors: Partial<Record<StageStep, boolean>> = {};
  if (isFresh && stageIdError(stage, otherIds)) errors.basics = true;
  if ((stage.blocks ?? []).some((b) => isBashBlock(b) && b.bash && regexError(b.bash)))
    errors.blocks = true;
  return errors;
}

/** Step 1: id, name, artifact, description, condition, agent and optional. */
export function StageBasics({
  stage,
  isFresh,
  otherIds,
  agents,
  onChange,
}: StageFieldsProps & {
  /** True for a stage added in this session: only then can the id be edited. */
  isFresh: boolean;
  /** Ids of the other stages in this workflow. */
  otherIds: string[];
  agents: SetupAgents;
}) {
  const base = `stage-${stage.id || 'new'}`;
  const { setText, setField } = setters(stage, onChange);
  const idError = stageIdError(stage, otherIds);

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
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id={`${base}-optional`}
          checked={stage.optional === true}
          onCheckedChange={(v) => setField('optional', v)}
        />
        <Label htmlFor={`${base}-optional`}>Optional (may be skipped)</Label>
      </div>

      <OtherFields value={stage} known={STAGE_KEYS} />
    </div>
  );
}

const LEVELS: { value: Enforcement; meaning: string; effect: string }[] = [
  {
    value: 'guide',
    meaning: 'Rules are ignored',
    effect: 'Claude is only guided. The stage’s rules and blocks have no effect.',
  },
  {
    value: 'warn',
    meaning: 'Allowed, with a reminder',
    effect: 'An action the stage holds back goes ahead, with a reminder shown in the chat.',
  },
  {
    value: 'block',
    meaning: 'Denied',
    effect: 'An action the stage holds back is refused until the stage is done.',
  },
];

/** Step 2: guide, warn or block as option cards, then confirm, checkpoint and checks. */
export function StageEnforcement({ stage, onChange }: StageFieldsProps) {
  const base = `stage-${stage.id || 'new'}`;
  const { setField } = setters(stage, onChange);
  const level = stage.enforcement ?? null;
  const chosen = LEVELS.find((l) => l.value === level);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span id={`${base}-enf-label`} className="text-sm leading-none font-medium">
          Enforcement
        </span>
        <div
          role="radiogroup"
          aria-labelledby={`${base}-enf-label`}
          className="grid gap-2 sm:grid-cols-3"
        >
          {LEVELS.map((l) => (
            <button
              key={l.value}
              type="button"
              role="radio"
              aria-checked={level === l.value}
              className={`flex min-h-11 flex-col gap-0.5 rounded-lg border-[1.5px] bg-card p-3 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                level === l.value
                  ? 'border-primary bg-accent text-accent-foreground ring-1 ring-primary'
                  : 'border-input hover:bg-accent/50'
              }`}
              onClick={() => setField('enforcement', l.value)}
            >
              <b>{l.value}</b>
              <span className="text-xs text-muted-foreground">{l.meaning}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {chosen ? (
            <>
              <b className="text-foreground">What {chosen.value} does here:</b> {chosen.effect}
            </>
          ) : (
            'Choose guide, warn or block.'
          )}
        </p>
      </div>

      <div className="flex flex-col gap-3">
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
            id={`${base}-checkpoint`}
            checked={stage.checkpoint === true}
            disabled={stage.confirm_to_advance !== true}
            onCheckedChange={(v) => setField('checkpoint', v)}
          />
          <Label htmlFor={`${base}-checkpoint`}>Checkpoint (asks in light mode)</Label>
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
  );
}

/** Step 4: the headings the artifact must have, one per line. */
export function StageSections({ stage, onChange }: StageFieldsProps) {
  const base = `stage-${stage.id || 'new'}`;
  const { setField } = setters(stage, onChange);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${base}-sections`}>Required sections (headings, one per line)</Label>
      {/* Uncontrolled, so a trailing newline survives while typing. */}
      <Textarea
        id={`${base}-sections`}
        className="min-h-24 text-xs"
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
  );
}
