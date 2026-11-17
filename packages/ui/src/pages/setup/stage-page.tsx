import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftIcon } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { BlocksEditor } from '@/pages/setup/blocks-editor';
import { RulesEditor } from '@/pages/setup/rules-editor';
import {
  StageBasics,
  StageEnforcement,
  StageSections,
  stepErrors,
} from '@/pages/setup/stage-editor';
import { ID_RE, type WorkflowDraft } from '@/pages/setup/draft';
import { STAGE_STEPS, type StageStep } from '@/lib/routes';
import type { SetupAgents, StageModel } from '@/lib/types';

const STEP_LABEL: Record<StageStep, string> = {
  basics: 'Basics',
  enforcement: 'Enforcement',
  blocks: 'Blocks',
  sections: 'Required sections',
  rules: 'Rules',
};

/**
 * One stage on its own page, split into five steps the user can jump between freely. The step is in the address, so a
 * reload keeps it. Edits go to the workflow draft held by the Setup page; nothing is lost moving between steps.
 */
export function StagePage({
  n,
  step,
  draft,
  agents,
  rules,
  mobile,
  pagerSlot,
  onStep,
  onClose,
  onChange,
  onRulesChange,
}: {
  /** 1-based position of the stage. The Setup page has checked it is in range. */
  n: number;
  step: StageStep;
  draft: WorkflowDraft;
  agents: SetupAgents;
  rules: (stageId: string) => { text: string; exists: boolean };
  mobile: boolean;
  /** On a phone, where the Back/Next buttons go (pinned above the unsaved bar). Null: inline. */
  pagerSlot: HTMLElement | null;
  /** Go to another step (Setup: change the address; install wizard: local state). */
  onStep: (step: StageStep) => void;
  /** Back to the stage list. */
  onClose: () => void;
  onChange: (draft: WorkflowDraft) => void;
  onRulesChange: (stageId: string, text: string) => void;
}) {
  const stages = draft.model.stages ?? [];
  const stage = stages[n - 1];
  if (!stage) return null;
  const key = draft.keys[n - 1];
  const isFresh = draft.fresh.includes(key);
  const otherIds = stages.filter((_, j) => j !== n - 1).map((s) => s.id);
  const errors = stepErrors(stage, otherIds, isFresh);

  const setStage = (next: StageModel) =>
    onChange({
      ...draft,
      model: { ...draft.model, stages: stages.map((x, j) => (j === n - 1 ? next : x)) },
    });
  const go = onStep;
  const index = STAGE_STEPS.indexOf(step);
  const last = index === STAGE_STEPS.length - 1;

  let body: ReactNode;
  switch (step) {
    case 'basics':
      body = (
        <StageBasics
          stage={stage}
          isFresh={isFresh}
          otherIds={otherIds}
          agents={agents}
          onChange={setStage}
        />
      );
      break;
    case 'enforcement':
      body = <StageEnforcement stage={stage} onChange={setStage} />;
      break;
    case 'blocks':
      body = (
        <BlocksEditor
          stageId={stage.id || 'new'}
          blocks={stage.blocks ?? []}
          enforcement={stage.enforcement}
          onChange={(blocks) => {
            const next = { ...stage };
            if (blocks.length === 0) delete next.blocks;
            else next.blocks = blocks;
            setStage(next);
          }}
        />
      );
      break;
    case 'sections':
      body = <StageSections stage={stage} onChange={setStage} />;
      break;
    case 'rules': {
      const r = rules(stage.id);
      body =
        stage.id && ID_RE.test(stage.id) ? (
          <RulesEditor
            stageId={stage.id}
            exists={r.exists}
            value={r.text}
            onChange={(text) => onRulesChange(stage.id, text)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Give the stage a valid id on the Basics step to add rules.
          </p>
        );
      break;
    }
  }

  const pager = (
    <div className="flex items-center gap-2 border-t bg-card px-4 py-2 md:border-0 md:bg-transparent md:p-0">
      <Button
        variant="outline"
        className="max-md:h-11 max-md:flex-1"
        disabled={index === 0}
        onClick={() => go(STAGE_STEPS[index - 1])}
      >
        Back
      </Button>
      {last ? (
        <Button className="max-md:h-11 max-md:flex-1" onClick={onClose}>
          Done
        </Button>
      ) : (
        <Button className="max-md:h-11 max-md:flex-1" onClick={() => go(STAGE_STEPS[index + 1])}>
          Next
        </Button>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-extrabold tracking-tight">
          {stage.name || stage.id || 'New stage'}
        </h2>
        <Button variant="ghost" className="max-md:h-11" onClick={onClose}>
          <ArrowLeftIcon /> Back to stage list
        </Button>
      </div>

      {mobile ? (
        <div className="flex flex-col gap-1" aria-label="Stage steps" role="group">
          <span className="text-sm font-semibold">
            Step {index + 1} of {STAGE_STEPS.length}: {STEP_LABEL[step]}
            {errors[step] ? ' (needs a fix)' : ''}
          </span>
          <div className="flex">
            {STAGE_STEPS.map((s, i) => (
              <button
                key={s}
                type="button"
                aria-label={`Step ${i + 1}: ${STEP_LABEL[s]}${errors[s] ? ' (needs a fix)' : ''}`}
                aria-current={s === step ? 'step' : undefined}
                className="flex h-11 min-w-11 items-center justify-center"
                onClick={() => go(s)}
              >
                <span
                  className={cn(
                    'size-3 rounded-full border-2',
                    s === step ? 'border-primary bg-primary' : 'border-input bg-secondary',
                    errors[s] && 'border-destructive',
                  )}
                />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <nav aria-label="Stage steps">
          <ol className="flex flex-wrap gap-x-4 gap-y-2">
            {STAGE_STEPS.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  aria-current={s === step ? 'step' : undefined}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                    s === step ? 'font-bold' : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => go(s)}
                >
                  <span
                    className={cn(
                      'flex size-6 items-center justify-center rounded-full text-xs font-bold',
                      s === step
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground',
                    )}
                  >
                    {i + 1}
                  </span>
                  {STEP_LABEL[s]}
                  {errors[s] && (
                    <span
                      role="img"
                      aria-label="Needs a fix"
                      className="size-2 rounded-full bg-destructive"
                    />
                  )}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="rounded-xl border bg-card p-4">{body}</div>

      {mobile && pagerSlot ? createPortal(pager, pagerSlot) : pager}
    </div>
  );
}
