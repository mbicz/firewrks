// Effect compiler (spec §4.4, §3.6, §5.2, §5.3): pure function catalog entry + RNG -> GpuRecipe.
// No Three imports, no GPU access — every field is a typed array / plain number the GPU layer
// (Phase 4) later uploads verbatim. All randomness flows through the seeded RNG (rng.ts).

import type { RNG } from './rng';
import { range } from './rng';
import type { BreakFamily, Caliber, CatalogEntry, DeviceType } from './catalog';
import {
  ANGLE_NOISE_DEG,
  CALIBER_TABLE,
  FUSE_JITTER,
  LIFETIME_JITTER,
  SPEED_SPREAD,
  WILLOW_MIN_HANG,
} from './constants';

/** Charcoal ember the color ramp fades to (spec §3.6: "charcoal ember deep-red fade"). Not a
 * tunable — it's the literal three-phase-ramp endpoint named in the spec text, kept local since
 * constants.ts is frozen to the plan's verbatim block. */
const EMBER_HEX = '#3a1006';

export interface GpuRecipe {
  caliber: Caliber;
  apexHeight: number;
  breakRadius: number;
  riseTime: number; // meters/seconds, from CALIBER_TABLE + jitter
  fuseTime: number; // seconds after launch; breaks are fuse-timed, NEVER height-triggered
  starCount: number;
  starDirections: Float32Array; // xyz per star, asymmetric (§5.3 applied)
  starSpeeds: Float32Array; // m/s per star, ±10-20% spread
  colorRamp: Float32Array; // 3 phases x rgb: ignition white -> agent color -> ember red
  lifetimes: Float32Array; // seconds per star, ±20-35% jitter
  trailEmissionRate: number; // 0 for peony; >0 for chrysanthemum/comet/willow/horsetail
  secondary?: { kind: 'crossette' | 'pistil'; count: 4 | number; delay: number };
  flags: { strobe: boolean; crackle: boolean; dudProbability: number };
}

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Vector helpers (no `three` — this module must stay GPU-library-free).
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number];

function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Box-Muller standard normal draw from the seeded RNG. */
function gaussian(rng: RNG): number {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
}

function rotateAroundAxis(v: Vec3, axis: Vec3, angleRad: number): Vec3 {
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const dot = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const cross: Vec3 = [
    axis[1] * v[2] - axis[2] * v[1],
    axis[2] * v[0] - axis[0] * v[2],
    axis[0] * v[1] - axis[1] * v[0],
  ];
  return [
    v[0] * cosA + cross[0] * sinA + axis[0] * dot * (1 - cosA),
    v[1] * cosA + cross[1] * sinA + axis[1] * dot * (1 - cosA),
    v[2] * cosA + cross[2] * sinA + axis[2] * dot * (1 - cosA),
  ];
}

/** Random unit axis perpendicular to `v`, used to apply angular noise as a small rotation. */
function randomPerpendicularAxis(v: Vec3, rng: RNG): Vec3 {
  const seedVec: Vec3 = [gaussian(rng), gaussian(rng), gaussian(rng)];
  const dot = seedVec[0] * v[0] + seedVec[1] * v[1] + seedVec[2] * v[2];
  let p: Vec3 = [seedVec[0] - dot * v[0], seedVec[1] - dot * v[1], seedVec[2] - dot * v[2]];
  let len = Math.hypot(p[0], p[1], p[2]);
  if (len < 1e-6) {
    const helper: Vec3 = Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const d2 = helper[0] * v[0] + helper[1] * v[1] + helper[2] * v[2];
    p = [helper[0] - d2 * v[0], helper[1] - d2 * v[1], helper[2] - d2 * v[2]];
    len = Math.hypot(p[0], p[1], p[2]) || 1;
  }
  return [p[0] / len, p[1] / len, p[2] / len];
}

/**
 * Ideal (noise-free) unit direction for one star, by break-family topology (plan Phase 3 step 2):
 * palm = 5-8 arm axes; horsetail = cone half-angle <= 25 deg downrange (+z, per STAGE {w,h,d});
 * ring = unit circle in a plane tilted <= 15 deg; everything else (peony/chrysanthemum/willow/
 * fish/crossette/pistil/crackling_flower) = uniform sphere via a normalized gaussian triple.
 */
