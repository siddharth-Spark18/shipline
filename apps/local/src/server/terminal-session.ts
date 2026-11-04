import { EventEmitter } from 'events';
import { CLAUDE_BIN } from './claude-cli';
import { LaunchPlan } from './launch';

interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/**
 * Terminal mode: the real, interactive Claude Code in a PTY. This is the lower-risk fallback to
 * chat mode and must keep working (OPEN-QUESTION #3: kept enabled in v1, behind `sessionMode`).
 * node-pty is an optional native dependency, loaded lazily.
 */
export class TerminalSession extends EventEmitter {
  private pty: PtyLike | null = null;

  constructor(private plan: LaunchPlan) {
    super();
  }

  start(cols = 100, rows = 30): void {
    let nodePty: typeof import('node-pty');
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      nodePty = require('node-pty');
    } catch {
      this.emit('fatal', {
        kind: 'spawn',
        message: 'Terminal mode needs node-pty, which is not installed or could not be built on this machine.',
        suggestTerminal: false,
      });
      this.emit('exit', { code: null });
      return;
    }
    const env = Object.fromEntries(Object.entries(this.plan.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
    try {
      this.pty = nodePty.spawn(CLAUDE_BIN, this.plan.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: this.plan.cwd,
        env,
      }) as unknown as PtyLike;
    } catch (err) {
      // e.g. "posix_spawnp failed" when node-pty's spawn-helper isn't executable (see scripts/fix-node-pty.mjs).
      this.emit('fatal', {
        kind: 'spawn',
        message: `Could not start Claude Code in a terminal: ${(err as Error).message}`,
        suggestTerminal: false,
      });
      this.emit('exit', { code: null });
      return;
    }
    this.pty.onData((d) => this.emit('data', d));
    this.pty.onExit((e) => this.emit('exit', { code: e.exitCode }));
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  stop(): void {
    // Nothing to kill (spawn never happened): still report the exit so the session is released.
    if (!this.pty) {
      this.emit('exit', { code: null });
      return;
    }
    this.pty.kill();
  }
}
