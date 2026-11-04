import { useEffect, useRef } from 'react';
import type { PromptEvent } from '@/lib/types';
import { Markdown } from '@/components/markdown';
import { NoticeItem } from '@/pages/chat/notices';
import { PermissionCard } from '@/pages/chat/permission-card';
import { QuestionCard, parseQuestions } from '@/pages/chat/question-card';
import type { Item } from '@/pages/chat/timeline';
import { ToolCall } from '@/pages/chat/tool-call';

function PromptCard({ prompt }: { prompt: PromptEvent }) {
  const questions = prompt.tool === 'AskUserQuestion' ? parseQuestions(prompt.input) : null;
  // An AskUserQuestion with an unreadable shape falls back to a plain Allow/Deny card.
  return questions ? (
    <QuestionCard prompt={prompt} questions={questions} />
  ) : (
    <PermissionCard prompt={prompt} />
  );
}

/** History and live items, then any pending permission cards. Sticks to the bottom while new items arrive. */
export function MessageList({ items, prompts }: { items: Item[]; prompts: PromptEvent[] }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const last = items[items.length - 1];
  const tick = `${items.length}:${last && last.kind === 'text' ? last.text.length : ''}:${prompts.length}`;
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [tick]);

  return (
    <div
      ref={box}
      // Block layout, not flex-col: as flex items, cards with overflow-hidden shrank to their
      // title inside this scroll box and hid the questions.
      className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {items.length === 0 && prompts.length === 0 && (
        <p className="text-sm text-muted-foreground">No messages yet.</p>
      )}
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div
                key={item.id}
                className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm border border-primary/25 bg-primary/10 px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-foreground"
              >
                {item.text}
              </div>
            );
          case 'text':
            return <Markdown key={item.id}>{item.text}</Markdown>;
          case 'tool':
            return <ToolCall key={item.id} item={item} />;
          case 'notice':
            return <NoticeItem key={item.id} level={item.level} text={item.text} />;
          default:
            return null;
        }
      })}
      {prompts.map((p) => (
        <PromptCard key={p.id} prompt={p} />
      ))}
    </div>
  );
}
