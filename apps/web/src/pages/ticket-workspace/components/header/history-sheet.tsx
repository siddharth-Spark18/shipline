import { ColumnDef } from '@tanstack/react-table';
import { History } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import DataTable from '@/components/shared/data-table';
import { formatDateTime } from '@/lib/formatters';
import { useTicketAudit, useTicketToolDecisions } from '@/services/tickets/tickets.hooks';
import { AuditEventRow, ToolDecisionRow } from '@/services/tickets/tickets.types';

const auditColumns: ColumnDef<AuditEventRow, unknown>[] = [
  { accessorKey: 'createdAt', header: 'When', cell: ({ getValue }) => formatDateTime(getValue() as string) },
  { accessorKey: 'type', header: 'Event' },
  { id: 'actor', header: 'By', cell: ({ row }) => row.original.actor?.name ?? 'system' },
  {
    accessorKey: 'data',
    header: 'Details',
    cell: ({ getValue }) => <code className="text-xs text-muted-foreground">{JSON.stringify(getValue() as Record<string, unknown>)}</code>,
  },
];

const decisionColumns: ColumnDef<ToolDecisionRow, unknown>[] = [
  { accessorKey: 'createdAt', header: 'When', cell: ({ getValue }) => formatDateTime(getValue() as string) },
  { accessorKey: 'stage', header: 'Stage' },
  { accessorKey: 'inputSummary', header: 'Tool request', cell: ({ getValue }) => <code className="text-xs">{getValue() as string}</code> },
  {
    accessorKey: 'decision',
    header: 'Decision',
    cell: ({ row }) => (
      <Badge variant={row.original.decision === 'ALLOW' ? 'secondary' : row.original.decision === 'DENY' ? 'destructive' : 'outline'}>
        {row.original.decision} ({row.original.decidedBy.toLowerCase()})
      </Badge>
    ),
  },
  { accessorKey: 'reason', header: 'Reason' },
];

function Audit({ ticketId }: { ticketId: string }) {
  const { data, isPending } = useTicketAudit(ticketId);
  return <DataTable columns={auditColumns} data={data ?? []} isLoading={isPending} emptyMessage="No events yet." />;
}

function Decisions({ ticketId }: { ticketId: string }) {
  const { data, isPending } = useTicketToolDecisions(ticketId);
  return <DataTable columns={decisionColumns} data={data ?? []} isLoading={isPending} emptyMessage="No tool decisions logged." />;
}

/** Audit trail (stage transitions, overrides, artifacts) and every tool permission decision. */
export default function HistorySheet({ ticketId }: { ticketId: string }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="xs" variant="ghost">
          <History /> History
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Chat history</SheetTitle>
          <SheetDescription>Everything is recorded: who proposed and confirmed each stage change, and every tool decision.</SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="audit" className="px-4 pb-4">
          <TabsList>
            <TabsTrigger value="audit">Audit</TabsTrigger>
            <TabsTrigger value="tools">Tool decisions</TabsTrigger>
          </TabsList>
          <TabsContent value="audit">
            <Audit ticketId={ticketId} />
          </TabsContent>
          <TabsContent value="tools">
            <Decisions ticketId={ticketId} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