function idealDirection(
  family: BreakFamily,
  rng: RNG,
  armIndex: number,
  armCount: number,
  ringTiltRad: number,
): Vec3 {
  switch (family) {
    case 'palm': {
      const theta = (armIndex / armCount) * TAU;
      const elevation = 0.55; // arms rise up and outward, not fully horizontal or vertical
      const r = Math.sqrt(Math.max(0, 1 - elevation * elevation));
      return [r * Math.cos(theta), elevation, r * Math.sin(theta)];
    }
    case 'horsetail': {
      const halfAngleRad = (25 * Math.PI) / 180;
      const theta = rng() * TAU;
      const phi = rng() * halfAngleRad;
      const s = Math.sin(phi);
      return [s * Math.cos(theta), s * Math.sin(theta), Math.cos(phi)];
    }
    case 'ring': {
      const theta = rng() * TAU;
      const base: Vec3 = [Math.cos(theta), 0, Math.sin(theta)];
      return rotateAroundAxis(base, [1, 0, 0], ringTiltRad);
    }
    default:
      return normalize3([gaussian(rng), gaussian(rng), gaussian(rng)]);
  }
}

/**
 * Full break-direction pipeline: ideal topology ⊕ per-star angular noise (ANGLE_NOISE_DEG) ⊕ one
 * per-shell global deformation (squash y by 0.85-1.0, tilt <= 10 deg) — spec §5.3. Exported (in
 * addition to being used by `compile`) so tests can measure ideal-vs-final deviation directly
 * without re-deriving the RNG sequence.
 */
export function sampleBreakDirections(
  family: BreakFamily,
  starCount: number,
  rng: RNG,
): { ideal: Float32Array; final: Float32Array; deform: { squashY: number; tiltDeg: number } } {
  const armCount = family === 'palm' ? Math.floor(range(rng, [5, 9])) : 1;
  const ringTiltRad = family === 'ring' ? (range(rng, [-15, 15]) * Math.PI) / 180 : 0;

  // Per-shell global deformation, shared by every star in this break (squashed/tilted sphere).
  const squashY = range(rng, [0.85, 1.0]);
  const tiltDeg = range(rng, [-10, 10]);
  const tiltAxisAngle = rng() * TAU;
  const tiltAxis: Vec3 = [Math.cos(tiltAxisAngle), 0, Math.sin(tiltAxisAngle)];
  const tiltRad = (tiltDeg * Math.PI) / 180;

  const ideal = new Float32Array(starCount * 3);
  const final = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i++) {
    const d = idealDirection(family, rng, i % armCount, armCount, ringTiltRad);
    ideal[i * 3] = d[0];
    ideal[i * 3 + 1] = d[1];
    ideal[i * 3 + 2] = d[2];

    const noiseDeg = range(rng, ANGLE_NOISE_DEG);
    const noiseAxis = randomPerpendicularAxis(d, rng);
    let f = rotateAroundAxis(d, noiseAxis, (noiseDeg * Math.PI) / 180);
    f = [f[0], f[1] * squashY, f[2]];
    f = rotateAroundAxis(f, tiltAxis, tiltRad);
    f = normalize3(f);

    final[i * 3] = f[0];
    final[i * 3 + 1] = f[1];
    final[i * 3 + 2] = f[2];
  }

  return { ideal, final, deform: { squashY, tiltDeg } };
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

