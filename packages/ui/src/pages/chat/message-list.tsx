import { useEffect, useRef } from 'react';
import { cn } from 'cn';
import { useIsMobile } from '@/hooks/use-mobile';
import type { PromptEvent } from '@/lib/types';
import { Markdown } from '@/components/markdown';
import { ImageThumbs } from '@/components/image-viewer';
import { NoticeItem } from '@/pages/chat/notices';
import { ShellBlock } from '@/pages/chat/shell-block';
import type { Item } from '@/pages/chat/timeline';
import { ToolCall } from '@/pages/chat/tool-call';
import { WorkingIndicator } from '@/pages/chat/working-indicator';

/**
 * History and live items, then the working indicator while a turn runs. Sticks to the bottom while new items arrive.
 * Waiting questions and approvals are not here: the decision dock above the composer shows them.
 */
export function MessageList({
  items,
  prompts,
  chatId,
  busy,
  busySince,
  ended,
  onSendToClaude,
}: {
  items: Item[];
  prompts: PromptEvent[];
  chatId: string;
  busy: boolean;
  busySince: string | null;
  ended: boolean;
  onSendToClaude: (text: string) => Promise<boolean>;
}) {
  const mobile = useIsMobile();
  const working = busy && prompts.length === 0 && !ended;
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const last = items[items.length - 1];
  const grow =
    last?.kind === 'text' ? last.text.length : last?.kind === 'shell' ? last.output.length : '';
  const tick = `${items.length}:${grow}:${working}`;
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [tick]);

  // The box shrinks when the keyboard opens (phone) or the dock appears: keep the latest messages in view.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={box}
      // Block layout, not flex-col: as flex items, cards with overflow-hidden shrank to their
      // title inside this scroll box and hid the questions.
      className={cn(
        'min-h-0 flex-1 space-y-3 overflow-y-auto pr-1',
        mobile && 'overscroll-contain',
      )}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {items.length === 0 && !working && (
        <p className="text-sm text-muted-foreground">No messages yet.</p>
      )}
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} className="ml-auto flex w-fit max-w-[85%] flex-col gap-2">
                {item.images && item.images.length > 0 && <ImageThumbs images={item.images} />}
                {item.text.trim() && (
                  <div className="ml-auto w-fit rounded-2xl rounded-br-sm border border-primary/25 bg-primary/10 px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-foreground">
                    {item.text}
                  </div>
                )}
              </div>
            );
          case 'image':
            return (
              <div key={item.id} className="ml-auto w-fit max-w-[85%]">
                <ImageThumbs images={[item]} />
              </div>
            );
          case 'shell':
            return (
              <ShellBlock
                key={item.id}
                item={item}
                chatId={chatId}
                busy={busy}
                ended={ended}
                onSendToClaude={onSendToClaude}
              />
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
      {working && <WorkingIndicator items={items} busySince={busySince} mobile={mobile} />}
    </div>
  );
}
