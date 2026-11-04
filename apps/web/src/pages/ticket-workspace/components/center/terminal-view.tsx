import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SessionStream } from '@/pages/ticket-workspace/hooks/use-session-stream';

interface TerminalViewProps {
  ticketId: string;
  stream: SessionStream;
}

// The real, interactive Claude Code in a PTY (fallback when chat mode is unavailable). It runs
// inside the center pane, so the stage timeline and the diff panel keep working next to it.
export default function TerminalView({ ticketId, stream }: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const { onPty, sendPtyInput, resize } = stream;

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({ fontSize: 13, cursorBlink: true, convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    resize(term.cols, term.rows);

    const offPty = onPty((data) => term.write(data));
    const input = term.onData((d) => sendPtyInput(d));
    const observer = new ResizeObserver(() => {
      fit.fit();
      resize(term.cols, term.rows);
    });
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      input.dispose();
      offPty();
      term.dispose();
    };
  }, [ticketId, onPty, sendPtyInput, resize]);

  const fatal = stream.messages.find((m) => m.kind === 'fatal');

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      {fatal && fatal.kind === 'fatal' && (
        <Alert variant="destructive">
          <AlertDescription>{fatal.fatal.message}</AlertDescription>
        </Alert>
      )}
      <div ref={host} className="min-h-0 flex-1 rounded-md bg-black p-2" />
    </div>
  );
}
