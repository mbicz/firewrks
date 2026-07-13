// ALL numeric constants for the show (world scale, jitter, decay). Copied
// verbatim from the plan's Frozen Contracts "Constants" block (spec §3.5/§4.7/§5)
// — do not alter numeric values; every other module reads its magic numbers
// from here, never re-typed.

export const G = 9.81; // m/s^2
export const STAGE = { w: 600, h: 350, d: 200 } as const; // meters
export const CAMERA = { dist: 400, elev: 10, fovDeg: 50 } as const;
export const CALIBER_TABLE = {
  small: { apex: [90, 140], radius: [15, 35], stars: [60, 150], rise: [2, 3] },
  medium: { apex: [140, 220], radius: [35, 70], stars: [150, 400], rise: [3, 4.5] },
  large: { apex: [220, 300], radius: [70, 125], stars: [300, 900], rise: [4, 6] },
} as const;
export const SIM_HZ = 60;
export const RENDER_MAX = { w: 3840, h: 2160 } as const;
export const LIFETIME_JITTER = [0.2, 0.35] as const; // ±fraction
export const SPEED_SPREAD = [0.1, 0.2] as const;
export const ANGLE_NOISE_DEG = [2, 6] as const;
export const FUSE_JITTER = 0.1; // ±fraction
export const LAUNCH_TILT_DEG = 3;
export const WILLOW_MIN_HANG = 8; // seconds
export const SMOKE_GRID = [64, 32, 32] as const;
export const SMOKE_DECAY_S = [60, 180] as const;
export const BURST_LIGHTS_N = 8;
export const LIGHT_FADE_MS = 150;
export const FINALE_RESERVE = 0.3;
// Ambient inter-launch gaps (spec §4.3's "≤2.5s" was a MAXIMUM meant to prevent dead air, not a
// target density; combined with real shell visual lifetimes of 5-15s+ it produced many
// concurrently-overlapping shells reading as continuous mass-launch rather than a fireworks show
// building one compound at a time — corrected post-launch from live visual feedback).
export const MAX_GAP_S = 7; // dense (non-lull) ambient upper bound
export const LULL_MAX_GAP_S = 16; // lull upper bound
export const POOL_CAPACITY = 1_500_000;
