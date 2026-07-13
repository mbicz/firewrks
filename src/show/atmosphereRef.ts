// CPU reference implementation of the persistent smoke atmosphere density-field update rule
// (plan Phase 6 step 5; spec §4.7 "Persistent atmosphere"). This module has ZERO `three`
// imports — it exists purely so `test/atmosphere.test.ts` can assert the update rule's
// numerical properties (decay constant, injection, downwind advection, no negative/NaN) without
// a GPU. `src/gpu/atmosphere.ts`'s TSL compute pass mirrors the SAME four-stage pipeline
// (inject -> advect -> diffuse -> decay, per cell) but is a separate, WGSL-emitting
// implementation — the two are not code-shared, only rule-shared. The tuning constants exported
// here are imported by `atmosphere.ts` so the two stay numerically in sync.

import { SMOKE_GRID, STAGE } from './constants';

/** 6-tap Laplacian diffusion rate (spec §4.7: "diffuses slowly" — a small k keeps the field from
 * either freezing (k=0) or blowing up (k too large relative to the explicit-Euler step). */
export const SMOKE_DIFFUSION_K = 0.08;

/** World-space standard-deviation-ish radius (meters) of the Gaussian injection splat — wide
 * enough to spread a break's contribution across a few of the coarse grid's cells rather than
 * a single spike, narrow enough to stay a local "puff" against the 600x350x200m stage. */
export const INJECT_SIGMA_M = 22;

export interface AtmosphereRefOptions {
  /** Decay time constant tau, seconds — drawn once per show from `SMOKE_DECAY_S` (spec §4.7:
   * "decays exponentially with a 60-180s time constant"). Required: this IS the quantity
   * `test/atmosphere.test.ts` recovers from the simulated decay curve. */
  tau: number;
  /** Grid resolution override, default `SMOKE_GRID` (frozen constants.ts). Tests may shrink this
   * for a fast "simulated hour" stress run — the update rule's numerical-stability property
   * (no negative/NaN) doesn't depend on resolution. */
  dims?: readonly [number, number, number];
  /** 6-tap Laplacian rate override, default `SMOKE_DIFFUSION_K`. Tests isolating pure decay set
   * this to 0 so diffusion (which is mass-conserving but not identity) doesn't confound the
   * decay-constant recovery. */
  diffusion?: number;
}

/**
 * A coarse world-space 3D density grid (spec §4.7) with the update rule spelled out as plain
 * array operations: `inject` (additive Gaussian splat) is caller-driven per event; `step` runs
 * one tick of advect (semi-Lagrangian back-trace, nearest-cell) -> diffuse (6-tap Laplacian) ->
 * decay (`*= exp(-dt/tau)`) -> clamp >= 0, exactly the plan's Phase 6 step 1 pipeline order.
 */
export class AtmosphereRef {
  readonly dims: readonly [number, number, number];
  readonly tau: number;
  readonly diffusion: number;

  private density: Float32Array;
  private advectedScratch: Float32Array; // ping-pong write target, swapped with `density` each `step()`

  constructor(opts: AtmosphereRefOptions) {
    this.dims = opts.dims ?? SMOKE_GRID;
    this.tau = opts.tau;
    this.diffusion = opts.diffusion ?? SMOKE_DIFFUSION_K;
    const [gx, gy, gz] = this.dims;
    this.density = new Float32Array(gx * gy * gz);
    this.advectedScratch = new Float32Array(gx * gy * gz);
  }

  private index(ix: number, iy: number, iz: number): number {
    const [gx, gy] = this.dims;
    return (iz * gy + iy) * gx + ix;
  }

  private clampIdx(v: number, max: number): number {
    return v < 0 ? 0 : v >= max ? max - 1 : v;
  }

  private worldToCell(pos: readonly [number, number, number]): [number, number, number] {
    const [gx, gy, gz] = this.dims;
    const ix = Math.floor(((pos[0] + STAGE.w / 2) / STAGE.w) * gx);
    const iy = Math.floor((pos[1] / STAGE.h) * gy);
    const iz = Math.floor(((pos[2] + STAGE.d / 2) / STAGE.d) * gz);
    return [this.clampIdx(ix, gx), this.clampIdx(iy, gy), this.clampIdx(iz, gz)];
  }

