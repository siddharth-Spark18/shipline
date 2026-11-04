import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { CustomAgentDTO, validateAgentInput } from '@shipline/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { useSaveAgent } from '@/services/admin/admin.hooks';

interface AgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The agent being edited; undefined for a new one. */
  agent?: CustomAgentDTO;
}

const parseTools = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

/** Name, description, prompt, allowed tools and an optional model. The name is fixed once the agent exists. */
export default function AgentDialog({ open, onOpenChange, agent }: AgentDialogProps) {
  const save = useSaveAgent();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [tools, setTools] = useState('');
  const [model, setModel] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(agent?.name ?? '');
    setDescription(agent?.description ?? '');
    setPrompt(agent?.prompt ?? '');
    setTools(agent?.tools.join(', ') ?? '');
    setModel(agent?.model ?? '');
    setProblem(null);
  }, [open, agent]);

  const submit = async () => {
    const input = { name: name.trim(), description, prompt, tools: parseTools(tools), model: model.trim() || null };
    const issue = validateAgentInput(input, !agent);
    setProblem(issue);
    if (issue) return;
    try {
      await save.mutateAsync({ id: agent?.id ?? null, input });
      toast.success(agent ? 'Agent saved' : 'Agent created');
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{agent ? `Edit ${agent.name}` : 'New custom agent'}</DialogTitle>
          <DialogDescription>
            A stage can name this agent. Shipline Local hands it to Claude Code with the <code>--agents</code> flag when a chat starts.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input id="agent-name" value={name} disabled={!!agent} placeholder="security-reviewer" onChange={(e) => setName(e.target.value)} className="font-mono" />
            <p className="text-xs text-muted-foreground">Lowercase letters, digits and hyphens. It cannot be changed later: stages and Claude address the agent by it.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-description">Description</Label>
            <Input id="agent-description" value={description} placeholder="Reviews the diff for security issues" onChange={(e) => setDescription(e.target.value)} />
            <p className="text-xs text-muted-foreground">Claude reads this to decide when to call the agent.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-prompt">Prompt</Label>
            <Textarea id="agent-prompt" rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="agent-tools">Allowed tools</Label>
              <Input id="agent-tools" value={tools} placeholder="Read, Grep, Glob" onChange={(e) => setTools(e.target.value)} />
              <p className="text-xs text-muted-foreground">Comma-separated. Empty: the agent inherits the session's tools.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-model">Model (optional)</Label>
              <Input id="agent-model" value={model} placeholder="sonnet" onChange={(e) => setModel(e.target.value)} />
            </div>
          </div>
          {problem && <p className="text-sm text-destructive">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