function hexToRgb01(hex: string): Vec3 {
  let h = hex.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---------------------------------------------------------------------------
// Per-family scale (lifetime base, trail emission)
// ---------------------------------------------------------------------------

/**
 * Base (pre-jitter) star lifetime in seconds, by family. Willow is drawn strictly at or above
 * WILLOW_MIN_HANG and only ever jittered upward, so the frozen "willow hang >= 8s" contract holds
 * for every star regardless of jitter sign; horsetail is the glossary's short "2-3s then free-fall".
 */
function familyLifetimeBase(family: BreakFamily, rng: RNG): number {
  switch (family) {
    case 'willow':
      return range(rng, [WILLOW_MIN_HANG, WILLOW_MIN_HANG * 1.5]);
    case 'horsetail':
      return range(rng, [2, 3]);
    case 'palm':
      return range(rng, [2.5, 4]);
    case 'ring':
      return range(rng, [1.5, 2.5]);
    default:
      return range(rng, [1.5, 3]);
  }
}

/** trailEmissionRate: 0 for peony (grounding rule: "no star trails"); >0 for families/devices that
 * leave spark tails (plan Phase 3 step 2: chrysanthemum/comet/willow/horsetail), extended to palm's
 * "thick rising tail" arms and fish's self-propelled trail per the glossary. */
function familyTrailRate(family: BreakFamily, deviceType: DeviceType, rng: RNG): number {
  const hasTrail =
    family === 'chrysanthemum' ||
    family === 'willow' ||
    family === 'horsetail' ||
    family === 'palm' ||
    family === 'fish' ||
    deviceType === 'comet';
  return hasTrail ? range(rng, [4, 14]) : 0;
}

/** Secondary split (crossette/pistil), read off the compiled phase itself or the very next
 * catalog phase when it's a distinct `secondary` phase (spec §4.2 grounding rule: crossette always
 * splits into exactly 4 symmetric tails). */
function resolveSecondary(
  entry: CatalogEntry,
  phaseIdx: number,
  rng: RNG,
): GpuRecipe['secondary'] {
  const phase = entry.phases[phaseIdx];
  const next = entry.phases[phaseIdx + 1];
  const secondaryFamily =
    next && next.kind === 'secondary' && (next.breakFamily === 'crossette' || next.breakFamily === 'pistil')
      ? next.breakFamily
      : phase.breakFamily === 'crossette' || phase.breakFamily === 'pistil'
        ? phase.breakFamily
        : undefined;

  if (secondaryFamily === 'crossette') {
    return { kind: 'crossette', count: 4, delay: range(rng, [0.4, 0.8]) };
  }
  if (secondaryFamily === 'pistil') {
    return { kind: 'pistil', count: Math.round(range(rng, [6, 16])), delay: range(rng, [0.2, 0.5]) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

/**
 * Compiles `entry.phases[phaseIdx]` (must carry a `breakFamily`) into a GpuRecipe. Pure function
 * of its inputs: identical `(entry, phaseIdx, seed)` always yields an identical recipe.
 */
export function compile(entry: CatalogEntry, phaseIdx: number, rng: RNG): GpuRecipe {
  const phase = entry.phases[phaseIdx];
  if (!phase) throw new Error(`compile: phaseIdx ${phaseIdx} out of range for entry "${entry.id}"`);
  const family = phase.breakFamily;
  if (!family) throw new Error(`compile: phase ${phaseIdx} of entry "${entry.id}" has no breakFamily`);

  const table = CALIBER_TABLE[entry.caliberHint];
  const apexHeight = range(rng, table.apex);
  const breakRadius = range(rng, table.radius);
  const starCount = Math.round(range(rng, table.stars));
  const riseTime = range(rng, table.rise);

  const fuseSign = rng() < 0.5 ? -1 : 1;
  const fuseTime = riseTime * (1 + fuseSign * FUSE_JITTER * rng());

  const { final: starDirections } = sampleBreakDirections(family, starCount, rng);

  const lifetimeBase = familyLifetimeBase(family, rng);
  const lifetimes = new Float32Array(starCount);
  for (let i = 0; i < starCount; i++) {
    const jitterFrac = range(rng, LIFETIME_JITTER);
    const sign = family === 'willow' ? 1 : rng() < 0.5 ? -1 : 1;
    lifetimes[i] = lifetimeBase * (1 + sign * jitterFrac);
  }

  const baseSpeed = breakRadius / lifetimeBase;
  const starSpeeds = new Float32Array(starCount);
  for (let i = 0; i < starCount; i++) {
    const spreadFrac = range(rng, SPEED_SPREAD);
    const sign = rng() < 0.5 ? -1 : 1;
    starSpeeds[i] = baseSpeed * (1 + sign * spreadFrac);
  }

  const agentColor = hexToRgb01(phase.colors[0] ?? '#ffffff');
  const emberColor = hexToRgb01(EMBER_HEX);
  const colorRamp = Float32Array.from([1, 1, 1, ...agentColor, ...emberColor]);

  const trailEmissionRate = familyTrailRate(family, entry.deviceType, rng);
  const secondary = resolveSecondary(entry, phaseIdx, rng);

  return {
    caliber: entry.caliberHint,
    apexHeight,
    breakRadius,
    riseTime,
    fuseTime,
    starCount,
    starDirections,
    starSpeeds,
    colorRamp,
    lifetimes,
    trailEmissionRate,
    secondary,
    flags: {
      strobe: phase.effectTags.includes('strobe'),
      crackle: phase.effectTags.includes('crackle') || family === 'crackling_flower',
      dudProbability: 0.02,
    },
  };
}
