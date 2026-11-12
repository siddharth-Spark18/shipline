import { MessageSquareIcon, PlusIcon, SettingsIcon } from 'lucide-react';
import { cn } from 'cn';

export type MobileTab = 'chats' | 'new' | 'setup';

const TABS: { tab: MobileTab; label: string; icon: typeof MessageSquareIcon }[] = [
  { tab: 'chats', label: 'Chats', icon: MessageSquareIcon },
  { tab: 'new', label: 'New', icon: PlusIcon },
  { tab: 'setup', label: 'Setup', icon: SettingsIcon },
];

/**
 * The phone's navigation: Chats / New / Setup. The Chats tab shows how many chats wait for an answer.
 * Hidden while the on-screen keyboard is open; the bottom padding keeps it clear of the home indicator.
 */
export function MobileTabBar({
  active,
  waitingChats,
  hidden,
  onSelect,
}: {
  /** The highlighted tab, or null when none applies. */
  active: MobileTab | null;
  /** Chats with a pending prompt. */
  waitingChats: number;
  hidden: boolean;
  onSelect: (tab: MobileTab) => void;
}) {
  if (hidden) return null;
  return (
    <nav
      aria-label="Main"
      className="flex shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map(({ tab, label, icon: Icon }) => (
        <button
          key={tab}
          type="button"
          aria-current={active === tab ? 'page' : undefined}
          onClick={() => onSelect(tab)}
          className={cn(
            'relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium',
            active === tab ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <span className="relative">
            <Icon className="size-5" aria-hidden />
            {tab === 'chats' && waitingChats > 0 && (
              <span
                className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground"
                aria-label={`${waitingChats} waiting for an answer`}
              >
                {waitingChats}
              </span>
            )}
          </span>
          {label}
        </button>
      ))}
    </nav>
  );
}
