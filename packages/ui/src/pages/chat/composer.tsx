import { useMemo, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { cn } from 'cn';
import { SendIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import type { ChatCommand, ImageData } from '@/lib/types';
import {
  AttachButton,
  AttachmentStrip,
  MAX_IMAGES,
  readImages,
  type Attachment,
} from '@/pages/chat/attachments';
import { filterCommands, SlashMenu, useSlashCommands } from '@/pages/chat/slash-menu';

/** Built-ins that need a terminal; sending one to `claude -p` would do nothing useful. */
const INTERACTIVE_ONLY = [
  'config',
  'login',
  'logout',
  'model',
  'permissions',
  'doctor',
  'terminal-setup',
];

const IS_WINDOWS = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

/**
 * Message box. Enter sends, Shift+Enter adds a line. A leading `/` opens the command menu, a
 * leading `!` runs a shell command in the chat's repo. Images come from paste, drop or Attach.
 *
 * `onSend` resolves true when the message was accepted (the box is cleared) and false when it
 * failed (the text stays so nothing is lost). `disabled` turns the whole box off; `busy` (Claude is
 * mid-turn) only holds back messages to Claude, since `!` commands run independently of a turn.
 */
export function Composer({
  disabled,
  busy = false,
  chatId = null,
  allowImages = true,
  placeholder,
  hint,
  onSend,
  onShellError,
}: {
  disabled: boolean;
  busy?: boolean;
  /** The chat `!` commands run in. Null on the new-chat screen, where `!` is off. */
  chatId?: string | null;
  allowImages?: boolean;
  placeholder?: string;
  /** Shown under the box, e.g. "Claude is working...". */
  hint?: string;
  onSend: (text: string, images: ImageData[]) => Promise<boolean>;
  onShellError?: (e: unknown) => void;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState(0);
  const off = disabled || sending;

  const shellMode = text.startsWith('!');
  const shellCommand = shellMode ? text.slice(1).trim() : '';
  const slashOpen = !off && !dismissed && /^\/\S*$/.test(text);
  const slash = useSlashCommands(slashOpen);
  const matches = useMemo(
    () => filterCommands(slash.commands, text.slice(1)),
    [slash.commands, text],
  );
  const at = Math.min(index, Math.max(0, matches.length - 1));

  const canSend = shellMode
    ? Boolean(chatId) && shellCommand !== ''
    : !busy && (text.trim() !== '' || images.length > 0);

  const change = (value: string) => {
    setText(value);
    setNote(null);
    setDismissed(false);
    setIndex(0);
  };

  const complete = (c: ChatCommand) => {
    change(`/${c.name} `);
    setDismissed(true);
  };

  const send = async () => {
    if (off) return;
    if (shellMode) {
      if (!shellCommand) {
        setNote('Type a command after !');
        return;
      }
      if (!chatId) return;
      setSending(true);
      try {
        await api.startShell(chatId, shellCommand);
        setText('');
      } catch (e) {
        onShellError?.(e);
      } finally {
        setSending(false);
      }
      return;
    }
    if (busy) return;
    const value = text.trim();
    if (!value && images.length === 0) return;
    const name = /^\/(\S+)/.exec(value)?.[1];
    if (name && INTERACTIVE_ONLY.includes(name)) {
      setNote(`/${name} isn't available in the browser chat; use Claude Code in a terminal.`);
      return;
    }
    setSending(true);
    try {
      if (
        await onSend(
          value,
          images.map(({ media_type, data }) => ({ media_type, data })),
        )
      ) {
        setText('');
        setImages([]);
        setNote(null);
      }
    } finally {
      setSending(false);
    }
  };

  const addFiles = async (files: File[]) => {
    if (off || !allowImages || files.length === 0) return;
    const { added, error } = await readImages(files, images.length);
    if (added.length > 0) setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES));
    setNote(error);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (slashOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
      if (matches.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const step = e.key === 'ArrowDown' ? 1 : matches.length - 1;
          setIndex((at + step) % matches.length);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          complete(matches[at]);
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0 || !allowImages) return; // plain text paste goes through
    e.preventDefault();
    void addFiles(files);
  };

  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    void addFiles(Array.from(e.dataTransfer.files));
  };

  const shellHint = !chatId
    ? 'Start or continue a chat to run commands'
    : IS_WINDOWS
      ? 'Runs in cmd.exe in the repo folder. Nothing is sent to Claude.'
      : 'Runs in the repo folder, like your terminal. Nothing is sent to Claude.';
  const line = note ?? (shellMode ? shellHint : hint);

  return (
    <div
      className="flex flex-col gap-1"
      onDragOver={(e) => {
        if (!off && allowImages && hasFiles(e)) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <AttachmentStrip
        items={images}
        disabled={off}
        onRemove={(id) => setImages((prev) => prev.filter((i) => i.id !== id))}
      />
      <div className="relative flex items-end gap-2">
        {slashOpen && (
          <SlashMenu
            items={matches}
            index={at}
            loading={slash.loading}
            error={slash.error}
            onPick={complete}
            onHover={setIndex}
          />
        )}
        {allowImages && (
          <AttachButton
            disabled={off || images.length >= MAX_IMAGES}
            onFiles={(f) => void addFiles(f)}
          />
        )}
        <Textarea
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={off}
          placeholder={
            shellMode
              ? 'Shell command'
              : (placeholder ?? 'Message Claude, / for commands, ! to run a command')
          }
          rows={2}
          className={cn(
            'min-h-0 flex-1 resize-none',
            shellMode && 'font-mono',
            dragging && 'border-ring ring-3 ring-ring/50',
          )}
          aria-label="Message"
        />
        <Button
          onClick={() => void send()}
          disabled={off || !canSend}
          aria-label={shellMode ? 'Run command' : 'Send'}
        >
          <SendIcon />
          {shellMode ? 'Run' : 'Send'}
        </Button>
      </div>
      {line && (
        <p
          className={cn('text-xs', note ? 'text-destructive' : 'text-muted-foreground')}
          role={note ? 'alert' : undefined}
        >
          {line}
        </p>
      )}
    </div>
  );
}
