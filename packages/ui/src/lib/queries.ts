import { useEffect, useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accessIssueStore, api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { AccessIssue, ClaimBody, PromptEvent, Task } from '@/lib/types';

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

/** Why this device is locked out (not paired, phone access off, wrong Tailscale user, revoked), or null. */
export function useAccessIssue(): AccessIssue | null {
  return useSyncExternalStore(accessIssueStore.subscribe, accessIssueStore.get);
}

/** GET /api/remote: phone access state and the paired devices. */
export function useRemote(enabled = true, fast = false) {
  return useQuery({
    queryKey: queryKeys.remote,
    queryFn: api.remote,
    enabled,
    // `fast` while a pairing is open, so "pairing cancelled" shows up quickly.
    refetchInterval: fast ? 3_000 : 15_000,
  });
}

/** The Phone access panel's actions: switch, pair, claim and revoke. Each refreshes GET /api/remote. */
export function useRemoteMutations() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.remote });
  return {
    setEnabled: useMutation({
      mutationFn: (enabled: boolean) => api.setRemote(enabled),
      onSettled: refresh,
    }),
    pair: useMutation({ mutationFn: () => api.createPairing(), onSettled: refresh }),
    claim: useMutation({
      mutationFn: (v: ClaimBody) => api.claimPairing(v),
    }),
    revoke: useMutation({
      mutationFn: (id: string) => api.revokeDevice(id),
      onSettled: refresh,
    }),
  };
}
