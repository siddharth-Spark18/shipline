import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ReviewStep } from '@/pages/install/review-step';
import { ApiError, api } from '@/lib/api';
import { TRACKER_OPTIONS } from '@/lib/stages';
import type { InstallInfo, InstallSelection, TrackerId } from '@/lib/types';

const STEPS = ['Workflows', 'Agents & skills', 'Commands & process', 'CI check', 'Review'] as const;
const REVIEW = STEPS.length - 1;
const NONE = '__none__'; // a select value cannot be null
const COMMANDS = ['test', 'lint', 'build'] as const;
const FOUND_TEXT = { 'claude-md-block': 'the CLAUDE.md block', hooks: "Shipline's hooks" } as const;

type Clash = 'keep' | 'ours' | 'skip';

/** The choices the developer has made so far; everything else in the selection is derived from them. */
interface Draft {
  workflows: string[];
  ui: boolean;
  /** Agents the developer ticked or unticked by hand; the rest follow what the chosen stages use. */
  agentOverrides: Record<string, boolean>;
  clashes: Record<string, Clash>;
  stageAgents: Record<string, string | null>;
  skills: string[];
  commands: { test: string; lint: string; build: string };
  tracker: TrackerId;
  confirmations: 'standard' | 'light';
  guardrails: 'on' | 'off';
  branchPattern: string;
  ci: boolean;
}

const GUARDRAILS_SUMMARY =
  'On: force-push to main and printing credentials are denied; pushes to main, deploys, migrations, edits to agent config and protected paths (migrations/, infra/, CI files, lockfiles…) ask first.';

/** The same rule as the server's: must contain {slug}; only {key}, {slug} and {type}. The server is the authority. */
function branchPatternError(value: string): string | null {
  const v = value.trim();
  if (v === '') return null; // empty keeps the default
  if (!v.includes('{slug}')) return 'must contain {slug}';
  for (const m of v.matchAll(/\{([^}]*)\}/g)) {
    if (!['key', 'slug', 'type'].includes(m[1]))
      return `{${m[1]}} is not allowed here; use {key}, {slug} or {type}`;
  }
  return null;
}

function initialDraft(info: InstallInfo): Draft {
  return {
    workflows: info.defaults.workflows,
    ui: info.uiDetected,
    agentOverrides: {},
    clashes: {},
    stageAgents: {},
    skills: [],
    commands: { ...info.defaults.commands },
    tracker: info.trackerDefault,
    confirmations: 'standard',
    guardrails: 'on',
    branchPattern: '',
    ci: false,
  };
}

/** The stages of the chosen workflows that stay once the UI answer is applied. */
function activeStages(info: InstallInfo, draft: Draft) {
  return info.workflows
    .filter((w) => draft.workflows.includes(w.id))
    .flatMap((w) =>
      w.stages
        .filter((s) => draft.ui || s.condition !== 'ui_only')
        .map((s) => ({ ...s, wf: w.id })),
    );
}

function derive(info: InstallInfo, draft: Draft) {
  const stages = activeStages(info, draft);
  const used = new Set(stages.map((s) => s.agent).filter((a): a is string => !!a));
  const agents = info.agents
    .map((a) => a.name)
    .filter((n) => draft.agentOverrides[n] ?? used.has(n));
  const clashes: Record<string, Clash> = {};
  for (const n of agents) if (info.repoAgents.includes(n)) clashes[n] = draft.clashes[n] ?? 'keep';
  const present = agents.filter((n) => clashes[n] !== 'skip');
  const missing = stages.filter((s) => s.agent && !present.includes(s.agent));
  const stageAgents: Record<string, string | null> = {};
  for (const s of missing)
    stageAgents[`${s.wf}.${s.id}`] = draft.stageAgents[`${s.wf}.${s.id}`] ?? null;
  const selection: InstallSelection = {
    workflows: draft.workflows,
    ui: draft.ui,
    agents,
    clashes,
    stageAgents,
    skills: draft.skills,
    commands: draft.commands,
    tracker: draft.tracker,
    confirmations: draft.confirmations,
    guardrails: draft.guardrails,
    ...(draft.branchPattern.trim() ? { branchPattern: draft.branchPattern.trim() } : {}),
    ci: draft.ci,
  };
  return { selection, used, present, missing };
}