  private cellToWorld(ix: number, iy: number, iz: number): [number, number, number] {
    const [gx, gy, gz] = this.dims;
    return [
      ((ix + 0.5) / gx) * STAGE.w - STAGE.w / 2,
      ((iy + 0.5) / gy) * STAGE.h,
      ((iz + 0.5) / gz) * STAGE.d - STAGE.d / 2,
    ];
  }

  /** Nearest-cell density read at a world position (spec §4.7 "injection increases local
   * density" — the read side of that assertion). */
  sample(pos: readonly [number, number, number]): number {
    const [ix, iy, iz] = this.worldToCell(pos);
    return this.density[this.index(ix, iy, iz)];
  }

  /** Additive Gaussian splat centered on `position`, total-ish mass `amount` (spec §4.7: "amount
   * scaled by caliber" — the caller scales `amount`, this just spreads it). The cell RANGE to
   * touch is derived directly from a world-space bounding box around `position` (not from a
   * floor-rounded anchor cell + symmetric cell-index radius) — `position` frequently lands
   * exactly on a cell boundary (e.g. the stage center), where an anchor-relative loop would
   * include one extra cell on one side and bias the splat off-center. Density only ever goes up
   * here; `step`'s decay/diffuse are the only paths that lower it. */
  inject(position: readonly [number, number, number], amount: number): void {
    const [gx, gy, gz] = this.dims;
    const cutoff = INJECT_SIGMA_M * 3; // beyond 3 sigma the Gaussian weight is negligible
    const sigma2 = INJECT_SIGMA_M * INJECT_SIGMA_M;

    const ixLo = this.clampIdx(Math.floor(((position[0] - cutoff + STAGE.w / 2) / STAGE.w) * gx), gx);
    const ixHi = this.clampIdx(Math.ceil(((position[0] + cutoff + STAGE.w / 2) / STAGE.w) * gx), gx);
    const iyLo = this.clampIdx(Math.floor(((position[1] - cutoff) / STAGE.h) * gy), gy);
    const iyHi = this.clampIdx(Math.ceil(((position[1] + cutoff) / STAGE.h) * gy), gy);
    const izLo = this.clampIdx(Math.floor(((position[2] - cutoff + STAGE.d / 2) / STAGE.d) * gz), gz);
    const izHi = this.clampIdx(Math.ceil(((position[2] + cutoff + STAGE.d / 2) / STAGE.d) * gz), gz);

    for (let iz = izLo; iz <= izHi; iz++) {
      for (let iy = iyLo; iy <= iyHi; iy++) {
        for (let ix = ixLo; ix <= ixHi; ix++) {
          const [wx, wy, wz] = this.cellToWorld(ix, iy, iz);
          const ddx = wx - position[0];
          const ddy = wy - position[1];
          const ddz = wz - position[2];
          const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
          const weight = Math.exp(-distSq / (2 * sigma2));
          this.density[this.index(ix, iy, iz)] += amount * weight;
        }
      }
    }
  }

  /** Trilinear read of `field` at fractional cell coordinates, clamped to the grid (Neumann/
   * clamped boundary — no wraparound). Used by `step`'s semi-Lagrangian back-trace: at typical
   * per-tick wind displacements (a small fraction of one cell), a nearest-cell (rounded) sample
   * would round back to the SAME source cell every tick and never advect at all — trilinear
   * blending lets sub-cell displacement accumulate correctly tick over tick. */
  private trilinearSample(field: Float32Array, fx: number, fy: number, fz: number): number {
    const [gx, gy, gz] = this.dims;
    const cx = Math.min(Math.max(fx, 0), gx - 1);
    const cy = Math.min(Math.max(fy, 0), gy - 1);
    const cz = Math.min(Math.max(fz, 0), gz - 1);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const z0 = Math.floor(cz);
    const x1 = Math.min(gx - 1, x0 + 1);
    const y1 = Math.min(gy - 1, y0 + 1);
    const z1 = Math.min(gz - 1, z0 + 1);
    const tx = cx - x0;
    const ty = cy - y0;
    const tz = cz - z0;

    const c00 = field[this.index(x0, y0, z0)] * (1 - tx) + field[this.index(x1, y0, z0)] * tx;
    const c10 = field[this.index(x0, y1, z0)] * (1 - tx) + field[this.index(x1, y1, z0)] * tx;
    const c01 = field[this.index(x0, y0, z1)] * (1 - tx) + field[this.index(x1, y0, z1)] * tx;
    const c11 = field[this.index(x0, y1, z1)] * (1 - tx) + field[this.index(x1, y1, z1)] * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    return c0 * (1 - tz) + c1 * tz;
  }

