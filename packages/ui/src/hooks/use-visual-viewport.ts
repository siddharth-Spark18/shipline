import { useEffect, useState } from 'react';

/** The on-screen keyboard counts as open when it takes more than this many pixels off the bottom. */
const KEYBOARD_MIN = 120;

interface ViewportState {
  /** True while the on-screen keyboard is covering the bottom of the page. */
  keyboardOpen: boolean;
  /** Pixels between the bottom of the visible area and the bottom of the layout viewport (0 without a keyboard). */
  bottomInset: number;
  /** Pixels the visible area is scrolled down inside the layout viewport (0 without a keyboard). */
  offsetTop: number;
}

const CLOSED: ViewportState = { keyboardOpen: false, bottomInset: 0, offsetTop: 0 };

function read(): ViewportState {
  const vv = window.visualViewport;
  if (!vv) return CLOSED;
  const top = Math.max(0, Math.round(vv.offsetTop));
  const bottom = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  // Pinch-zoom also changes the visual viewport; only a large gap at the bottom is a keyboard.
  if (bottom + top < KEYBOARD_MIN || vv.scale > 1.01) return CLOSED;
  return { keyboardOpen: true, bottomInset: bottom, offsetTop: top };
}

/**
 * Where the visible area is, from `window.visualViewport`, so a phone layout can sit right above the
 * on-screen keyboard. Without a keyboard (and on a browser with no visualViewport) nothing is offset.
 */
export function useVisualViewport(): ViewportState {
  const [state, setState] = useState<ViewportState>(read);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      setState((cur) => {
        const next = read();
        return cur.keyboardOpen === next.keyboardOpen &&
          cur.bottomInset === next.bottomInset &&
          cur.offsetTop === next.offsetTop
          ? cur
          : next;
      });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return state;
}
