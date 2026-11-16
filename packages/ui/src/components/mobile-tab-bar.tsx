import {
  HeartPulseIcon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  PlusIcon,
  SettingsIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { DOT_CLASS, DOT_LABEL } from '@/components/app-sidebar';
import type { HealthDot } from '@/lib/types';

export type MobileTab = 'all' | 'chats' | 'new' | 'setup' | 'health';

const TABS: { tab: MobileTab; label: string; icon: typeof MessageSquareIcon }[] = [
  { tab: 'all', label: 'All', icon: LayoutDashboardIcon },
  { tab: 'chats', label: 'Chats', icon: MessageSquareIcon },
  { tab: 'new', label: 'New', icon: PlusIcon },
  { tab: 'setup', label: 'Setup', icon: SettingsIcon },
  { tab: 'health', label: 'Health', icon: HeartPulseIcon },
];

/**
 * The phone's navigation: All / Chats / New / Setup / Health, the same items as the laptop's sidebar. All shows how many
 * chats wait for you across projects, Health the worst health state. Hidden while the on-screen keyboard is open; the
 * bottom padding keeps it clear of the home indicator.
 */
export function MobileTabBar({
  active,
  waitingTotal,
  healthDot,
  hidden,
  onSelect,
}: {
  /** The highlighted tab, or null when none applies. */
  active: MobileTab | null;
  /** Chats waiting for you, across all projects. */
  waitingTotal: number;
  healthDot: HealthDot | null;
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
            {tab === 'all' && waitingTotal > 0 && (
              <span
                className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground"
                aria-label={`${waitingTotal} waiting for you`}
              >
                {waitingTotal}
              </span>
            )}
            {tab === 'health' && healthDot && (
              <span
                role="img"
                aria-label={DOT_LABEL[healthDot]}
                className={cn(
                  'absolute -top-1 -right-2 size-2.5 rounded-full ring-2 ring-background',
                  DOT_CLASS[healthDot],
                )}
              />
            )}
          </span>
          {label}
        </button>
      ))}
    </nav>
  );
}
