import { CheckIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { THEMES } from '@/components/app-sidebar';
import { PALETTES, usePalette, useSetPalette, type PaletteInfo } from '@/lib/palette';

/** A small preview of one palette in one mode: page, sidebar strip and the accent. */
function Chip({ colours }: { colours: PaletteInfo['light'] }) {
  return (
    <span
      aria-hidden
      className="relative flex h-8 flex-1 overflow-hidden rounded-md border border-black/10"
      style={{ background: colours.background }}
    >
      <span className="w-1/4" style={{ background: colours.sidebar }} />
      <span
        className="absolute right-1.5 bottom-1.5 h-2 w-6 rounded-full"
        style={{ background: colours.primary }}
      />
    </span>
  );
}

/**
 * The Appearance card: the palette (saved on this machine, for every project and paired phone) and light, dark or
 * system (saved in this browser).
 */
export function AppearanceCard() {
  const current = usePalette();
  const setPalette = useSetPalette();
  const { theme = 'system', setTheme } = useTheme();
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
      aria-labelledby="appearance-heading"
    >
      <h3 id="appearance-heading" className="text-sm font-semibold">
        Appearance
      </h3>
      <div role="group" aria-label="Palette" className="grid grid-cols-2 gap-2">
        {PALETTES.map((p) => {
          const selected = current === p.id;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={selected}
              className={cn(
                'flex min-h-11 flex-col gap-1.5 rounded-lg border-[1.5px] bg-background p-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                selected ? 'border-primary ring-1 ring-primary' : 'border-input hover:bg-accent/50',
              )}
              onClick={() => {
                if (!selected) setPalette.mutate(p.id);
              }}
            >
              <span className="flex gap-1">
                <Chip colours={p.light} />
                <Chip colours={p.dark} />
              </span>
              <span className="flex items-center gap-1 font-medium">
                {p.name}
                {selected && <CheckIcon className="size-3.5 text-primary" aria-hidden />}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Theme">
        {THEMES.map((t) => (
          <Button
            key={t.value}
            variant={theme === t.value ? 'secondary' : 'outline'}
            className="max-md:h-11"
            aria-pressed={theme === t.value}
            onClick={() => setTheme(t.value)}
          >
            <t.icon />
            {t.label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Palette applies to every project on this machine. Light/dark is saved in this browser.
      </p>
    </section>
  );
}
