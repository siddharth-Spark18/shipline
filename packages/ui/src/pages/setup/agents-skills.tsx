import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { ChangesView } from '@/components/changes-view';
import { FileNotes, isError, previewChanges } from '@/pages/setup/save-dialog';
import { ApiError, api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { AgentsChange, ConfigModel, SetupData } from '@/lib/types';

const agentPath = (name: string) => `.claude/agents/${name}.md`;

/** "workflow.stage" for every stage whose agent is one of `names`. */
function affectedStages(data: SetupData, names: string[]): string[] {
  const out: string[] = [];
  for (const wf of data.workflows) {
    for (const s of wf.model?.stages ?? []) {
      if (s.agent && names.includes(s.agent)) out.push(`${wf.id}.${s.id}`);
    }
  }
  return out;
}

/**
 * Setup > Agents & skills. Shipline's agents are added or removed through their own
 * preview-and-confirm save (POST /api/setup/agents); the repo's skills go into the config.yml
 * draft and are saved with the page's usual "Review and save".
 */
export function AgentsSkills({
  data,
  config,
  onConfigChange,
  readOnly,
  hasOtherEdits,
  onReload,
}: {
  data: SetupData;
  config: ConfigModel | null;
  onConfigChange: (model: ConfigModel) => void;
  readOnly: boolean;
  /** The page has unsaved edits that a reload after saving agents would discard. */
  hasOtherEdits: boolean;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  // Desired state per Shipline agent, only where it differs from what is on disk.
  const [want, setWant] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);

  const agents = data.agents.shipline;
  const isOn = (a: SetupData['agents']['shipline'][number]) => a.installed && !a.excluded;
  const own = (a: SetupData['agents']['shipline'][number]) => a.installed && a.excluded;

  const change = useMemo<AgentsChange | null>(() => {
    const add: string[] = [];
    const remove: string[] = [];
    for (const a of agents) {
      const w = want[a.name];
      if (w === undefined || w === isOn(a)) continue;
      (w ? add : remove).push(a.name);
    }
    if (add.length === 0 && remove.length === 0) return null;
    const baseHashes: Record<string, string | null> = {};
    for (const a of agents) {
      if (add.includes(a.name) || remove.includes(a.name)) baseHashes[agentPath(a.name)] = a.hash;
    }
    return {
      ...(add.length ? { add } : {}),
      ...(remove.length ? { remove } : {}),
      baseVersionHash: data.versionHash,
      baseHashes,
    };
  }, [agents, want, data.versionHash]);

  const preview = useMutation({
    mutationFn: (req: AgentsChange) => api.agentsPreview(req),
    onSuccess: () => setOpen(true),
  });
  const apply = useMutation({
    mutationFn: (req: AgentsChange) => api.agentsApply(req),
    onSuccess: async () => {
      setOpen(false);
      setWant({});
      toast.success('Saved. Commit these files so teammates get the change.');
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });

  const setAgent = (name: string, on: boolean, current: boolean) =>
    setWant((w) => {
      const next = { ...w };
      if (on === current) delete next[name];
      else next[name] = on;
      return next;
    });

  // --- skills ---
  const selected = config?.skills ?? [];
  const missing = selected.filter((s) => !data.skills.repo.includes(s));
  const setSkills = (names: string[]) => {
    if (!config) return;
    const next = { ...config };
    if (names.length === 0) delete next.skills;
    else next.skills = names;
    onConfigChange(next);
  };

  const removing = change?.remove ?? [];
  const stages = affectedStages(data, removing);
  const previewData = preview.data;
  const applyError = apply.error;
  const conflict = applyError instanceof ApiError && applyError.status === 409;
  const previewHasErrors = !!previewData?.files.some((f) => f.errors.some(isError));

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-sm font-medium">Agents &amp; skills</h2>

      <section className="flex flex-col gap-3" aria-labelledby="agents-heading">
        <div>
          <h3 id="agents-heading" className="text-sm font-medium">
            Shipline agents
          </h3>
          <p className="text-xs text-muted-foreground">
            Installed into .claude/agents. Removing one keeps it out of this repo, including after
            an upgrade.
          </p>
        </div>
        <ul className="flex flex-col divide-y rounded-lg border bg-card">
          {agents.map((a) => {
            const w = want[a.name];
            const current = isOn(a);
            const checked = w ?? current;
            const id = `agent-${a.name}`;
            return (
              <li key={a.name} className="flex flex-wrap items-center gap-3 px-3 py-2">
                {own(a) ? (
                  <>
                    <span className="font-mono text-sm">{a.name}</span>
                    {w ? (
                      <Badge variant="secondary">Will be replaced by Shipline's</Badge>
                    ) : (
                      <Badge variant="outline">Your own agent</Badge>
                    )}
                    <Button
                      variant="outline"
                      size="xs"
                      className="ml-auto"
                      disabled={readOnly}
                      onClick={() => setAgent(a.name, !w, false)}
                    >
                      {w ? 'Keep yours' : "Use Shipline's version"}
                    </Button>
                  </>
                ) : (
                  <>
                    <Switch
                      id={id}
                      checked={checked}
                      disabled={readOnly}
                      onCheckedChange={(on) => setAgent(a.name, on, current)}
                    />
                    <Label htmlFor={id} className="font-mono">
                      {a.name}
                    </Label>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {w === undefined
                        ? current
                          ? 'Installed'
                          : 'Not installed'
                        : checked
                          ? 'Will be added'
                          : 'Will be removed'}
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!change || readOnly || preview.isPending}
            onClick={() => change && preview.mutate(change)}
          >
            {preview.isPending ? 'Preparing preview...' : 'Review and save agents'}
          </Button>
          {change && (
            <Button variant="outline" size="sm" onClick={() => setWant({})}>
              Undo
            </Button>
          )}
          {change && hasOtherEdits && (
            <span className="text-xs text-muted-foreground">
              Saving agents reloads the files from disk and discards your other unsaved edits on
              this page.
            </span>
          )}
        </div>
        {preview.error && !open && (
          <p className="text-sm text-destructive">{preview.error.message}</p>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="skills-heading">
        <div>
          <h3 id="skills-heading" className="text-sm font-medium">
            Your skills
          </h3>
          <p className="text-xs text-muted-foreground">
            Skills from this repo's .claude/skills. The ones you tick are listed at every stage, so
            Claude knows it can use them. Saved in config.yml with Review and save at the top.
          </p>
        </div>
        {!config ? (
          <p className="text-sm text-muted-foreground">
            config.yml does not parse, so skills can't be edited here.
          </p>
        ) : data.skills.repo.length === 0 && missing.length === 0 ? (
          <p className="text-sm text-muted-foreground">This repo has no skills of its own.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border bg-card">
            {[...data.skills.repo, ...missing].map((name) => {
              const isMissing = missing.includes(name);
              const id = `skill-${name}`;
              return (
                <li key={name} className="flex items-center gap-3 px-3 py-2">
                  <Checkbox
                    id={id}
                    checked={selected.includes(name)}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                      setSkills(on ? [...selected, name] : selected.filter((s) => s !== name))
                    }
                  />
                  <Label htmlFor={id} className="font-mono">
                    {name}
                  </Label>
                  {isMissing && (
                    <span className="text-xs text-enf-warn">
                      No .claude/skills/{name} folder in this repo
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            apply.reset();
            preview.reset();
          }
        }}
      >
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Review agent changes</DialogTitle>
            <DialogDescription>
              Nothing is written until you save. Shipline never commits for you.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <div className="flex flex-col gap-4 pr-3">
              {stages.length > 0 && (
                <Alert>
                  <AlertTitle>Stages that use a removed agent</AlertTitle>
                  <AlertDescription>
                    {stages.join(', ')}. The save goes ahead; these stages show "agent not
                    installed" in the stage editor until you pick another agent.
                  </AlertDescription>
                </Alert>
              )}
              {previewData && <FileNotes files={previewData.files} />}
              {previewData && (
                <ChangesView changes={previewChanges(previewData.files)} defaultExpanded />
              )}
              {previewData && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    VERSION file after saving
                  </summary>
                  <pre className="mt-1 overflow-auto rounded-md border bg-muted p-2 font-mono">
                    {JSON.stringify(previewData.version.after, null, 2)}
                  </pre>
                </details>
              )}
              {conflict && (
                <Alert variant="destructive">
                  <AlertTitle>Files changed on disk</AlertTitle>
                  <AlertDescription>
                    An agent file or VERSION was changed outside this page, so nothing was written.
                    Reload to see the current files; your edits on this page will be discarded.
                    <div className="mt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setOpen(false);
                          apply.reset();
                          setWant({});
                          onReload();
                        }}
                      >
                        Reload from disk
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              {applyError && !conflict && (
                <Alert variant="destructive">
                  <AlertTitle>Save failed</AlertTitle>
                  <AlertDescription>{applyError.message}</AlertDescription>
                </Alert>
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!change || !previewData || previewHasErrors || apply.isPending || readOnly}
              onClick={() => change && apply.mutate(change)}
            >
              {apply.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
