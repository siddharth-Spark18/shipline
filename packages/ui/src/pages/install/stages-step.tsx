import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StageList } from '@/pages/setup/stage-list';
import type { WorkflowDraft } from '@/pages/setup/draft';
import type { InstallInfo, SetupAgents } from '@/lib/types';

/** The shipped agents as the stage editor lists them: the ones that will be installed, plus the repo's own. */
export function setupAgentsOf(info: InstallInfo, installed: string[]): SetupAgents {
  return {
    shipline: info.agents.map((a) => ({
      name: a.name,
      installed: installed.includes(a.name),
      excluded: false,
      hash: null,
    })),
    repo: info.repoAgents,
  };
}

/**
 * The stage list of a workflow as shown for the UI answer: with no UI, `ui_only` stages are hidden (the server
 * drops them on install). Hidden stages keep their place and their edits; edits to the visible ones are merged back.
 */
function visibleDraft(draft: WorkflowDraft, ui: boolean) {
  const stages = draft.model.stages ?? [];
  const hidden = (i: number) => !ui && stages[i].condition === 'ui_only';
  if (!stages.some((_, i) => hidden(i)))
    return { view: draft, merge: (next: WorkflowDraft) => next };

  const shown = stages.map((_, i) => i).filter((i) => !hidden(i));
  const view: WorkflowDraft = {
    model: { ...draft.model, stages: shown.map((i) => stages[i]) },
    keys: shown.map((i) => draft.keys[i]),
    fresh: draft.fresh,
  };
  const merge = (next: WorkflowDraft): WorkflowDraft => {
    const out = (next.model.stages ?? []).map((stage, i) => ({ stage, key: next.keys[i] }));
    stages.forEach((stage, i) => {
      if (!hidden(i)) return;
      // Back in right after the stage that was above it, or the nearest one above that is still there.
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const found = out.findIndex((o) => o.key === draft.keys[j]);
        if (found >= 0) {
          at = found + 1;
          break;
        }
      }
      out.splice(at, 0, { stage, key: draft.keys[i] });
    });
    return {
      model: { ...next.model, stages: out.map((o) => o.stage) },
      keys: out.map((o) => o.key),
      fresh: next.fresh,
    };
  };
  return { view, merge };
}

/**
 * Step 2: a tab per chosen workflow with the Setup page's stage list and stage editor. Rules are keyed by stage id,
 * so a stage used in two workflows shares one text, the same as on the Setup page.
 */
export function StagesStep({
  info,
  workflowIds,
  ui,
  drafts,
  agents,
  rules,
  onChange,
  onRulesChange,
}: {
  info: InstallInfo;
  workflowIds: string[];
  ui: boolean;
  drafts: Record<string, WorkflowDraft>;
  agents: SetupAgents;
  rules: Record<string, string>;
  onChange: (id: string, draft: WorkflowDraft) => void;
  onRulesChange: (stageId: string, text: string) => void;
}) {
  return (
    <Tabs defaultValue={workflowIds[0]}>
      <TabsList className="h-auto flex-wrap">
        {workflowIds.map((id) => (
          <TabsTrigger key={id} value={id}>
            {info.workflows.find((w) => w.id === id)?.name ?? id}
          </TabsTrigger>
        ))}
      </TabsList>
      {workflowIds.map((id) => {
        const draft = drafts[id];
        if (!draft) return null;
        const { view, merge } = visibleDraft(draft, ui);
        return (
          <TabsContent key={id} value={id} className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Open a stage to change its enforcement, confirmation, agent and rules. Drag to
              reorder.
              {!ui && ' Stages for a UI are left out: this repo has no UI.'}
            </p>
            <StageList
              draft={view}
              agents={agents}
              rules={(stageId) => ({ text: rules[stageId] ?? '', exists: true })}
              onChange={(next) => onChange(id, merge(next))}
              onRulesChange={onRulesChange}
            />
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
