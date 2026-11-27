import { BellIcon, BellOffIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NOTIFY_KINDS, enableNotifications, setPref, useNotifyState } from '@/lib/notifications';

/**
 * The header's bell: which things notify on this device. Everything is on by default once the browser has allowed
 * notifications; the choices are kept per device (localStorage).
 */
export function NotificationSettings({ mobile = false }: { mobile?: boolean }) {
  const { permission, prefs } = useNotifyState();
  const on = permission === 'granted';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={mobile ? 'size-11 shrink-0' : undefined}
          aria-label="Notifications"
          title="Notifications"
        >
          {on ? <BellIcon /> : <BellOffIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Notify me on this device</DropdownMenuLabel>
        {permission === 'default' && (
          <DropdownMenuItem onSelect={() => void enableNotifications()}>
            Turn on notifications
          </DropdownMenuItem>
        )}
        {permission === 'denied' && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Notifications are blocked for this site. Allow them in the browser's site settings.
          </p>
        )}
        {permission === 'unsupported' && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            This browser has no notifications here (on an iPhone, add Shipline to the Home Screen).
            The tab title still shows how many chats wait for you.
          </p>
        )}
        <DropdownMenuSeparator />
        {NOTIFY_KINDS.map((k) => (
          <DropdownMenuCheckboxItem
            key={k.kind}
            checked={prefs[k.kind]}
            disabled={!on}
            onCheckedChange={(v) => setPref(k.kind, v === true)}
            onSelect={(e) => e.preventDefault()}
          >
            <span className="flex flex-col">
              <span>{k.label}</span>
              <span className="text-xs text-muted-foreground">{k.hint}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
