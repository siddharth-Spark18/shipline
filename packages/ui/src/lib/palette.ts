import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { PaletteId, Preferences } from '@/lib/types';

/** Colours of one palette in one mode, for the picker's preview chip and the browser's theme-color. */
interface Swatch {
  background: string;
  primary: string;
  sidebar: string;
}

export interface PaletteInfo {
  id: PaletteId;
  name: string;
  light: Swatch;
  dark: Swatch;
}

/** The palettes, with the values the picker previews. The real tokens live in index.css; keep them in step. */
export const PALETTES: PaletteInfo[] = [
  {
    id: 'classic',
    name: 'Classic',
    light: { background: '#f5f3ee', primary: '#4b3fd6', sidebar: '#fbfaf7' },
    dark: { background: '#000000', primary: '#9a92ff', sidebar: '#0a0a0a' },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    light: { background: '#fafafa', primary: '#18181b', sidebar: '#f4f4f5' },
    dark: { background: '#09090b', primary: '#fafafa', sidebar: '#0f0f11' },
  },
  {
    id: 'ink',
    name: 'Ink',
    light: { background: '#f7f8fa', primary: '#1e3a5f', sidebar: '#eef1f5' },
    dark: { background: '#0b1220', primary: '#8fb3e0', sidebar: '#080e19' },
  },
  {
    id: 'sage',
    name: 'Sage',
    light: { background: '#f7f7f4', primary: '#3f5f4a', sidebar: '#efefe9' },
    dark: { background: '#0e110f', primary: '#9cc3a8', sidebar: '#0a0d0b' },
  },
  {
    id: 'mocha',
    name: 'Mocha',
    light: { background: '#faf8f5', primary: '#5b4636', sidebar: '#f3efe9' },
    dark: { background: '#12100e', primary: '#d6b89c', sidebar: '#0d0b0a' },
  },
];

export const DEFAULT_PALETTE: PaletteId = 'mocha';
const CACHE_KEY = 'shipline.palette';

export const isPaletteId = (v: unknown): v is PaletteId => PALETTES.some((p) => p.id === v);

/** The palette cached by the last visit (the inline script in index.html paints it before the app loads). */
function cachedPalette(): PaletteId | null {
  try {
    const v = window.localStorage.getItem(CACHE_KEY);
    return isPaletteId(v) ? v : null;
  } catch {
    return null;
  }
}

/** Sets data-palette on <html>, caches it for the next first paint and points the theme-color metas at it. */
export function applyPalette(id: PaletteId) {
  const info = PALETTES.find((p) => p.id === id) ?? PALETTES.find((p) => p.id === DEFAULT_PALETTE)!;
  document.documentElement.dataset.palette = info.id;
  try {
    window.localStorage.setItem(CACHE_KEY, info.id);
  } catch {
    // Blocked storage: the next visit paints the default first, then the server's value.
  }
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((m) => {
    m.content = m.media.includes('dark') ? info.dark.background : info.light.background;
  });
}

/**
 * GET /api/preferences, applied app-wide. A failed read keeps the cached palette (no error UI). Kept fresh by the SSE
 * `preferences` event. Call once at the app root.
 */
export function usePalette(enabled = true) {
  const query = useQuery<Preferences>({
    queryKey: queryKeys.preferences,
    queryFn: api.preferences,
    staleTime: Infinity,
    enabled,
  });
  const palette = query.data?.palette;
  useEffect(() => {
    if (palette && isPaletteId(palette) && palette !== cachedPalette()) applyPalette(palette);
  }, [palette]);
  return palette ?? cachedPalette() ?? DEFAULT_PALETTE;
}

/** Changes the palette for every project and device: applied at once, reverted with a toast if the save fails. */
export function useSetPalette() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: PaletteId) => api.setPreferences({ palette: id }),
    onMutate: (id) => {
      const previous =
        queryClient.getQueryData<Preferences>(queryKeys.preferences)?.palette ??
        cachedPalette() ??
        DEFAULT_PALETTE;
      applyPalette(id);
      queryClient.setQueryData<Preferences>(queryKeys.preferences, { palette: id });
      return { previous };
    },
    onError: (e, _id, ctx) => {
      if (ctx) {
        applyPalette(ctx.previous);
        queryClient.setQueryData<Preferences>(queryKeys.preferences, { palette: ctx.previous });
      }
      toast.error(`Could not save the palette: ${e instanceof Error ? e.message : 'try again'}`);
    },
  });
}
