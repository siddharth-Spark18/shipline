import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SessionStream } from './use-session-stream';

const REFRESH_DEBOUNCE_MS = 800;

/**
 * Keeps the diff queries live while the chat is open, whether or not the right panel is: after each
 * tool result (Edit, Write, Bash...) and on the file watcher's "diff changed" signal, debounced.
 * The changes summary card in the chat and the Changes tab both read these queries.
 */
export function useLiveDiffRefresh(ticketId: string, stream: SessionStream): void {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const refresh = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ['local', 'diff', ticketId] });
      void qc.invalidateQueries({ queryKey: ['local', 'asset', ticketId] });
    }, REFRESH_DEBOUNCE_MS);
  };

  useEffect(() => stream.onDiffChanged(refresh), [stream.onDiffChanged]); // eslint-disable-line react-hooks/exhaustive-deps
  const last = stream.messages[stream.messages.length - 1];
  useEffect(() => {
    if (last?.kind === 'event' && last.event.type === 'user') refresh();
  }, [stream.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(timer.current), []);
}
