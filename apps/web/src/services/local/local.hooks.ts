import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DiffMode } from '@shipline/shared';
import { LocalApiError, setLocalToken } from '@/lib/local-api';
import { LocalService } from './local.service';
import { DiffFileInput, LocalConnectionState, localKeys } from './local.types';

/**
 * Where the local service stands, probed continuously so the workspace can show the "Start Shipline
 * Local" banner and recover by itself (it retries every few seconds while the service is down).
 */
export function useLocalConnection() {
  const hello = useQuery({
    queryKey: localKeys.hello(),
    queryFn: LocalService.hello,
    refetchInterval: 3_000,
    retry: false,
  });
  const reachable = hello.isSuccess;
  const status = useQuery({
    queryKey: localKeys.status(),
    queryFn: LocalService.getStatus,
    enabled: reachable,
    refetchInterval: 5_000,
    retry: false,
  });

  const notPaired = status.error instanceof LocalApiError && status.error.status === 401;
  let state: LocalConnectionState = 'checking';
  if (hello.isError) state = 'unreachable';
  else if (reachable && notPaired) state = 'needs-pairing';
  else if (reachable && status.isSuccess) state = 'ready';
  return { state, status: status.data ?? null, hello: hello.data ?? null };
}

export function useLocalSessions(enabled: boolean) {
  return useQuery({ queryKey: localKeys.sessions(), queryFn: LocalService.getSessions, enabled, refetchInterval: 3_000, retry: false });
}

export function useLocalProjects(enabled: boolean) {
  return useQuery({ queryKey: localKeys.projects(), queryFn: LocalService.getProjects, enabled, retry: false });
}

export function usePairLocal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: LocalService.pair,
    onSuccess: (token) => {
      setLocalToken(token);
      return qc.invalidateQueries({ queryKey: ['local'] });
    },
  });
}

export function useStartLogin() {
  return useMutation({ mutationFn: LocalService.startLogin });
}

export function useLocalLogout() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: LocalService.logout, onSuccess: () => qc.invalidateQueries({ queryKey: localKeys.status() }) });
}

export function useStartSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: LocalService.startSession,
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: localKeys.sessions() }), qc.invalidateQueries({ queryKey: ['tickets'] })]),
  });
}

export function useStopSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: LocalService.stopSession,
    onSuccess: () => qc.invalidateQueries({ queryKey: localKeys.sessions() }),
  });
}

export function useSendMessage() {
  return useMutation({ mutationFn: LocalService.sendMessage });
}

export function useResolvePrompt() {
  return useMutation({ mutationFn: LocalService.resolvePrompt });
}

export function useSetProjectPath() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: LocalService.setPath, onSuccess: () => qc.invalidateQueries({ queryKey: localKeys.projects() }) });
}

export function useCloneProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: LocalService.clone, onSuccess: () => qc.invalidateQueries({ queryKey: localKeys.projects() }) });
}

export function useSetSessionMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: LocalService.setSessionMode,
    onSuccess: () => qc.invalidateQueries({ queryKey: localKeys.projects() }),
  });
}

export function useDiff(ticketId: string, mode: DiffMode, enabled: boolean) {
  return useQuery({
    queryKey: localKeys.diff(ticketId, mode),
    queryFn: () => LocalService.getDiff(ticketId, mode),
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useDiffFile(input: DiffFileInput, enabled: boolean) {
  return useQuery({
    queryKey: localKeys.diffFile(input.ticketId, input.mode, input.path, input.full),
    queryFn: () => LocalService.getDiffFile(input),
    enabled,
    retry: false,
  });
}

export function useAssetMeta(ticketId: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: localKeys.assetMeta(ticketId, path),
    queryFn: () => LocalService.getAssetMeta(ticketId, path),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

export function useAsset(ticketId: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: localKeys.asset(ticketId, path),
    queryFn: () => LocalService.getAsset(ticketId, path),
    enabled,
    retry: false,
  });
}

/**
 * The connection plus whether work can actually start: paired, the service signed in to Shipline,
 * and Claude Code installed, logged in and new enough.
 */
export function useLocalReady() {
  const conn = useLocalConnection();
  const claude = conn.status?.claude;
  const claudeReady = !!claude && claude.installed && claude.loggedIn && claude.meetsMinVersion;
  const ready = conn.state === 'ready' && !!conn.status?.signedIn && claudeReady;
  return { ...conn, claudeReady, ready };
}
