import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  ResultEvent,
  StreamEvent,
  buildUserInputMessage,
  isSystemInit,
  isUsageLimitText,
  parseStreamLine,
} from '@shipline/shared';
import { CLAUDE_BIN } from './claude-cli';
import { LaunchPlan } from './launch';

export interface ChatFatal {
  kind: 'parse' | 'spawn' | 'exit';
  message: string;
  /** The UI offers terminal mode as the fallback for these. */
  suggestTerminal: boolean;
}

// OPEN-QUESTION #1: whether a local app driving the user's own CLI in `-p` mode is allowed by
// Anthropic is unconfirmed. Chat mode is the default, but terminal mode (the unmodified interactive
// binary) is wired end to end and switchable per project/user, so the app survives a "no".
/**
 * Chat mode: drives the user's own `claude -p --output-format stream-json --input-format
 * stream-json`. The stream-json format is undocumented for direct CLI use and may change, so any
 * line that fails to parse stops the session cleanly and reports it rather than guessing.
 */
export class ChatSession extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderrTail = '';
  private stopping = false;
  sessionId: string | null = null;

  constructor(private plan: LaunchPlan) {
    super();
  }

  start(): void {
    try {
      this.proc = spawn(CLAUDE_BIN, this.plan.args, {
        cwd: this.plan.cwd,
        env: this.plan.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.emit('fatal', { kind: 'spawn', message: String(err), suggestTerminal: true } satisfies ChatFatal);
      return;
    }

    this.proc.on('error', (err) => {
      this.emit('fatal', { kind: 'spawn', message: err.message, suggestTerminal: true } satisfies ChatFatal);
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    this.proc.on('exit', (code, signal) => {
      if (this.stopping) {
        this.emit('exit', { code, signal });
        return;
      }
      if (code !== 0) {
        this.emit('fatal', {
          kind: 'exit',
          message: `claude exited with code ${code ?? signal}. ${this.stderrTail.trim()}`,
          suggestTerminal: true,
        } satisfies ChatFatal);
      }
      this.emit('exit', { code, signal });
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const parsed = parseStreamLine(line);
    if (!parsed.ok) {
      this.emit('fatal', {
        kind: 'parse',
        message: `Unrecognized output from claude (${parsed.error}). The stream-json format may have changed; use terminal mode.`,
        suggestTerminal: true,
      } satisfies ChatFatal);
      this.stop();
      return;
    }
    const event: StreamEvent = parsed.event;
    if (isSystemInit(event)) {
      this.sessionId = event.session_id;
      this.emit('session-id', event.session_id);
    }
    if (event.type === 'result') {
      const result = event as ResultEvent;
      if (result.is_error && isUsageLimitText(result.result)) {
        this.emit('usage-limit', result.result ?? 'Claude usage limit reached.');
      }
    }
    this.emit('event', event);
  }

  send(text: string): void {
    if (!this.proc || this.proc.killed) return;
    this.proc.stdin.write(buildUserInputMessage(text));
  }

  stop(): void {
    this.stopping = true;
    if (!this.proc) return;
    this.proc.stdin.end();
    const p = this.proc;
    setTimeout(() => {
      if (!p.killed) p.kill('SIGTERM');
    }, 1500).unref();
  }
}
