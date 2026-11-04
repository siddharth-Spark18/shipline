import { useState } from 'react';
import { toast } from 'sonner';
import PairingDialog from '@/components/local/pairing-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { useCloneProject, useLocalProjects, useLocalReady, useSetProjectPath, useSetSessionMode } from '@/services/local/local.hooks';
import { LocalProject, SessionModeName } from '@/services/local/local.types';

/**
 * This person's local folder (working copy) for the project, kept by Shipline Local on their own
 * computer. Per person, so every member can set it, not only project admins.
 */
export default function LocalFolderCard({ projectId }: { projectId: string }) {
  const { state } = useLocalReady();
  const projects = useLocalProjects(state === 'ready');
  const project = projects.data?.find((p) => p.id === projectId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Local folder</CardTitle>
        <CardDescription>
          The clone of this project's repository on your computer. Only you see this setting. Each chat gets its own git worktree
          next to it, in {'<folder>'}.shipline/KEY.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state === 'checking' || (state === 'ready' && projects.isPending) ? (
          <Skeleton className="h-24" />
        ) : state === 'unreachable' ? (
          <p className="text-sm text-muted-foreground">Shipline Local is not running. Open the Shipline tray app or run `pnpm dev:local`.</p>
        ) : state === 'needs-pairing' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            Pair this browser with Shipline Local to choose a folder. <PairingDialog />
          </div>
        ) : project ? (
          <FolderForm key={project.localPath ?? ''} project={project} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {projects.error ? errorMessage(projects.error) : 'Shipline Local does not list this project. Make sure you are a member and signed in.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function FolderForm({ project }: { project: LocalProject }) {
  const setPath = useSetProjectPath();
  const clone = useCloneProject();
  const setMode = useSetSessionMode();
  const [path, setPathValue] = useState(project.localPath ?? '');
  const busy = setPath.isPending || clone.isPending;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="local-path" className="flex items-center gap-2">
          Folder (absolute path)
          {project.localPath && <Badge variant="secondary">configured</Badge>}
        </Label>
        <Input id="local-path" value={path} onChange={(e) => setPathValue(e.target.value)} placeholder="/Users/you/code/repo" />
        <p className="text-xs text-muted-foreground">Must be a clone of {project.githubRepo}.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!path || busy}
          onClick={() => setPath.mutate({ projectId: project.id, path }, { onSuccess: () => toast.success('Saved'), onError: (e) => toast.error(errorMessage(e)) })}
        >
          Use this folder
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!path || busy}
          onClick={() =>
            clone.mutate(
              { projectId: project.id, path, githubRepo: project.githubRepo },
              { onSuccess: () => toast.success('Cloned'), onError: (e) => toast.error(errorMessage(e)) },
            )
          }
        >
          Clone repo here
        </Button>
        <Select
          value={project.localSessionMode ?? 'default'}
          onValueChange={(v) => setMode.mutate({ projectId: project.id, mode: v === 'default' ? null : (v as SessionModeName) })}
        >
          <SelectTrigger size="sm" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Session mode: project default ({project.sessionMode})</SelectItem>
            <SelectItem value="chat">Session mode: chat</SelectItem>
            <SelectItem value="terminal">Session mode: embedded terminal</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
