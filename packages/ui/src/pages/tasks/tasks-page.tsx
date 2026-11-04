import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ChangesList, TaskPanel } from '@/components/task-panel';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';

export default function TasksPage() {
  // Kept fresh by SSE `tasks` events; the first load comes from GET /api/tasks.
  const { data, error, isPending } = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: api.tasks,
    staleTime: Infinity,
  });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load tasks</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {data.configError && (
        <Alert variant="destructive">
          <AlertTitle>config.yml does not parse</AlertTitle>
          <AlertDescription>
            {data.configError} Tasks are empty until the file is fixed.
          </AlertDescription>
        </Alert>
      )}
      {data.tasks.length === 0 && !data.configError && (
        <p className="text-sm text-muted-foreground">No unfinished tasks.</p>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {data.tasks.map((task) => (
          <TaskPanel key={task.dir} task={task} />
        ))}
      </div>
      <ChangesList changes={data.changes} />
    </div>
  );
}
