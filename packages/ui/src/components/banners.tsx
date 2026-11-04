import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/events';
import type { BannerEvent, BannerKind, Status } from '@/lib/types';

// Shown for every repo older than interface 3 (its tasks and state are still inside the repo). Mirrors UPGRADE_TEXT
// in packages/cli/src/ui/server.mjs.
const UPGRADE_TEXT =
  'Task data is still stored in this repo. Run `npx @forgeyard/shipline upgrade` to move it to ~/.shipline.';

const TITLES: Record<BannerKind, string> = {
  version: 'Shipline version',
  'fail-open': 'Shipline config problem',
  'lost-task': 'Task not tracked',
  'usage-limit': 'Usage limit',
  watch: 'Live updates',
};

function repoPackage(status: Status): string {
  return status.repoVersion.package ?? 'a newer version';
}

/** The version banner built from /api/status, used when the server has not sent one over SSE. */
export function versionBanner(status: Status | undefined): BannerEvent | null {
  if (!status) return null;
  if (status.needsUpgrade) return { id: 'version', kind: 'version', text: UPGRADE_TEXT };
  if (status.versionState === 'same') return null;
  if (status.versionState === 'repo-older') {
    return {
      id: 'version',
      kind: 'version',
      text: UPGRADE_TEXT,
    };
  }
  return {
    id: 'version',
    kind: 'version',
    text: `This repo was set up with Shipline ${repoPackage(status)}. Run \`npx @forgeyard/shipline@${status.repoVersion.package ?? '<version>'} ui\`. Saving is disabled; the Tasks tab is read-only.`,
  };
}

function BannerItem({
  banner,
  destructive,
  onDismiss,
  onOpenDiagnostics,
}: {
  banner: BannerEvent;
  destructive?: boolean;
  onDismiss: () => void;
  onOpenDiagnostics?: () => void;
}) {
  const Icon = banner.kind === 'version' && !destructive ? InfoIcon : TriangleAlertIcon;
  return (
    <Alert
      variant={destructive ? 'destructive' : 'default'}
      className={cn('py-2 pr-12', !destructive && 'border-l-4 border-l-notice-reminder')}
    >
      <Icon className={destructive ? undefined : 'text-notice-reminder'} />
      <AlertTitle>{TITLES[banner.kind] ?? 'Shipline'}</AlertTitle>
      <AlertDescription>
        {banner.text}
        {onOpenDiagnostics && (
          <>
            {' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={onOpenDiagnostics}
            >
              Open diagnostics
            </button>
          </>
        )}
      </AlertDescription>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-1.5 right-2"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <XIcon />
      </Button>
    </Alert>
  );
}

/**
 * SSE `banner` events (version, fail-open, lost-task, usage-limit) plus the version banner built
 * from /api/status. They stay until dismissed. `all` ignores dismissal and drives the status row.
 */
export function useBanners(status: Status | undefined) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const { data: pushed = [] } = useQuery<BannerEvent[]>({
    queryKey: queryKeys.banners,
    queryFn: () => [],
    staleTime: Infinity,
    gcTime: Infinity,
    enabled: false,
    initialData: [],
  });

  const all = [...pushed];
  const derived = versionBanner(status);
  if (derived && !all.some((b) => b.kind === 'version')) all.unshift(derived);

  const isDestructive = (b: BannerEvent) =>
    b.kind !== 'version' || status?.versionState === 'repo-newer';
  const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id));
  return { all, visible: all.filter((b) => !dismissed.has(b.id)), isDestructive, dismiss };
}

/** Compact alerts shown above the page content for every non-ok status. */
export function Banners({
  banners,
  isDestructive,
  onDismiss,
  onOpenDiagnostics,
}: {
  banners: BannerEvent[];
  isDestructive: (b: BannerEvent) => boolean;
  onDismiss: (id: string) => void;
  onOpenDiagnostics?: () => void;
}) {
  if (banners.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-4 pt-3">
      {banners.map((b) => (
        <BannerItem
          key={b.id}
          banner={b}
          destructive={isDestructive(b)}
          onDismiss={() => onDismiss(b.id)}
          onOpenDiagnostics={onOpenDiagnostics}
        />
      ))}
    </div>
  );
}
