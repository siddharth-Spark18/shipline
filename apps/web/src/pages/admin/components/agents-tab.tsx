import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { CustomAgentDTO } from '@shipline/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import EmptyState from '@/components/shared/empty-state';
import { errorMessage } from '@/lib/api';
import { useAgents, useDeleteAgent } from '@/services/admin/admin.hooks';
import AgentDialog from './agent-dialog';

/** Custom agents (stages can name them) and, read-only, the agents bundled in the Shipline plugin. */
export default function AgentsTab() {
  const { data, isPending } = useAgents();
  const remove = useDeleteAgent();
  const [dialog, setDialog] = useState<{ agent?: CustomAgentDTO } | null>(null);

  const del = async (agent: CustomAgentDTO) => {
    try {
      await remove.mutateAsync(agent.id);
      toast.success(`Deleted ${agent.name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Custom agents</CardTitle>
            <CardDescription>
              Defined here, usable by any workflow stage. Agents in a repo's own <code>.claude/</code> still load as usual but cannot be chosen per stage yet.
            </CardDescription>
          </div>
          <Button onClick={() => setDialog({})}>
            <Plus /> New agent
          </Button>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <Skeleton className="h-24" />
          ) : data && data.custom.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Tools</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.custom.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono">{a.name}</TableCell>
                    <TableCell className="max-w-72 whitespace-normal">{a.description}</TableCell>
                    <TableCell className="max-w-48 whitespace-normal text-muted-foreground">{a.tools.join(', ') || 'inherits'}</TableCell>
                    <TableCell>{a.model ?? <span className="text-muted-foreground">default</span>}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="icon-xs" variant="ghost" aria-label={`Edit ${a.name}`} onClick={() => setDialog({ agent: a })}>
                        <Pencil />
                      </Button>
                      <Button size="icon-xs" variant="ghost" aria-label={`Delete ${a.name}`} onClick={() => void del(a)}>
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState message="No custom agents yet." />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Plugin agents</CardTitle>
          <CardDescription>Bundled with the Shipline plugin; stages can name them without any setup.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y text-sm">
            {data?.plugin.map((a) => (
              <li key={a.name} className="flex items-center gap-3 py-2">
                <Badge variant="outline" className="font-mono">
                  {a.name}
                </Badge>
                <span className="text-muted-foreground">{a.description}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <AgentDialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)} agent={dialog?.agent} />
    </div>
  );
}
