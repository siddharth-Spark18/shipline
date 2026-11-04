import { ReactNode } from 'react';
import {
  ARTIFACT_TYPES,
  ArtifactType,
  BUILT_IN_STAGE_TYPES,
  CustomAgentDTO,
  PluginAgentDTO,
  STAGE_TYPES,
  STAGE_TYPE_LABELS,
  StageToolPolicy,
  StageType,
  customAgentRef,
  pluginAgentRef,
} from '@shipline/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import RulesEditor from '@/components/guardrails/rules-editor';
import { EditorStage } from '../editor-state';

const BASH_MODES: Array<{ value: StageToolPolicy['bash']; label: string }> = [
  { value: 'inherit', label: "Follow the role's edit policy" },
  { value: 'deny', label: 'Read-only commands only' },
  { value: 'ask', label: 'Ask first' },
  { value: 'allow', label: 'Allowed' },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

interface StageSheetProps {
  stage: EditorStage | null;
  /** Built-in types other stages already use: a template can have only one of each. */
  takenTypes: ReadonlySet<StageType>;
  pluginAgents: PluginAgentDTO[];
  customAgents: CustomAgentDTO[];
  readOnly?: boolean;
  onChange: (patch: Partial<EditorStage>) => void;
  onClose: () => void;
}

/**
 * The stage drawer: name and type, the instructions Claude gets when the stage starts, its agent,
 * whether it is optional or required for shipline/gates, artifact types, the stage tool policy and
 * the stage's own guardrail rules. Edits apply to the draft; saving the template creates the version.
 */
export default function StageSheet({ stage, takenTypes, pluginAgents, customAgents, readOnly, onChange, onClose }: StageSheetProps) {
  const policy = stage?.toolPolicy;
  const setPolicy = (patch: Partial<StageToolPolicy>) => policy && onChange({ toolPolicy: { ...policy, ...patch } });
  const agentValue = stage?.agentRef ?? 'none';
  const agentMissing = !!stage?.agentRef && !pluginAgents.some((a) => pluginAgentRef(a.name) === stage.agentRef) && !customAgents.some((a) => customAgentRef(a.id) === stage.agentRef);

  const toggleArtifact = (type: ArtifactType, on: boolean) => {
    if (!stage) return;
    const next = on ? [...new Set([...stage.artifactTypes, type])] : stage.artifactTypes.filter((t) => t !== type);
    onChange({ artifactTypes: ARTIFACT_TYPES.filter((t) => next.includes(t)) });
  };

  return (
    <Sheet open={!!stage} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto p-0 data-[side=right]:sm:max-w-xl">
        {stage && policy && (
          <>
            <SheetHeader>
              <SheetTitle>{stage.name || 'Stage'}</SheetTitle>
              <SheetDescription>
                {stage.type === 'custom' ? 'A custom stage: instructions, guardrails and an artifact.' : `A ${STAGE_TYPE_LABELS[stage.type]} stage keeps its built-in behaviour.`}
              </SheetDescription>
            </SheetHeader>
            <fieldset disabled={readOnly} className="space-y-5 px-4 pb-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name">
                  <Input value={stage.name} onChange={(e) => onChange({ name: e.target.value })} />
                </Field>
                <Field label="Type" hint="Built-in types keep their special behaviour; each can be used once.">
                  <Select value={stage.type} onValueChange={(type) => onChange({ type: type as StageType })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STAGE_TYPES.map((t) => (
                        <SelectItem key={t} value={t} disabled={BUILT_IN_STAGE_TYPES.includes(t) && takenTypes.has(t)}>
                          {STAGE_TYPE_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label="Instructions" hint="The text Claude gets when the stage starts.">
                <Textarea rows={7} value={stage.instructions} onChange={(e) => onChange({ instructions: e.target.value })} />
              </Field>
              <Field label="Agent" hint="Claude is told to delegate the stage's work to this agent. Custom agents are passed to Claude Code with --agents.">
                <Select value={agentValue} onValueChange={(v) => onChange({ agentRef: v === 'none' ? null : v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No agent</SelectItem>
                    <SelectGroup>
                      <SelectLabel>Plugin agents</SelectLabel>
                      {pluginAgents.map((a) => (
                        <SelectItem key={a.name} value={pluginAgentRef(a.name)}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    {customAgents.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Custom agents</SelectLabel>
                        {customAgents.map((a) => (
                          <SelectItem key={a.id} value={customAgentRef(a.id)}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {agentMissing && stage.agentRef && <SelectItem value={stage.agentRef}>(deleted agent)</SelectItem>}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                  <span>
                    Optional
                    <span className="block text-xs text-muted-foreground">Claude may propose skipping it.</span>
                  </span>
                  <Switch checked={stage.optional} onCheckedChange={(optional) => onChange({ optional })} />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                  <span>
                    Required for gates
                    <span className="block text-xs text-muted-foreground">Must be done before shipline/gates passes.</span>
                  </span>
                  <Switch checked={stage.requiredForGate} onCheckedChange={(requiredForGate) => onChange({ requiredForGate })} />
                </label>
              </div>
              <Field label="Artifact types" hint="What Claude may submit for this stage; the first is the default.">
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {ARTIFACT_TYPES.map((t) => (
                    <label key={t} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={stage.artifactTypes.includes(t)} onCheckedChange={(v) => toggleArtifact(t, v === true)} />
                      {t.toLowerCase().replace('_', ' ')}
                    </label>
                  ))}
                </div>
              </Field>
              {/* OPEN-QUESTION #2: the stage tool policy stays two toggles (code edits, shell mode) next to the stage rules, not expressed as rules. */}
              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-sm font-medium">Stage tool policy</p>
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    Allow code edits
                    <span className="block text-xs text-muted-foreground">Off: Edit, Write and NotebookEdit are denied in this stage whatever the role.</span>
                  </span>
                  <Switch checked={policy.allowCodeEdit} onCheckedChange={(allowCodeEdit) => setPolicy({ allowCodeEdit })} />
                </label>
                <Field label="Shell commands">
                  <Select value={policy.bash} onValueChange={(bash) => setPolicy({ bash: bash as StageToolPolicy['bash'] })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BASH_MODES.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Stage rules</p>
                <p className="text-xs text-muted-foreground">Apply only while this stage is current, on top of the org, project and role rules (they can only tighten).</p>
                <RulesEditor
                  rules={stage.rules}
                  readOnly={readOnly}
                  addTitle="Add stage rule"
                  emptyMessage="No stage rules."
                  onCreate={(rule) => onChange({ rules: [...stage.rules, rule] })}
                  onUpdate={(_rule, index, rule) => onChange({ rules: stage.rules.map((r, i) => (i === index ? rule : r)) })}
                  onDelete={(_rule, index) => onChange({ rules: stage.rules.filter((_, i) => i !== index) })}
                />
              </div>
            </fieldset>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
