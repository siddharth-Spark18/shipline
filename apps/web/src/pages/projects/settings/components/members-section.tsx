import { useMemo } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ROLES, ROLE_LABELS, Role } from '@shipline/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import DataTable from '@/components/shared/data-table';
import { errorMessage } from '@/lib/api';
import { useRemoveMember, useUpsertMember } from '@/services/projects/projects.hooks';
import { ProjectDetail, ProjectMemberRow } from '@/services/projects/projects.types';

const schema = z.object({
  email: z.string().trim().email('Enter an email address'),
  roles: z.array(z.enum(ROLES)),
  isAdmin: z.boolean(),
});

export default function MembersSection({ project, readOnly }: { project: ProjectDetail; readOnly: boolean }) {
  const upsert = useUpsertMember(project.id);
  const remove = useRemoveMember(project.id);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: '', roles: [], isAdmin: false } });

  const columns = useMemo<ColumnDef<ProjectMemberRow, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Member',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.name}</p>
            <p className="text-xs text-muted-foreground">{row.original.email}</p>
          </div>
        ),
      },
      {
        accessorKey: 'roles',
        header: 'Roles',
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.roles.map((r) => (
              <Badge key={r} variant="secondary">
                {ROLE_LABELS[r]}
              </Badge>
            ))}
            {row.original.isAdmin && <Badge>Admin</Badge>}
          </div>
        ),
      },
      {
        accessorKey: 'githubLogin',
        header: 'GitHub',
        cell: ({ getValue }) => (getValue() as string | null) ?? <span className="text-muted-foreground">not linked</span>,
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          readOnly ? null : (
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending && remove.variables === row.original.userId}
              onClick={() => remove.mutate(row.original.userId, { onError: (err) => toast.error(errorMessage(err)) })}
            >
              Remove
            </Button>
          ),
      },
    ],
    [remove, readOnly],
  );

  const submit = form.handleSubmit((v) =>
    upsert.mutate(v, {
      onSuccess: () => {
        toast.success('Member saved');
        form.reset();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members and roles</CardTitle>
        <CardDescription>Roles decide what a person may do in the repo and which stages they can work. Jira decides who owns a ticket.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataTable columns={columns} data={project.members} emptyMessage="No members." />
        {!readOnly && (
          <Form {...form}>
            <form onSubmit={submit} className="space-y-3 border-t pt-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Add or update member by email</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex flex-wrap items-center gap-4 text-sm">
                {ROLES.map((role: Role) => (
                  <FormField
                    key={role}
                    control={form.control}
                    name="roles"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center gap-2">
                        <FormControl>
                          <Checkbox
                            checked={field.value.includes(role)}
                            onCheckedChange={(checked) =>
                              field.onChange(checked ? [...field.value, role] : field.value.filter((r) => r !== role))
                            }
                          />
                        </FormControl>
                        <FormLabel className="font-normal">{ROLE_LABELS[role]}</FormLabel>
                      </FormItem>
                    )}
                  />
                ))}
                <FormField
                  control={form.control}
                  name="isAdmin"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center gap-2">
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <FormLabel className="font-normal">Project admin</FormLabel>
                    </FormItem>
                  )}
                />
              </div>
              <Button type="submit" disabled={upsert.isPending}>
                Save member
              </Button>
            </form>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
