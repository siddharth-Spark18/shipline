import { Link } from 'react-router-dom';
import { Archive, ArchiveRestore, Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import EmptyState from '@/components/shared/empty-state';
import { errorMessage } from '@/lib/api';
import { useArchiveTemplate, useDeleteTemplate, useTemplateList } from '@/services/admin/admin.hooks';
import { TemplateSummary } from '@/services/admin/admin.types';
import { downloadTemplate } from '../templates/export-file';
import ImportTemplateDialog from './import-template-dialog';

/** The org's template library: active and archived templates with their latest version and how much they are used. */
export default function TemplatesTab() {
  const { data, isPending } = useTemplateList();
  const archive = useArchiveTemplate();
  const remove = useDeleteTemplate();

  const run = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      toast.success(done);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const row = (t: TemplateSummary) => (
    <TableRow key={t.id} className={t.archived ? 'opacity-60' : undefined}>
      <TableCell className="max-w-80 whitespace-normal">
        <Link to={`/admin/templates/${t.id}`} className="font-medium hover:underline">
          {t.name}
        </Link>
        {t.builtIn && (
          <Badge variant="outline" className="ml-2">
            built-in
          </Badge>
        )}
        <p className="text-xs text-muted-foreground">{t.description}</p>
      </TableCell>
      <TableCell>{t.archived ? <Badge variant="secondary">Archived</Badge> : <Badge>Active</Badge>}</TableCell>
      <TableCell>v{t.latestVersion}</TableCell>
      <TableCell>{t.stageCount}</TableCell>
      <TableCell title="Chats still running / chats on any version">
        {t.activeChatCount} / {t.chatCount}
      </TableCell>
      <TableCell>{t.projectCount}</TableCell>
      <TableCell className="text-right whitespace-nowrap">
        <Button size="icon-xs" variant="ghost" aria-label={`Edit ${t.name}`} asChild>
          <Link to={`/admin/templates/${t.id}`}>
            <Pencil />
          </Link>
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Export ${t.name}`}
          onClick={() => void run(() => downloadTemplate(t.id, t.name), 'Exported')}
        >
          <Download />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t.archived ? `Restore ${t.name}` : `Archive ${t.name}`}
          title={t.archived ? 'Restore' : 'Archive: it can no longer be picked for new chats'}
          onClick={() => void run(() => archive.mutateAsync({ id: t.id, archive: !t.archived }), t.archived ? 'Restored' : 'Archived')}
        >
          {t.archived ? <ArchiveRestore /> : <Archive />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Delete ${t.name}`}
          disabled={t.chatCount > 0}
          title={t.chatCount > 0 ? 'Chats use this template: archive it instead' : 'Delete'}
          onClick={() => void run(() => remove.mutateAsync(t.id), 'Deleted')}
        >
          <Trash2 />
        </Button>
      </TableCell>
    </TableRow>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Workflow templates</CardTitle>
          <CardDescription>
            Saving a template creates a new immutable version; a chat stays on the version it started on. A template that any chat has used can only be archived.
            Projects choose which templates they offer under their settings.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <ImportTemplateDialog
            trigger={
              <Button variant="outline">
                <Upload /> Import
              </Button>
            }
          />
          <Button asChild>
            <Link to="/admin/templates/new">
              <Plus /> New template
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className="h-24" />
        ) : data && data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Template</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Stages</TableHead>
                <TableHead>Chats (running / all)</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>{data.map(row)}</TableBody>
          </Table>
        ) : (
          <EmptyState message="No templates yet. Run the database seed to create Feature and Hotfix, or create one." />
        )}
      </CardContent>
    </Card>
  );
}
