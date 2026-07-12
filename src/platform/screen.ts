// Resolution cap + DPR sizing (spec §2: internal render resolution capped at ~3840x2160).
const MAX_W = 3840;
const MAX_H = 2160;

export interface BackingSize { w: number; h: number }

/** Backing (device-pixel) render size for a CSS-pixel viewport at a given DPR,
 * clamped to the 4K-equivalent cap while preserving aspect ratio. */
export function fit(cssW: number, cssH: number, dpr: number): BackingSize {
  const rawW = cssW * dpr;
  const rawH = cssH * dpr;
  const scale = Math.min(1, MAX_W / rawW, MAX_H / rawH);
  return { w: Math.round(rawW * scale), h: Math.round(rawH * scale) };
}

/**
 * MDN devicePixelRatio resolution-change listener: a `matchMedia` query is
 * bound to the DPR value at subscription time, so it must be re-created after
 * each firing to keep tracking future changes (MDN `Window.devicePixelRatio`).
 */
export function watchDPR(onChange: (dpr: number) => void): () => void {
  let mql: MediaQueryList | null = null;
  let disposed = false;

  const update = () => {
    onChange(window.devicePixelRatio);
    if (disposed) return;
    mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mql.addEventListener('change', update, { once: true });
  };

  update();

  return () => {
    disposed = true;
    mql?.removeEventListener('change', update);
  };
}
