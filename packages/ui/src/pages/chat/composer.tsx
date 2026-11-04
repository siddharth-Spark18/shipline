import { useState, type KeyboardEvent } from 'react';
import { SendIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * Message box. Enter sends, Shift+Enter adds a line. `onSend` resolves true when the message was
 * accepted (the box is cleared) and false when it failed (the text stays so nothing is lost).
 */
export function Composer({
  disabled,
  placeholder,
  hint,
  onSend,
}: {
  disabled: boolean;
  placeholder?: string;
  /** Shown under the box, e.g. "Claude is working...". */
  hint?: string;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const off = disabled || sending;

  const send = async () => {
    const value = text.trim();
    if (!value || off) return;
    setSending(true);
    try {
      if (await onSend(value)) setText('');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={off}
          placeholder={placeholder ?? 'Message Claude'}
          rows={2}
          className="min-h-0 flex-1 resize-none"
          aria-label="Message"
        />
        <Button onClick={() => void send()} disabled={off || !text.trim()} aria-label="Send">
          <SendIcon />
          Send
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
