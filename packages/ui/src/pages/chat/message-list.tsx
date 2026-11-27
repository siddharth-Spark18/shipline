import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import type { PromptEvent } from '@/lib/types';
import { Markdown } from '@/components/markdown';
import { ChatImages } from '@/components/image-viewer';
import { CompactedNotice, NoticeItem } from '@/pages/chat/notices';
import { ShellBlock } from '@/pages/chat/shell-block';
import type { Item } from '@/pages/chat/timeline';
import { ToolCall } from '@/pages/chat/tool-call';
import { WorkingIndicator } from '@/pages/chat/working-indicator';

/** How close to the top (px) a scroll has to be for the earlier entries to load by themselves. */
const TOP_EDGE = 40;
const ANNOUNCE_CHARS = 400;

/**
 * The chat's items, then the working indicator while a turn runs. Sticks to the bottom while new items arrive. At the
 * top, "Load earlier" (also when scrolled to the top) adds older entries without moving what is on screen; when there are
 * none the list starts with "Start of chat". Waiting questions and approvals are not here: the decision dock above the
 * composer shows them.
 *
 * It is a `log` landmark whose own announcements are off (a streamed reply would be read word by word); a finished
 * assistant message is announced once, politely, through a hidden live region.
 */
export function MessageList({
  items,
  prompts,
  chatId,
  busy,
  busySince,
  ended,
  loaded,
  hasEarlier,
  loadingEarlier,
  interrupting,
  onLoadEarlier,
  onInterrupt,
  onSendToClaude,
}: {
  items: Item[];
  prompts: PromptEvent[];
  chatId: string;
  busy: boolean;
  busySince: string | null;
  ended: boolean;
  /** The first page of the chat has arrived (before that there is nothing to say about an empty list). */
  loaded: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  /** An interrupt request is in flight. */
  interrupting: boolean;
  onLoadEarlier: () => void;
  onInterrupt: () => void;
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

  // Older entries were added above: keep what the reader was looking at where it is.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const firstId = items[0]?.id;
  useLayoutEffect(() => {
    const el = box.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    el.scrollTop = a.top + (el.scrollHeight - a.height);
  }, [firstId]);
  const loadEarlier = () => {
    const el = box.current;
    if (!el || loadingEarlier) return;
    anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    onLoadEarlier();
  };

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

  // The finished assistant message to announce: the latest text that is no longer streaming and came after the page
  // was first shown (history is not read out).
  const [announcement, setAnnouncement] = useState('');
  const seen = useRef<string | null | undefined>(undefined);
  const lastDone = [...items].reverse().find((i) => i.kind === 'text' && !i.streaming);
  useEffect(() => {
    if (!loaded) return;
    if (seen.current === undefined) {
      seen.current = lastDone?.id ?? null;
      return;
    }
    if (lastDone && lastDone.kind === 'text' && lastDone.id !== seen.current) {
      seen.current = lastDone.id;
      setAnnouncement(lastDone.text.trim().slice(0, ANNOUNCE_CHARS));
    }
  }, [lastDone, loaded]);

  return (
    <div
      ref={box}
      role="log"
      aria-live="off"
      aria-label="Conversation"
      // Block layout, not flex-col: as flex items, cards with overflow-hidden shrank to their
      // title inside this scroll box and hid the questions.
      className={cn(
        'min-h-0 flex-1 space-y-3 overflow-y-auto pr-1',
        mobile && 'overscroll-contain',
      )}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (hasEarlier && !loadingEarlier && el.scrollTop < TOP_EDGE) loadEarlier();
      }}
    >
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {loaded && hasEarlier && (
        <div className="flex justify-center">
          <Button variant="outline" size="xs" disabled={loadingEarlier} onClick={loadEarlier}>
            {loadingEarlier ? 'Loading...' : 'Load earlier'}
          </Button>
        </div>
      )}
      {loaded && !hasEarlier && items.length > 0 && (
        <p className="text-center text-xs text-muted-foreground">Start of chat</p>
      )}
      {loaded && items.length === 0 && !working && (
        <p className="text-sm text-muted-foreground">No messages yet.</p>
      )}
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} className="ml-auto flex w-fit max-w-[85%] flex-col gap-2">
                {item.images && item.images.length > 0 && (
                  <ChatImages chatId={chatId} refs={item.images} />
                )}
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
                <ChatImages chatId={chatId} refs={[item.ref]} />
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
          case 'compact':
            return <CompactedNotice key={item.id} text={item.text} />;
          default:
            return null;
        }
      })}
      {working && (
        <WorkingIndicator
          items={items}
          busySince={busySince}
          mobile={mobile}
          interrupting={interrupting}
          onInterrupt={onInterrupt}
        />
      )}
    </div>
  );
}
