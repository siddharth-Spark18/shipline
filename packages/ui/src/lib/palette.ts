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
    id: 'ultramarine',
    name: 'Ultramarine',
    light: { background: '#f2f5ff', primary: '#2438d4', sidebar: '#16208a' },
    dark: { background: '#0b1024', primary: '#8fa2ff', sidebar: '#070b1c' },
  },
  {
    id: 'ember',
    name: 'Ember',
    light: { background: '#fff7f0', primary: '#c2410c', sidebar: '#3b1708' },
    dark: { background: '#14100e', primary: '#ff9a62', sidebar: '#0d0a08' },
  },
  {
    id: 'harbor',
    name: 'Harbor',
    light: { background: '#f1f6f3', primary: '#0b7a62', sidebar: '#0a3d31' },
    dark: { background: '#08130f', primary: '#4fd6b4', sidebar: '#050d0a' },
  },
];

export const DEFAULT_PALETTE: PaletteId = 'ultramarine';
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
  const info = PALETTES.find((p) => p.id === id) ?? PALETTES[1];
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
