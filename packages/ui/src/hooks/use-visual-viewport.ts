import { useEffect, useState } from 'react';

/** The on-screen keyboard counts as open when the visible area is this many pixels shorter than with no keyboard. */
const KEYBOARD_MIN = 120;

interface ViewportState {
  /** True while the on-screen keyboard is taking space from the page. */
  keyboardOpen: boolean;
  /** Pixels the visible area is scrolled down inside the layout viewport (iOS Safari with the keyboard open). */
  offsetTop: number;
  /** Height of the visible area in CSS pixels, or null without visualViewport (then the layout fills the window). */
  height: number | null;
}

const isTextField = (el: Element | null) =>
  !!el &&
  (el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit', 'range', 'file'].includes(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable));

// The tallest visible height seen while no text field had focus: the "no keyboard" height. Browsers differ on what
// the keyboard changes: iOS Safari keeps the layout viewport and shrinks/scrolls only the visual viewport, while
// Chrome on iOS (and Android with resizes-content) shrinks the layout viewport too. Comparing the visible height
// with this baseline works for both, unlike innerHeight - visualViewport.height (0 in Chrome).
let baseline = 0;
let baselineWidth = 0;

function read(): ViewportState {
  const vv = window.visualViewport;
  if (!vv) return { keyboardOpen: false, offsetTop: 0, height: null };
  const height = Math.round(vv.height);
  const width = Math.round(vv.width);
  // A rotation changes what "no keyboard" means.
  if (width !== baselineWidth) {
    baselineWidth = width;
    baseline = 0;
  }
  const zoomed = vv.scale > 1.01;
  if (!isTextField(document.activeElement) && !zoomed) baseline = Math.max(baseline, height, window.innerHeight);
  const keyboardOpen = !zoomed && baseline - height >= KEYBOARD_MIN;
  return {
    keyboardOpen,
    offsetTop: zoomed ? 0 : Math.max(0, Math.round(vv.offsetTop)),
    height: zoomed ? null : height,
  };
}

/**
 * Where the visible area is, from `window.visualViewport`, so a phone layout can sit right above the on-screen
 * keyboard: place a fixed element at `top: offsetTop` with `height` (not `bottom`, which depends on how the
 * browser treats the layout viewport). Re-read on visual-viewport and window resizes and scrolls and on focus
 * changes, since some browsers resize the layout viewport without a visual-viewport event.
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
          cur.offsetTop === next.offsetTop &&
          cur.height === next.height
          ? cur
          : next;
      });
    // The keyboard animates; settle once more after it finishes.
    let timer = 0;
    const updateSoon = () => {
      update();
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 300);
    };
    update();
    vv.addEventListener('resize', updateSoon);
    vv.addEventListener('scroll', updateSoon);
    window.addEventListener('resize', updateSoon);
    window.addEventListener('focusin', updateSoon);
    window.addEventListener('focusout', updateSoon);
    return () => {
      window.clearTimeout(timer);
      vv.removeEventListener('resize', updateSoon);
      vv.removeEventListener('scroll', updateSoon);
      window.removeEventListener('resize', updateSoon);
      window.removeEventListener('focusin', updateSoon);
      window.removeEventListener('focusout', updateSoon);
    };
  }, []);
  return state;
}