const toggle = (list: string[], value: string, on: boolean) =>
  on ? (list.includes(value) ? list : [...list, value]) : list.filter((v) => v !== value);

export function InstallWizard() {
  const infoQuery = useQuery({
    queryKey: ['install-info'],
    queryFn: api.installInfo,
    staleTime: Infinity,
  });
  if (infoQuery.error) {
    return (
      <Shell>
        <Alert variant="destructive">
          <AlertTitle>Could not load the setup options</AlertTitle>
          <AlertDescription>{infoQuery.error.message}</AlertDescription>
        </Alert>
      </Shell>
    );
  }
  if (!infoQuery.data) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </Shell>
    );
  }
  const info = infoQuery.data;
  if (info.state !== 'clean') {
    return (
      <Shell root={info.root}>
        <Alert>
          <AlertTitle>Shipline is partly installed here</AlertTitle>
          <AlertDescription>
            Shipline is partly installed here (found{' '}
            {info.found.map((f) => FOUND_TEXT[f]).join(' and ')}
            ). Run <code>npx @forgeyard/shipline uninstall</code>, then set up again.
          </AlertDescription>
        </Alert>
      </Shell>
    );
  }
  return <Wizard info={info} />;
}

function Shell({ root, children }: { root?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-svh overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
        <header>
          <h1 className="text-lg font-semibold">Set up Shipline</h1>
          {root && <p className="font-mono text-xs break-all text-muted-foreground">{root}</p>}
        </header>
        {children}
      </div>
    </div>
  );
}

