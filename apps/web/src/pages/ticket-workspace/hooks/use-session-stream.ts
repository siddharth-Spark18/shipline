import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionMessage, SessionState } from '@shipline/shared';
import { openSessionSocket } from '@/lib/local-api';

export interface SessionStream {
  messages: SessionMessage[];
  connected: boolean;
  /** Last state the local service reported: running, waiting (needs you) or idle. */
  state: SessionState;
  sendUser: (text: string) => void;
  sendPtyInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  /** Subscribe to raw PTY chunks (terminal view writes them straight into xterm). */
  onPty: (cb: (data: string) => void) => () => void;
  /** Subscribe to "something in the worktree changed" signals (file watcher, git HEAD/index). */
  onDiffChanged: (cb: () => void) => () => void;
}

const RECONNECT_MS = 2_000;

// A WebSocket is a live stream, not server state, so it lives in a hook rather than React Query.
// While `enabled` (a session exists for the ticket) it reconnects by itself; the local service
// replays the whole conversation on every connect.
export function useSessionStream(ticketId: string, enabled: boolean): SessionStream {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<SessionState>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const ptyListeners = useRef(new Set<(data: string) => void>());
  const ptyBuffer = useRef<string[]>([]);
  const diffListeners = useRef(new Set<() => void>());

  useEffect(() => {
    setMessages([]);
    ptyBuffer.current = [];
    if (!enabled) {
      setConnected(false);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = openSessionSocket(ticketId);
      wsRef.current = ws;
      ws.onopen = () => {
        // The service replays history on every connect: start from a clean slate.
        setMessages([]);
        ptyBuffer.current = [];
        setConnected(true);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) timer = setTimeout(connect, RECONNECT_MS);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as SessionMessage;
        if (msg.kind === 'pty') {
          ptyBuffer.current.push(msg.data);
          ptyListeners.current.forEach((cb) => cb(msg.data));
          return;
        }
        if (msg.kind === 'state') {
          setState(msg.state);
          return;
        }
        if (msg.kind === 'diff-changed') {
          diffListeners.current.forEach((cb) => cb());
          return;
        }
        setMessages((cur) => [...cur, msg]);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [ticketId, enabled]);

  const send = useCallback((payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload));
  }, []);

  const onPty = useCallback((cb: (data: string) => void) => {
    // Replay what arrived before the terminal view mounted.
    ptyBuffer.current.forEach(cb);
    ptyListeners.current.add(cb);
    return () => {
      ptyListeners.current.delete(cb);
    };
  }, []);

  const onDiffChanged = useCallback((cb: () => void) => {
    diffListeners.current.add(cb);
    return () => {
      diffListeners.current.delete(cb);
    };
  }, []);

  const sendUser = useCallback((text: string) => send({ kind: 'user', text }), [send]);
  const sendPtyInput = useCallback((data: string) => send({ kind: 'pty-input', data }), [send]);
  const resize = useCallback((cols: number, rows: number) => send({ kind: 'resize', cols, rows }), [send]);

  return { messages, connected, state, sendUser, sendPtyInput, resize, onPty, onDiffChanged };
}
