import { useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import { useRenameChat } from '@/services/tickets/tickets.hooks';

interface ChatTitleProps {
  ticketId: string;
  title: string;
  /** Only the chat's owner can rename it. */
  editable: boolean;
}

/** The chat's title: set from the first message, editable by its owner. */
export default function ChatTitle({ ticketId, title, editable }: ChatTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const rename = useRenameChat(ticketId);

  const save = () => {
    const next = draft.trim();
    if (!next || next === title) {
      setEditing(false);
      return;
    }
    rename.mutate(next, {
      onSuccess: () => setEditing(false),
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  if (editing) {
    return (
      <form
        className="flex min-w-0 items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          className="h-7 w-64 max-w-full"
          maxLength={200}
        />
        <Button type="submit" variant="ghost" size="icon-xs" disabled={rename.isPending} aria-label="Save title">
          <Check />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => setEditing(false)} aria-label="Cancel">
          <X />
        </Button>
      </form>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate text-sm" title={title}>
        {title}
      </span>
      {editable && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            setDraft(title);
            setEditing(true);
          }}
          aria-label="Edit title"
          title="Edit title"
        >
          <Pencil />
        </Button>
      )}
    </span>
  );
}
