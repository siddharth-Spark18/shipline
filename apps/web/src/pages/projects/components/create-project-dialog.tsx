import { ReactNode, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import { useCreateProject } from '@/services/projects/projects.hooks';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  githubRepo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'Use owner/name'),
  jiraProjectKey: z.string().trim().min(1, 'Jira project key is required'),
  keyPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, '2-10 letters or digits, starting with a letter'),
});

export default function CreateProjectDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const create = useCreateProject();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', githubRepo: '', jiraProjectKey: '', keyPrefix: '' } });

  const submit = form.handleSubmit((values) =>
    create.mutate(values, {
      onSuccess: () => {
        toast.success('Project created');
        form.reset();
        setOpen(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
              <DialogDescription>Register a GitHub repository, its Jira project and the prefix for its chat keys.</DialogDescription>
            </DialogHeader>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="githubRepo"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>GitHub repository</FormLabel>
                  <FormControl>
                    <Input placeholder="owner/name" {...field} />
                  </FormControl>
                  <FormDescription>Shipline Local only starts sessions in registered repos.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="jiraProjectKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Jira project key</FormLabel>
                  <FormControl>
                    <Input placeholder="ABC" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="keyPrefix"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Chat key prefix</FormLabel>
                  <FormControl>
                    <Input placeholder="LL" {...field} />
                  </FormControl>
                  <FormDescription>Every chat gets a key from it, e.g. LL-12. Existing keys never change if you edit it later.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