  /** One update tick (spec §4.7 pipeline order): advect (semi-Lagrangian back-trace, trilinear
   * sample of the PREVIOUS tick's field) + diffuse (6-tap Laplacian, also of the PREVIOUS
   * field's direct neighbors) -> decay (`*= exp(-dt/tau)`) -> clamp >= 0. Both terms read only
   * `this.density` as it stood at the START of this tick (never a value this same call already
   * wrote) — the single-source-read shape a ping-pong compute pass is forced into (it cannot
   * read-after-write within one dispatch), kept here too so this reference stays a faithful
   * mirror of `atmosphere.ts`'s TSL pass rather than a CPU-only shortcut. */
  step(dt: number, wind: readonly [number, number, number]): void {
    const [gx, gy, gz] = this.dims;
    const cellW = STAGE.w / gx;
    const cellH = STAGE.h / gy;
    const cellD = STAGE.d / gz;
    const backX = (wind[0] * dt) / cellW;
    const backY = (wind[1] * dt) / cellH;
    const backZ = (wind[2] * dt) / cellD;
    const decay = Math.exp(-dt / this.tau);
    const k = this.diffusion;

    for (let iz = 0; iz < gz; iz++) {
      const zm = this.clampIdx(iz - 1, gz);
      const zp = this.clampIdx(iz + 1, gz);
      for (let iy = 0; iy < gy; iy++) {
        const ym = this.clampIdx(iy - 1, gy);
        const yp = this.clampIdx(iy + 1, gy);
        for (let ix = 0; ix < gx; ix++) {
          const xm = this.clampIdx(ix - 1, gx);
          const xp = this.clampIdx(ix + 1, gx);

          const advected = this.trilinearSample(this.density, ix - backX, iy - backY, iz - backZ);
          const c = this.density[this.index(ix, iy, iz)];
          const laplacian =
            this.density[this.index(xm, iy, iz)] +
            this.density[this.index(xp, iy, iz)] +
            this.density[this.index(ix, ym, iz)] +
            this.density[this.index(ix, yp, iz)] +
            this.density[this.index(ix, iy, zm)] +
            this.density[this.index(ix, iy, zp)] -
            6 * c;

          const decayed = (advected + k * laplacian) * decay;
          this.advectedScratch[this.index(ix, iy, iz)] = decayed > 0 ? decayed : 0;
        }
      }
    }

    // Swap the two buffers (no reallocation) — `advectedScratch` becomes the new `density`, and
    // the old `density` becomes next tick's scratch target.
    const next = this.advectedScratch;
    this.advectedScratch = this.density;
    this.density = next;
  }

  /** Sum of all cell densities — used to recover the exponential decay constant (mass decays at
   * exactly the configured rate when diffusion=0 and wind=0, since advection is then identity
   * and 6-tap diffusion, when nonzero, is itself mass-conserving under the clamped-edge/Neumann
   * boundary condition used here). */
  totalMass(): number {
    let sum = 0;
    for (let i = 0; i < this.density.length; i++) sum += this.density[i];
    return sum;
  }

  /** Density-weighted centroid in world space, or `null` for an empty field (spec §4.7 test:
   * "advection moves the density centroid downwind"). */
  centroid(): [number, number, number] | null {
    const [gx, gy, gz] = this.dims;
    let mass = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let iz = 0; iz < gz; iz++) {
      for (let iy = 0; iy < gy; iy++) {
        for (let ix = 0; ix < gx; ix++) {
          const d = this.density[this.index(ix, iy, iz)];
          if (d <= 0) continue;
          const [wx, wy, wz] = this.cellToWorld(ix, iy, iz);
          mass += d;
          sx += d * wx;
          sy += d * wy;
          sz += d * wz;
        }
      }
    }
    if (mass <= 0) return null;
    return [sx / mass, sy / mass, sz / mass];
  }

  /** Spec §4.7 test: "field never goes negative or NaN under an hour of simulated events." */
  hasNegativeOrNaN(): boolean {
    for (let i = 0; i < this.density.length; i++) {
      const v = this.density[i];
      if (!Number.isFinite(v) || v < 0) return true;
    }
    return false;
  }
}