function Wizard({ info }: { info: InstallInfo }) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(info));
  const [step, setStep] = useState(0);
  const [stale, setStale] = useState(false);
  const { selection, used, present, missing } = useMemo(() => derive(info, draft), [info, draft]);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  // Only the Review step asks the server anything; the other steps recompute nothing there.
  const selectionJson = JSON.stringify(selection);
  const preview = useQuery({
    queryKey: ['install-preview', selectionJson],
    queryFn: () => api.installPreview(selection),
    enabled: step === REVIEW && selection.workflows.length > 0,
    staleTime: 0,
    gcTime: 0,
  });

  const install = useMutation({
    mutationFn: () => api.install(selection, preview.data!.base),
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'installed') window.location.reload();
      else if (e instanceof ApiError && (e.code === 'changed' || e.code === 'collision')) {
        setStale(true);
        void preview.refetch();
      }
    },
  });

  useEffect(() => {
    if (step !== REVIEW) setStale(false);
  }, [step]);

  const patternError = branchPatternError(draft.branchPattern);
  const canNext = (step !== 0 || selection.workflows.length > 0) && (step !== 2 || !patternError);
  const blocked = !preview.data || preview.isFetching || preview.data.collisions.length > 0;
  const installed = install.isSuccess;
  if (install.data) {
    return (
      <Shell root={info.root}>
        <DoneScreen steps={install.data.nextSteps} />
      </Shell>
    );
  }
  const hardError =
    install.error && !(install.error instanceof ApiError && install.error.status === 409);

  return (
    <Shell root={info.root}>
      {!info.isGit && (
        <Alert>
          <AlertDescription>
            This folder isn&apos;t a git repository. Shipline works best in one.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        <nav className="flex flex-row flex-wrap gap-1 md:flex-col md:self-start" aria-label="Steps">
          {STEPS.map((name, i) => (
            <Button
              key={name}
              variant={step === i ? 'secondary' : 'ghost'}
              className="justify-start"
              disabled={
                installed ||
                (i > 0 && selection.workflows.length === 0) ||
                (i > 2 && !!patternError)
              }
              onClick={() => setStep(i)}
            >
              {i + 1}. {name}
            </Button>
          ))}
        </nav>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">{STEPS[step]}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {step === 0 && <WorkflowsStep info={info} draft={draft} patch={patch} />}
            {step === 1 && (
              <AgentsStep
                info={info}
                draft={draft}
                patch={patch}
                used={used}
                present={present}
                agents={selection.agents}
                missing={missing}
              />
            )}
            {step === 2 && (
              <CommandsStep info={info} draft={draft} patch={patch} patternError={patternError} />
            )}
            {step === 3 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <Switch id="wiz-ci" checked={draft.ci} onCheckedChange={(ci) => patch({ ci })} />
                  <Label htmlFor="wiz-ci">Add a pull-request check</Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Writes .github/workflows/shipline.yml, a GitHub Actions job that reads the
                  Shipline summary in the PR description and fails the PR when a block stage
                  isn&apos;t done or a confirmed stage has no answer. Off by default.
                </p>
              </div>
            )}
            {step === REVIEW && (
              <>
                <ReviewStep
                  selection={selection}
                  preview={preview.data}
                  loading={preview.isFetching}
                  error={preview.error}
                />
                {stale && (
                  <Alert variant="destructive">
                    <AlertTitle>The repo changed</AlertTitle>
                    <AlertDescription>
                      The repo changed since you reviewed. Review again.
                    </AlertDescription>
                  </Alert>
                )}
                {hardError && (
                  <Alert variant="destructive">
                    <AlertTitle>Install failed</AlertTitle>
                    <AlertDescription>
                      {install.error?.message} Nothing was left behind.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}

            <div className="flex justify-between gap-2 pt-2">
              <Button
                variant="outline"
                disabled={step === 0 || installed}
                onClick={() => setStep(step - 1)}
              >
                Back
              </Button>
              {step < REVIEW ? (
                <Button disabled={!canNext} onClick={() => setStep(step + 1)}>
                  Next
                </Button>
              ) : (
                <Button
                  disabled={blocked || install.isPending || installed}
                  onClick={() => {
                    setStale(false);
                    install.mutate();
                  }}
                >
                  {install.isPending ? 'Installing...' : 'Install'}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </Shell>
  );
}

type StepProps = { info: InstallInfo; draft: Draft; patch: (p: Partial<Draft>) => void };

function WorkflowsStep({ info, draft, patch }: StepProps) {
  return (
    <>
      <div className="flex flex-col gap-3">
        {info.workflows.map((w) => {
          const uiOnly = w.stages.filter((s) => s.condition === 'ui_only');
          return (
            <div key={w.id} className="flex items-start gap-2">
              <Checkbox
                id={`wiz-wf-${w.id}`}
                className="mt-0.5"
                checked={draft.workflows.includes(w.id)}
                onCheckedChange={(on) =>
                  patch({ workflows: toggle(draft.workflows, w.id, on === true) })
                }
              />
              <Label htmlFor={`wiz-wf-${w.id}`} className="flex flex-col items-start gap-0.5">
                <span>{w.name}</span>
                <span className="text-xs font-normal text-muted-foreground">{w.description}</span>
                {uiOnly.length > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">
                    UI-only stage:{' '}
                    {uiOnly.map((s) => (
                      <span key={s.id} className={cn(!draft.ui && 'line-through')}>
                        {s.name}
                      </span>
                    ))}
                    {!draft.ui && ' (left out: no UI)'}
                  </span>
                )}
              </Label>
            </div>
          );
        })}
        {draft.workflows.length === 0 && (
          <p className="text-xs text-destructive">Choose at least one workflow.</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Switch id="wiz-ui" checked={draft.ui} onCheckedChange={(ui) => patch({ ui })} />
        <Label htmlFor="wiz-ui">Does this repo have a UI?</Label>
        <span className="text-xs text-muted-foreground">
          (detected: {info.uiDetected ? 'yes' : 'no'})
        </span>
      </div>
    </>
  );
}

function AgentsStep({
  info,
  draft,
  patch,
  used,
  present,
  agents,
  missing,
}: StepProps & {
  used: Set<string>;
  present: string[];
  agents: string[];
  missing: { wf: string; id: string; name: string; agent: string | null }[];
}) {
  const stageAgents = info.agents.filter((a) => a.usedBy.length > 0);
  const standalone = info.agents.filter((a) => a.usedBy.length === 0);
  const stageName = (key: string) => {
    const [wf, stage] = key.split('.');
    const w = info.workflows.find((x) => x.id === wf);
    return `${w?.name ?? wf} → ${w?.stages.find((s) => s.id === stage)?.name ?? stage}`;
  };
  const agentRow = (a: InstallInfo['agents'][number]) => {
    const inUse = used.has(a.name);
    const clash = info.repoAgents.includes(a.name);
    const on = agents.includes(a.name);
    return (
      <div
        key={a.name}
        className={cn('flex flex-col gap-1.5', !inUse && a.usedBy.length > 0 && 'opacity-70')}
      >
        <div className="flex items-start gap-2">
          <Checkbox
            id={`wiz-agent-${a.name}`}
            className="mt-0.5"
            checked={on}
            onCheckedChange={(v) =>
              patch({ agentOverrides: { ...draft.agentOverrides, [a.name]: v === true } })
            }
          />
          <Label htmlFor={`wiz-agent-${a.name}`} className="flex flex-col items-start gap-0.5">
            <span className="font-mono">{a.name}</span>
            {a.description && (
              <span className="text-xs font-normal text-muted-foreground">{a.description}</span>
            )}
            <span className="text-xs font-normal text-muted-foreground">
              {a.usedBy.length > 0
                ? `used by: ${a.usedBy.map(stageName).join(', ')}${inUse ? '' : ' (nothing you chose uses it)'}`
                : 'not used by any stage'}
            </span>
          </Label>
        </div>
        {on && clash && (
          <div className="ml-6 flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">
              You already have .claude/agents/{a.name}.md. What should Shipline do?
            </p>
            <RadioGroup
              value={draft.clashes[a.name] ?? 'keep'}
              onValueChange={(v) => patch({ clashes: { ...draft.clashes, [a.name]: v as Clash } })}
            >
              {(
                [
                  ['keep', 'Keep yours (used where Shipline would use its own)'],
                  ['ours', "Use Shipline's (replaces your file)"],
                  ['skip', 'Skip (install nothing for this agent)'],
                ] as const
              ).map(([value, label]) => (
                <div key={value} className="flex items-center gap-2">
                  <RadioGroupItem value={value} id={`wiz-clash-${a.name}-${value}`} />
                  <Label htmlFor={`wiz-clash-${a.name}-${value}`} className="text-xs font-normal">
                    {label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>
        )}
      </div>
    );
  };

  const replacements = [
    ...present.map((n) => ({ name: n, label: `${n} (Shipline)` })),
    ...info.repoAgents
      .filter((n) => !present.includes(n))
      .map((n) => ({ name: n, label: `${n} (yours)` })),
  ];

  return (
    <>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Agents the stages use</h3>
        {stageAgents.map(agentRow)}
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Other agents (off by default)</h3>
        {standalone.map(agentRow)}
      </section>
      {missing.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Stages whose agent is not installed</h3>
          {missing.map((m) => {
            const key = `${m.wf}.${m.id}`;
            return (
              <div key={key} className="flex flex-col gap-1.5">
                <Label htmlFor={`wiz-stage-${key}`} className="text-xs font-normal">
                  Stage &quot;{m.name}&quot; of {m.wf} suggests{' '}
                  <span className="font-mono">{m.agent}</span>. Use which agent instead?
                </Label>
                <Select
                  value={draft.stageAgents[key] ?? NONE}
                  onValueChange={(v) =>
                    patch({ stageAgents: { ...draft.stageAgents, [key]: v === NONE ? null : v } })
                  }
                >
                  <SelectTrigger id={`wiz-stage-${key}`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {replacements.map((r) => (
                      <SelectItem key={r.name} value={r.name}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </section>
      )}
      {info.repoSkills.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">
            This repo&apos;s own skills Claude should be pointed to at every stage
          </h3>
          {info.repoSkills.map((s) => (
            <div key={s} className="flex items-center gap-2">
              <Checkbox
                id={`wiz-skill-${s}`}
                checked={draft.skills.includes(s)}
                onCheckedChange={(on) => patch({ skills: toggle(draft.skills, s, on === true) })}
              />
              <Label htmlFor={`wiz-skill-${s}`} className="font-mono">
                {s}
              </Label>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function CommandsStep({
  info,
  draft,
  patch,
  patternError,
}: StepProps & { patternError: string | null }) {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        The verify stage runs these. Leave one empty for none; you can change them later in
        .shipline/config.yml.
      </p>
      {COMMANDS.map((k) => (
        <div key={k} className="flex flex-col gap-1.5">
          <Label htmlFor={`wiz-cmd-${k}`} className="capitalize">
            {k} command
            {info.detected.sources[k] && draft.commands[k] === info.detected[k] && (
              <span className="text-xs font-normal text-muted-foreground">
                {' '}
                (from {info.detected.sources[k]})
              </span>
            )}
          </Label>
          <Input
            id={`wiz-cmd-${k}`}
            className="font-mono"
            value={draft.commands[k]}
            onChange={(e) => patch({ commands: { ...draft.commands, [k]: e.target.value } })}
          />
        </div>
      ))}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wiz-tracker">Tracker</Label>
        <Select value={draft.tracker} onValueChange={(v) => patch({ tracker: v as TrackerId })}>
          <SelectTrigger id="wiz-tracker" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRACKER_OPTIONS.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Confirmations</Label>
        <RadioGroup
          value={draft.confirmations}
          onValueChange={(v) => patch({ confirmations: v as 'standard' | 'light' })}
        >
          {(
            [
              ['standard', 'Standard', 'Claude asks before each stage that is marked to confirm.'],
              [
                'light',
                'Light',
                'Claude asks only at checkpoints (plan approval); skipping, failed checks and scope questions still ask.',
              ],
            ] as const
          ).map(([value, label, hint]) => (
            <div key={value} className="flex items-start gap-2">
              <RadioGroupItem value={value} id={`wiz-confirmations-${value}`} className="mt-0.5" />
              <Label
                htmlFor={`wiz-confirmations-${value}`}
                className="flex flex-col items-start gap-0 font-normal"
              >
                <span>{label}</span>
                <span className="text-xs text-muted-foreground">{hint}</span>
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wiz-branch-pattern">Branch pattern</Label>
        <Input
          id="wiz-branch-pattern"
          className="font-mono"
          placeholder={info.branchPatternDefault}
          value={draft.branchPattern}
          aria-invalid={!!patternError}
          onChange={(e) => patch({ branchPattern: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          {'{type}'} = workflow, {'{key}'} = ticket key, {'{slug}'} = short task name. Leave empty
          for {info.branchPatternDefault}.
        </p>
        {patternError && <p className="text-xs text-destructive">Branch pattern {patternError}.</p>}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <Switch
            id="wiz-guardrails"
            checked={draft.guardrails === 'on'}
            onCheckedChange={(on) => patch({ guardrails: on ? 'on' : 'off' })}
          />
          <Label htmlFor="wiz-guardrails">Guardrails</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {draft.guardrails === 'on'
            ? GUARDRAILS_SUMMARY
            : 'Off: every rail is written as off and no paths are protected. Turn them on later in .shipline/config.yml or Setup, Guardrails.'}
        </p>
      </div>
    </>
  );
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.error('Could not copy. Select the text and copy it by hand.');
  }
}

/** The checklist from the server: numbered items (`  1. ...`) whose indented lines continue the item above. */
function parseSteps(lines: string[]) {
  const items: string[] = [];
  for (const line of lines) {
    if (/^\s{2}\d+\.\s/.test(line)) items.push(line.replace(/^\s{2}\d+\.\s/, ''));
    else if (items.length && line.trim()) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

/** The commands in a checklist item: the `git add ... && git commit ...` line and anything in backticks. */
function commandsOf(item: string): string[] {
  const out: string[] = [];
  const git = /git add .*? && git commit -m "[^"]*"/.exec(item);
  if (git) out.push(git[0]);
  for (const m of item.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  return out;
}

/** Shown after a successful install: what to do now, with a copy button on each command. */
function DoneScreen({ steps }: { steps: string[] }) {
  const items = parseSteps(steps);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">You&apos;re set up</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ol className="flex flex-col gap-3 text-sm">
          {items.map((item, i) => (
            <li key={i} className="flex flex-col gap-1.5">
              <span>
                {i + 1}. {item}
              </span>
              {commandsOf(item).map((c) => (
                <div key={c} className="ml-4 flex items-center gap-2">
                  <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs break-all">
                    {c}
                  </code>
                  <Button variant="outline" size="sm" onClick={() => void copy(c)}>
                    Copy
                  </Button>
                </div>
              ))}
            </li>
          ))}
        </ol>
        <div>
          <Button onClick={() => window.location.reload()}>Open Shipline</Button>
        </div>
      </CardContent>
    </Card>
  );
}
