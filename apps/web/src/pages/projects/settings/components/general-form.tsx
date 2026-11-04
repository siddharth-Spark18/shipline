import type { InputHTMLAttributes } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '@/lib/api';
import { useUpdateProject } from '@/services/projects/projects.hooks';
import { ProjectDetail } from '@/services/projects/projects.types';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  jiraProjectKey: z.string().trim().min(1, 'Jira project key is required'),
  keyPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, '2-10 letters or digits, starting with a letter'),
  baseBranch: z.string().trim().min(1, 'Base branch is required'),
  sessionMode: z.enum(['CHAT', 'TERMINAL']),
  minPluginVersion: z.string().trim(),
  minClaudeCliVersion: z.string().trim(),
  qaKind: z.enum(['preview_url', 'local_run', 'staging']),
  qaUrl: z.string().trim(),
  qaCommand: z.string().trim(),
  commitArtifactsToRepo: z.boolean(),
  artifactRepoPath: z.string().trim(),
  artifactBranch: z.string().trim(),
});
type Values = z.infer<typeof schema>;

export default function GeneralForm({ project, readOnly }: { project: ProjectDetail; readOnly: boolean }) {
  const update = useUpdateProject(project.id);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: project.name,
      jiraProjectKey: project.jiraProjectKey,
      keyPrefix: project.keyPrefix,
      baseBranch: project.baseBranch,
      sessionMode: project.sessionMode,
      minPluginVersion: project.minPluginVersion ?? '',
      minClaudeCliVersion: project.minClaudeCliVersion ?? '',
      qaKind: project.qaTarget?.kind ?? 'preview_url',
      qaUrl: project.qaTarget?.url ?? '',
      qaCommand: project.qaTarget?.command ?? '',
      commitArtifactsToRepo: project.commitArtifactsToRepo,
      artifactRepoPath: project.artifactRepoPath,
      artifactBranch: project.artifactBranch ?? '',
    },
  });
  const qaKind = form.watch('qaKind');
  const commit = form.watch('commitArtifactsToRepo');

  const submit = form.handleSubmit((v) =>
    update.mutate(
      {
        name: v.name,
        jiraProjectKey: v.jiraProjectKey,
        keyPrefix: v.keyPrefix,
        baseBranch: v.baseBranch,
        sessionMode: v.sessionMode,
        minPluginVersion: v.minPluginVersion || null,
        minClaudeCliVersion: v.minClaudeCliVersion || null,
        commitArtifactsToRepo: v.commitArtifactsToRepo,
        artifactRepoPath: v.artifactRepoPath,
        artifactBranch: v.artifactBranch || null,
        qaTarget: { kind: v.qaKind, url: v.qaUrl || undefined, command: v.qaCommand || undefined },
      },
      { onSuccess: () => toast.success('Saved'), onError: (err) => toast.error(errorMessage(err)) },
    ),
  );

  const text = (name: keyof Values, label: string, props: { placeholder?: string; description?: string } = {}) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input placeholder={props.placeholder} {...(field as unknown as InputHTMLAttributes<HTMLInputElement>)} />
          </FormControl>
          {props.description && <FormDescription>{props.description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Repository, branches, versions and the QA target.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-4">
            <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
              {text('name', 'Name')}
              {text('jiraProjectKey', 'Jira project key')}
              {text('keyPrefix', 'Chat key prefix', { placeholder: 'LL', description: 'Chats are keyed LL-1, LL-2, ... Changing it only affects new chats.' })}
              {text('baseBranch', 'Base branch', { description: 'Chat worktrees start here (detached); diffs are measured against it.' })}
              <FormField
                control={form.control}
                name="sessionMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Default session mode</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="CHAT">Chat (stream-json)</SelectItem>
                        <SelectItem value="TERMINAL">Embedded terminal (fallback)</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              {text('minPluginVersion', 'Minimum plugin version', { placeholder: '0.2.0', description: 'Submissions from older plugin/app versions are blocked.' })}
              {text('minClaudeCliVersion', 'Minimum Claude CLI version', { placeholder: '2.1.0' })}
              <FormField
                control={form.control}
                name="qaKind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>QA target</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="preview_url">Preview URL</SelectItem>
                        <SelectItem value="local_run">Local run</SelectItem>
                        <SelectItem value="staging">Staging</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              {qaKind === 'local_run' ? text('qaCommand', 'Run command') : text('qaUrl', 'URL')}
              <FormField
                control={form.control}
                name="commitArtifactsToRepo"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-3 sm:col-span-2">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <FormLabel>Also commit stage artifacts to the repository when a stage is completed</FormLabel>
                  </FormItem>
                )}
              />
              {commit && text('artifactRepoPath', 'Artifact path in repo')}
              {commit && text('artifactBranch', 'Artifact branch', { description: "Empty = the repository's default branch." })}
            </fieldset>
            {!readOnly && (
              <Button type="submit" disabled={update.isPending}>
                Save
              </Button>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
