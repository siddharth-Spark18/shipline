import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { PromptEvent, Task } from '@/lib/types';

/** Kept fresh by SSE `tasks` events; the first load comes from GET /api/tasks. */
export function useTasks() {
  return useQuery({ queryKey: queryKeys.tasks, queryFn: api.tasks, staleTime: Infinity });
}

/** Pending permission/question prompts, pushed over SSE into the query cache. */
export function usePrompts(): PromptEvent[] {
  const { data = [] } = useQuery<PromptEvent[]>({
    queryKey: queryKeys.prompts,
    queryFn: () => [],
    staleTime: Infinity,
    gcTime: Infinity,
    enabled: false,
    initialData: [],
  });
  return data;
}

const normDir = (p: string) => p.replace(/\/+$/, '');

/** The task whose folder a chat works in. Both sides are absolute store paths, compared as opaque ids. */
export function findTask(tasks: Task[] | undefined, taskDir: string | null | undefined) {
  if (!tasks || !taskDir) return undefined;
  const dir = normDir(taskDir);
  return tasks.find((t) => normDir(t.dir) === dir);
}

/** True while the viewport matches the media query. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
