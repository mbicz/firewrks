// Persistent atmosphere: smoke density field + burst lights (plan Phase 6; spec §4.7).
//
// Three pieces, all owned by one `Atmosphere` instance so `debugHarness.ts`/the future show
// loop only has one object to drive per tick:
//   1. A ping-pong pair of coarse 3D storage textures (`SMOKE_GRID`) holding a scalar smoke
//      density field, updated by one fused compute pass per tick: semi-Lagrangian advection by
//      wind (trilinear-sampled — see the comment on `sampleTrilinear` for why nearest-neighbor
//      doesn't work at realistic per-tick wind displacements), 6-tap Laplacian diffusion, and
//      exponential decay, then additive Gaussian injection from up to 16 pending events. This
//      mirrors (does not share code with) `src/show/atmosphereRef.ts`'s CPU reference — same
//      four-stage rule, WGSL vs. plain-array implementations.
//   2. A small pool of non-emissive smoke sprites (spec: "low-count ... visualize the field's
//      near-term structure") whose opacity is the sampled density field, not a fixed timer.
//   3. CPU-side burst-light bookkeeping: candidates decay over 1.5s; the brightest 8 occupy
//      `BURST_LIGHTS_N` output slots with hysteresis (a slot only loses its light to a candidate
//      that beats it by 25%) and a `LIGHT_FADE_MS` crossfade on every slot reassignment, so
//      finale-speed churn never hard-pops. Slot outputs feed BOTH this class's own smoke-sprite
//      light uniforms (HG-style forward-scatter colorNode) and, via the `tick()` callbacks, the
//      caller's `ShowRenderer.setBurstLight`/`clearBurstLight` (spec: "the same top-N burst-light
//      uniforms" drive smoke AND the ground/horizon quad from ONE selection).
//
// `Atmosphere` never imports from `render.ts` (which imports FROM `sim.ts` and will import FROM
// here) — light-slot updates are pushed out via constructor-free callbacks on `tick()` to avoid a
// module cycle. `Storage3DTexture` uses `RedFormat`+`FloatType` (WebGPU `r32float`) — one of the
// three storage-texture formats writable without an optional device feature; the ping-pong reads
// go through `texture3D(...).setSampler(false)` (raw `textureLoad`, integer texel coords, same
// pattern `render.ts`'s auto-exposure compute pass already established) rather than a hardware
// sampler, since `r32float` is unfilterable by default anyway (no `float32-filterable` feature
// assumed) — manual trilinear blending (`sampleTrilinear`) is what actually supplies filtering.

import * as THREE from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  floor,
  instanceIndex,
  instancedArray,
  int,
  ivec3,
  max,
  min,
  mix,
  normalize,
  pow,
  select,
  texture3D,
  textureStore,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
  vertexStage,
} from 'three/tsl';

import { BURST_LIGHTS_N, LIGHT_FADE_MS, SMOKE_DECAY_S, SMOKE_GRID, STAGE } from '../show/constants';
import { INJECT_SIGMA_M, SMOKE_DIFFUSION_K } from '../show/atmosphereRef';
import { range as rngRange, type RNG } from '../show/rng';

// ---------------------------------------------------------------------------
// TSL node type aliases — three@0.185.0 ships no first-party `.d.ts` for `three/webgpu`/
// `three/tsl` (see `sim.ts`'s header comment for the full rationale); these three names mirror
// the same aliases already declared once each in `sim.ts` and `render.ts`.
// ---------------------------------------------------------------------------

type FloatNode = ReturnType<typeof float>;
type Vec3Node = ReturnType<typeof vec3>;
type StorageBuf = ReturnType<typeof instancedArray>;

// ---------------------------------------------------------------------------
// Grid geometry (frozen `SMOKE_GRID`) and local tuning constants — spec §4.7 describes shape and
// magnitude ("amount scaled by caliber", "~150ms fade", "1.5s decay") without pinning exact
// numbers; these are the free visual parameters, kept local like `sim.ts`/`render.ts`'s own.
// ---------------------------------------------------------------------------

const [GX, GY, GZ] = SMOKE_GRID;
const CELL_COUNT = GX * GY * GZ;
const INJECT_MAX = 16; // spec: "via event uniform list (<=16 per tick)"

const BURST_CANDIDATE_LIFE_S = 1.5; // spec: "every break for 1.5 s with intensity decay"
const HYSTERESIS_FACTOR = 1.25; // spec: "exceeds it by 25%"
const LIGHT_FADE_S = LIGHT_FADE_MS / 1000;

const HAZE_TAPS = 4; // spec: "4-tap march star->camera"
const HAZE_SCALE_MAX = 0.6; // spec: "widen scaleNode (<= +60%)"
const HAZE_EMISSIVE_MIN = 0.4; // spec: "dim emissive (down to 40%)"
const HAZE_COLOR_MIX = 0.3; // spec: "lerp color toward warm grey by haze*0.3"
const HAZE_WARM_GREY = new THREE.Color(0.55, 0.52, 0.48);
const HAZE_DENSITY_SCALE = 120; // maps a raw density sample to a normalized [0,1] haze factor

const ASCENT_INJECT_PER_STAR = 0.35; // rising-tail puff, scaled by the shell's starCount
const BREAK_INJECT_PER_STAR = 0.9; // break puff, scaled by starCount (spec: "amount scaled by caliber")

const SMOKE_CAPACITY = 96; // spec: "low-count"
const SMOKE_SPRITES_PER_BREAK = 4;
const SMOKE_SPRITE_JITTER_M = 10;
const SMOKE_SPRITE_BASE_SIZE = 26;
const SMOKE_SPRITE_GROWTH = 1.6;
const SMOKE_SPRITE_LIFE_S = 45; // individual sprite lifetime — shorter than SMOKE_DECAY_S; the
// PERSISTENT look comes from the density field itself, sprites just visualize recent structure.
const SMOKE_SPRITE_FADE_IN_S = 0.8;
const SMOKE_SPRITE_RECYCLE_GUARD_S = 1; // final second before ring-buffer reuse fades to 0 so a
// forced recycle of a still-visible slot never hard-pops.

function makeDensityTexture(): THREE.Storage3DTexture {
  const tex = new THREE.Storage3DTexture(GX, GY, GZ);
  tex.format = THREE.RedFormat;
  tex.type = THREE.FloatType;
  return tex;
}

/** `texture3D(...).setSampler(false)` — a raw `textureLoad` at integer texel coordinates (no
 * hardware sampler/filtering, no implicit derivatives), valid in every shader stage including
 * vertex/compute. Same pattern `render.ts`'s `buildExposureComputePass` already established. */
function load3D(tex: THREE.Texture, coord: Vec3Node): FloatNode {
  return texture3D(tex, coord).setSampler(false).x;
}

function loadCell(tex: THREE.Texture, ix: FloatNode, iy: FloatNode, iz: FloatNode): FloatNode {
  return load3D(tex, ivec3(int(ix), int(iy), int(iz)));
}

/** This cell's world-space center, from its integer grid coordinates. */
function cellWorldPos(ix: FloatNode, iy: FloatNode, iz: FloatNode): Vec3Node {
  return vec3(
    ix.add(0.5).div(GX).mul(STAGE.w).sub(STAGE.w / 2),
    iy.add(0.5).div(GY).mul(STAGE.h),
    iz.add(0.5).div(GZ).mul(STAGE.d).sub(STAGE.d / 2),
  );
}

/** World position -> fractional (non-integer) grid coordinates, unclamped. */
function worldToCellF(pos: Vec3Node): Vec3Node {
  return vec3(
    pos.x.add(STAGE.w / 2).div(STAGE.w).mul(GX),
    pos.y.div(STAGE.h).mul(GY),
    pos.z.add(STAGE.d / 2).div(STAGE.d).mul(GZ),
  );
}

/** Manual 8-tap trilinear sample of `tex` at fractional cell coordinates, clamped to the grid.
 * At real per-tick wind displacements (a small fraction of one ~9m cell), a nearest-cell sample
 * rounds back to the SAME source cell every tick and the field never visibly advects at all —
 * this is why `atmosphereRef.ts`'s CPU reference (and this GPU pass) both use trilinear blending
 * for the semi-Lagrangian back-trace instead of `round()`-to-nearest. */
function sampleTrilinear(tex: THREE.Texture, fracPos: Vec3Node): FloatNode {
  const cx = clamp(fracPos.x, float(0), float(GX - 1));
  const cy = clamp(fracPos.y, float(0), float(GY - 1));
  const cz = clamp(fracPos.z, float(0), float(GZ - 1));
  const x0 = floor(cx);
  const y0 = floor(cy);
  const z0 = floor(cz);
  const x1 = min(float(GX - 1), x0.add(1));
  const y1 = min(float(GY - 1), y0.add(1));
  const z1 = min(float(GZ - 1), z0.add(1));
  const tx = cx.sub(x0);
  const ty = cy.sub(y0);
  const tz = cz.sub(z0);

  const c00 = mix(loadCell(tex, x0, y0, z0), loadCell(tex, x1, y0, z0), tx);
  const c10 = mix(loadCell(tex, x0, y1, z0), loadCell(tex, x1, y1, z0), tx);
  const c01 = mix(loadCell(tex, x0, y0, z1), loadCell(tex, x1, y0, z1), tx);
  const c11 = mix(loadCell(tex, x0, y1, z1), loadCell(tex, x1, y1, z1), tx);
  const c0 = mix(c00, c10, ty);
  const c1 = mix(c01, c11, ty);
  return mix(c0, c1, tz);
}

interface DensityPassUniforms {
  windUniform: Vec3Node;
  dtUniform: FloatNode;
  tauUniform: FloatNode;
  injectPosUniform: ReturnType<typeof uniformArray>;
  injectAmountUniform: ReturnType<typeof uniformArray>;
}

/** One fused compute pass covering the whole spec §4.7 pipeline (advect -> diffuse -> decay ->
 * inject) for every cell, reading only `readTex` (the previous tick's field) and writing only
 * `writeTex` — the ping-pong shape a single dispatch is forced into (no read-after-write). Built
 * twice (A->B, B->A); `Atmosphere.tick()` alternates which one runs. */
function buildDensityPass(readTex: THREE.Storage3DTexture, writeTex: THREE.Storage3DTexture, u: DensityPassUniforms) {
  return Fn(() => {
    const ix = instanceIndex.mod(GX);
    const iy = instanceIndex.div(GX).mod(GY);
    const iz = instanceIndex.div(GX * GY);
    const ixF = float(ix);
    const iyF = float(iy);
    const izF = float(iz);
    const cellWorld = cellWorldPos(ixF, iyF, izF);

    // Advect: semi-Lagrangian back-trace, trilinear-sampled.
    const sourceWorld = cellWorld.sub(u.windUniform.mul(u.dtUniform));
    const advected = sampleTrilinear(readTex, worldToCellF(sourceWorld));

    // Diffuse: 6-tap Laplacian of `readTex`'s direct neighbors around THIS cell.
    const xm = max(ixF.sub(1), float(0));
    const xp = min(ixF.add(1), float(GX - 1));
    const ym = max(iyF.sub(1), float(0));
    const yp = min(iyF.add(1), float(GY - 1));
    const zm = max(izF.sub(1), float(0));
    const zp = min(izF.add(1), float(GZ - 1));
    const c = loadCell(readTex, ixF, iyF, izF);
    const laplacian = loadCell(readTex, xm, iyF, izF)
      .add(loadCell(readTex, xp, iyF, izF))
      .add(loadCell(readTex, ixF, ym, izF))
      .add(loadCell(readTex, ixF, yp, izF))
      .add(loadCell(readTex, ixF, iyF, zm))
      .add(loadCell(readTex, ixF, iyF, zp))
      .sub(c.mul(6));

    // Inject (up to INJECT_MAX pending events this tick) BEFORE decay, matching
    // `atmosphereRef.ts`'s `inject()`-then-`step()` call order.
    let injected = advected.add(laplacian.mul(SMOKE_DIFFUSION_K));
    const sigma2 = INJECT_SIGMA_M * INJECT_SIGMA_M;
    for (let i = 0; i < INJECT_MAX; i++) {
      const p = u.injectPosUniform.element(i);
      const amount = u.injectAmountUniform.element(i);
      const d = cellWorld.sub(p);
      const distSq = dot(d, d);
      const weight = exp(distSq.negate().div(2 * sigma2));
      injected = injected.add(amount.mul(weight));
    }

    const decay = exp(u.dtUniform.negate().div(u.tauUniform));
    const result = max(injected.mul(decay), float(0));
    textureStore(writeTex, ivec3(int(ix), int(iy), int(iz)), vec4(result, 0, 0, 1)).toWriteOnly();
  })().compute(CELL_COUNT);
}

// ---------------------------------------------------------------------------
// Burst-light candidate/slot bookkeeping (CPU-only) — spec §4.7 "Burst lights".
// ---------------------------------------------------------------------------

interface BurstCandidate {
  id: number;
  position: THREE.Vector3;
  color: THREE.Color;
  baseIntensity: number;
  bornAt: number;
}

interface LightSlot {
  candidateId: number | null;
  transitionStart: number;
  fromPos: THREE.Vector3;
  fromColor: THREE.Color;
  fromIntensity: number;
  toPos: THREE.Vector3;
  toColor: THREE.Color;
  toIntensityFrozen: number;
  displayPos: THREE.Vector3;
  displayColor: THREE.Color;
  displayIntensity: number;
}

function candidateLiveIntensity(c: BurstCandidate, now: number): number {
  const age = now - c.bornAt;
  return c.baseIntensity * Math.max(0, 1 - age / BURST_CANDIDATE_LIFE_S);
}

/**
 * Persistent atmosphere: smoke density field, smoke sprites, burst-light selection (spec §4.7).
 * One instance per show; `tick()` runs the compute pass + light-slot update once per sim tick.
 */
export class Atmosphere {
  readonly smokeSprite: THREE.Sprite;
  readonly tau: number;

  private readonly renderer: THREE.WebGPURenderer;
  private readonly rng: RNG;

  private readonly densityA = makeDensityTexture();
  private readonly densityB = makeDensityTexture();
  private currentIsA = true;

  private readonly windUniform = uniform(new THREE.Vector3());
  private readonly dtUniform = uniform(1 / 60);
  private readonly tauUniform: FloatNode;
  private readonly parityUniform = uniform(0); // 0 = densityA is current/readable, 1 = densityB
  private readonly injectPosUniform = uniformArray(
    Array.from({ length: INJECT_MAX }, () => new THREE.Vector3()),
    'vec3',
  );
  private readonly injectAmountUniform = uniformArray(new Array(INJECT_MAX).fill(0), 'float');
  private pendingInjections: { position: THREE.Vector3; amount: number }[] = [];

  private readonly passAtoB;
  private readonly passBtoA;

  private readonly smokeBirthBuf: StorageBuf = instancedArray(SMOKE_CAPACITY, 'vec4'); // xyz birthPos, w birthTime
  private readonly smokeSimTimeUniform = uniform(0);
  private smokeCursor = 0;

  private readonly lightPosUniform = uniformArray(
    Array.from({ length: BURST_LIGHTS_N }, () => new THREE.Vector3()),
    'vec3',
  );
  private readonly lightColorUniform = uniformArray(
    Array.from({ length: BURST_LIGHTS_N }, () => new THREE.Color(0, 0, 0)),
    'vec3',
  );
  private readonly lightIntensityUniform = uniformArray(new Array(BURST_LIGHTS_N).fill(0), 'float');

  private candidates: BurstCandidate[] = [];
  private nextCandidateId = 1;
  private readonly slots: LightSlot[] = Array.from({ length: BURST_LIGHTS_N }, () => ({
    candidateId: null,
    transitionStart: -1e6,
    fromPos: new THREE.Vector3(),
    fromColor: new THREE.Color(0, 0, 0),
    fromIntensity: 0,
    toPos: new THREE.Vector3(),
    toColor: new THREE.Color(0, 0, 0),
    toIntensityFrozen: 0,
    displayPos: new THREE.Vector3(),
    displayColor: new THREE.Color(0, 0, 0),
    displayIntensity: 0,
  }));

  constructor(renderer: THREE.WebGPURenderer, rng: RNG) {
    this.renderer = renderer;
    this.rng = rng;
    this.tau = rngRange(rng, SMOKE_DECAY_S); // spec: "tau drawn once per show from SMOKE_DECAY_S"
    this.tauUniform = uniform(this.tau);

    const uniforms: DensityPassUniforms = {
      windUniform: this.windUniform,
      dtUniform: this.dtUniform,
      tauUniform: this.tauUniform,
      injectPosUniform: this.injectPosUniform,
      injectAmountUniform: this.injectAmountUniform,
    };
    this.passAtoB = buildDensityPass(this.densityA, this.densityB, uniforms);
    this.passBtoA = buildDensityPass(this.densityB, this.densityA, uniforms);

    this.smokeSprite = this.buildSmokeSprite();
  }

  // ---------------------------------------------------------------------------
  // Event -> injection hooks (spec §4.7: "breaks and rising tails inject density at their
  // position (amount scaled by caliber)"). Callers pass a `starCount` proxy for caliber since
  // that's what `sim.ts`'s `BreakEvent`/launch-time recipe already carries.
  // ---------------------------------------------------------------------------

  /** Rising-tail puff at ascent start — small, no smoke sprite or burst light. */
  injectAscent(position: THREE.Vector3, starCount: number): void {
    this.queueInjection(position, starCount * ASCENT_INJECT_PER_STAR);
  }

  /** Break: larger density injection + a few smoke sprites + a burst-light candidate. */
  registerBreak(position: THREE.Vector3, color: THREE.Color, starCount: number, now: number): void {
    this.queueInjection(position, starCount * BREAK_INJECT_PER_STAR);
    this.spawnSmokeSprites(position, now);
    this.candidates.push({
      id: this.nextCandidateId++,
      position: position.clone(),
      color: color.clone(),
      baseIntensity: starCount,
      bornAt: now,
    });
  }

  private queueInjection(position: THREE.Vector3, amount: number): void {
    if (this.pendingInjections.length >= INJECT_MAX) return; // spec cap; overflow this tick is
    // simply dropped — a coarse ambient field doesn't need every simultaneous event acknowledged
    // the instant it happens, and the next tick's queue starts fresh.
    this.pendingInjections.push({ position: position.clone(), amount });
  }

  private spawnSmokeSprites(position: THREE.Vector3, now: number): void {
    const arr = this.smokeBirthBuf.value.array as Float32Array;
    for (let i = 0; i < SMOKE_SPRITES_PER_BREAK; i++) {
      const slot = this.smokeCursor;
      this.smokeCursor = (this.smokeCursor + 1) % SMOKE_CAPACITY;
      const o = slot * 4;
      arr[o] = position.x + rngRange(this.rng, [-SMOKE_SPRITE_JITTER_M, SMOKE_SPRITE_JITTER_M]);
      arr[o + 1] = position.y + rngRange(this.rng, [-SMOKE_SPRITE_JITTER_M / 2, SMOKE_SPRITE_JITTER_M / 2]);
      arr[o + 2] = position.z + rngRange(this.rng, [-SMOKE_SPRITE_JITTER_M, SMOKE_SPRITE_JITTER_M]);
      arr[o + 3] = now;
    }
    // Ring-buffer writes land at scattered slots (not one contiguous range), so the whole small
    // pool is marked dirty rather than tracking per-call sub-ranges — SMOKE_CAPACITY*4 floats is
    // a trivial upload compared to the particle pool's per-event ranges.
    this.smokeBirthBuf.value.addUpdateRange(0, SMOKE_CAPACITY * 4);
    this.smokeBirthBuf.value.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Per-tick update.
  // ---------------------------------------------------------------------------

  /**
   * Runs the density compute pass and the burst-light slot FSM for one sim tick. `wind` should
   * be the SAME vector driving particle ballistics (`ParticleSim.windVector`). `pushLight`/
   * `clearLight` mirror `ShowRenderer.setBurstLight`/`clearBurstLight` — passed as callbacks
   * (not a `ShowRenderer` reference) so this module never imports `render.ts` and creates a
   * cycle (`render.ts` imports FROM this module for the star-haze node).
   */
  tick(
    now: number,
    dt: number,
    wind: THREE.Vector3,
    pushLight: (i: number, position: THREE.Vector3, color: THREE.Color, intensity: number) => void,
    clearLight: (i: number) => void,
  ): void {
    this.dtUniform.value = dt;
    this.windUniform.value.copy(wind);
    this.smokeSimTimeUniform.value = now;

    for (let i = 0; i < INJECT_MAX; i++) {
      const ev = this.pendingInjections[i];
      if (ev) {
        this.injectPosUniform.array[i].copy(ev.position);
        this.injectAmountUniform.array[i] = ev.amount;
      } else {
        this.injectAmountUniform.array[i] = 0;
      }
    }
    this.pendingInjections = [];

    this.renderer.compute(this.currentIsA ? this.passAtoB : this.passBtoA);
    this.currentIsA = !this.currentIsA;
    this.parityUniform.value = this.currentIsA ? 0 : 1;

    this.updateBurstLights(now, pushLight, clearLight);
  }

  private updateBurstLights(
    now: number,
    pushLight: (i: number, position: THREE.Vector3, color: THREE.Color, intensity: number) => void,
    clearLight: (i: number) => void,
  ): void {
    this.candidates = this.candidates.filter((c) => now - c.bornAt < BURST_CANDIDATE_LIFE_S);
    const candidatesById = new Map(this.candidates.map((c) => [c.id, c]));

    // Slots whose candidate expired start fading to empty.
    for (const slot of this.slots) {
      if (slot.candidateId !== null && !candidatesById.has(slot.candidateId)) {
        this.beginSlotTransition(slot, null, now);
      }
    }

    // Fill empty slots with the strongest unassigned candidates (fade-in).
    const assignedIds = new Set(this.slots.map((s) => s.candidateId).filter((id): id is number => id !== null));
    const unassigned = this.candidates
      .filter((c) => !assignedIds.has(c.id))
      .sort((a, b) => candidateLiveIntensity(b, now) - candidateLiveIntensity(a, now));

    for (const slot of this.slots) {
      if (slot.candidateId === null && unassigned.length > 0) {
        this.beginSlotTransition(slot, unassigned.shift()!, now);
      }
    }

    // Hysteresis replacement: the strongest remaining unassigned candidate only bumps the
    // weakest currently-assigned slot if it exceeds it by HYSTERESIS_FACTOR (spec: "25%").
    if (unassigned.length > 0) {
      let weakestSlot: LightSlot | null = null;
      let weakestIntensity = Infinity;
      for (const slot of this.slots) {
        if (slot.candidateId === null) continue;
        const cand = candidatesById.get(slot.candidateId);
        if (!cand) continue;
        const intensity = candidateLiveIntensity(cand, now);
        if (intensity < weakestIntensity) {
          weakestIntensity = intensity;
          weakestSlot = slot;
        }
      }
      const strongest = unassigned[0];
      if (weakestSlot && candidateLiveIntensity(strongest, now) > weakestIntensity * HYSTERESIS_FACTOR) {
        this.beginSlotTransition(weakestSlot, strongest, now);
      }
    }

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const t = Math.min(1, Math.max(0, (now - slot.transitionStart) / LIGHT_FADE_S));
      if (t < 1) {
        slot.displayIntensity = slot.fromIntensity + (slot.toIntensityFrozen - slot.fromIntensity) * t;
        slot.displayPos.lerpVectors(slot.fromPos, slot.toPos, t);
        slot.displayColor.lerpColors(slot.fromColor, slot.toColor, t);
      } else {
        const cand = slot.candidateId !== null ? candidatesById.get(slot.candidateId) : undefined;
        slot.displayIntensity = cand ? candidateLiveIntensity(cand, now) : 0;
        if (cand) {
          slot.displayPos.copy(cand.position);
          slot.displayColor.copy(cand.color);
        }
      }

      this.lightPosUniform.array[i].copy(slot.displayPos);
      this.lightColorUniform.array[i].copy(slot.displayColor);
      this.lightIntensityUniform.array[i] = slot.displayIntensity;

      if (slot.displayIntensity > 1e-3) {
        pushLight(i, slot.displayPos, slot.displayColor, slot.displayIntensity);
      } else {
        clearLight(i);
      }
    }
  }

  /** Starts a `LIGHT_FADE_MS` crossfade from the slot's CURRENT displayed values to `candidate`'s
   * values as of THIS moment (frozen for the duration of the transition — see the class header
   * comment for why: freezing both endpoints keeps color/position and intensity moving together
   * so a swap never reads as a pop, only a fast handoff). `candidate: null` fades to empty. */
  private beginSlotTransition(slot: LightSlot, candidate: BurstCandidate | null, now: number): void {
    slot.fromPos.copy(slot.displayPos);
    slot.fromColor.copy(slot.displayColor);
    slot.fromIntensity = slot.displayIntensity;
    slot.candidateId = candidate ? candidate.id : null;
    slot.toPos.copy(candidate ? candidate.position : slot.fromPos);
    slot.toColor.copy(candidate ? candidate.color : slot.fromColor);
    slot.toIntensityFrozen = candidate ? candidateLiveIntensity(candidate, now) : 0;
    slot.transitionStart = now;
  }

  // ---------------------------------------------------------------------------
  // Density read (shared by the smoke sprite material below and `render.ts`'s star haze).
  // ---------------------------------------------------------------------------

  /** TSL density read at an arbitrary world position, trilinear-interpolated, always reading
   * whichever ping-pong texture the last `tick()` wrote (selected via `parityUniform` so this
   * node graph doesn't need rebuilding when the current texture swaps). */
  sampleDensityNode(worldPos: Vec3Node): FloatNode {
    const fracPos = worldToCellF(worldPos);
    const sampleA = sampleTrilinear(this.densityA, fracPos);
    const sampleB = sampleTrilinear(this.densityB, fracPos);
    return select(this.parityUniform.equal(0), sampleA, sampleB);
  }

  // ---------------------------------------------------------------------------
  // Smoke sprites: spec §4.7 step 2 — non-emissive, opacity = sampled density x age fade.
  // ---------------------------------------------------------------------------

  private buildSmokeSprite(): THREE.Sprite {
    const material = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending, // NOT additive — smoke occludes/blends, it doesn't glow
    });

    const birth = this.smokeBirthBuf.toAttribute();
    const age = this.smokeSimTimeUniform.sub(birth.w);
    const alive = age.greaterThanEqual(0).and(age.lessThan(SMOKE_SPRITE_LIFE_S));
    const drifted = vertexStage(birth.xyz.add(this.windUniform.mul(max(age, float(0)))));

    const ageFrac = clamp(age.div(SMOKE_SPRITE_LIFE_S), float(0), float(1));
    const growth = mix(float(1), float(SMOKE_SPRITE_GROWTH), ageFrac);
    const fadeIn = clamp(age.div(SMOKE_SPRITE_FADE_IN_S), float(0), float(1));
    const recycleGuard = clamp(float(SMOKE_SPRITE_LIFE_S).sub(age).div(SMOKE_SPRITE_RECYCLE_GUARD_S), float(0), float(1));
    const density = vertexStage(this.sampleDensityNode(drifted));

    const viewDir = normalize(cameraPosition.sub(drifted));
    let lit = vec3(0, 0, 0);
    for (let i = 0; i < BURST_LIGHTS_N; i++) {
      const lightPos = this.lightPosUniform.element(i);
      const lightColor = this.lightColorUniform.element(i);
      const lightIntensity = this.lightIntensityUniform.element(i);
      const toLight = lightPos.sub(drifted);
      const distSq = dot(toLight, toLight).add(1); // spec: "I/(d^2+1)"
      const lightDir = normalize(toLight);
      const forwardBoost = float(1).add(float(2.5).mul(pow(max(dot(lightDir, viewDir), float(0)), float(4)))); // HG-style
      lit = lit.add(lightColor.mul(lightIntensity.div(distSq)).mul(forwardBoost));
    }

    material.positionNode = drifted;
    material.scaleNode = vec2(SMOKE_SPRITE_BASE_SIZE, SMOKE_SPRITE_BASE_SIZE).mul(growth);
    material.colorNode = lit;
    material.opacityNode = density.mul(fadeIn).mul(recycleGuard).mul(select(alive, float(1), float(0)));
    // Deliberately NO `material.emissiveNode` assignment — smoke stays out of the bloom-driving
    // emissive MRT channel (spec: "smoke sprites render in the non-emissive channel").

    const sprite = new THREE.Sprite(material);
    sprite.count = SMOKE_CAPACITY;
    sprite.frustumCulled = false;
    return sprite;
  }
}

/** Spec §4.7 star haze: 4-tap march from a star's world position toward the camera through the
 * density field, averaged into one scalar — computed ONCE PER INSTANCE via `vertexStage()` (not
 * inside `colorNode`/`opacityNode`, where glow-disc overdraw would multiply the 3D taps across
 * every covered fragment). `render.ts` reuses the returned node in both vertex-stage (`scaleNode`
 * widening) and fragment-stage (`colorNode`/`emissiveNode` dimming) contexts; three.js threads a
 * `vertexStage()`-wrapped node through as an interpolated varying rather than recomputing it. */
export function buildStarHazeNode(atmosphere: Atmosphere, starPosAttr: Vec3Node): FloatNode {
  const toCamera = cameraPosition.sub(starPosAttr);
  let sum = float(0);
  for (let i = 0; i < HAZE_TAPS; i++) {
    const frac = (i + 0.5) / HAZE_TAPS;
    const samplePos = starPosAttr.add(toCamera.mul(frac));
    sum = sum.add(atmosphere.sampleDensityNode(samplePos));
  }
  const rawHaze = sum.div(HAZE_TAPS);
  return vertexStage(clamp(rawHaze.div(HAZE_DENSITY_SCALE), float(0), float(1)));
}

/** Widens `scaleNode` by up to `HAZE_SCALE_MAX` given the normalized haze factor from
 * `buildStarHazeNode` — vertex-stage-safe (haze is already a `vertexStage()` varying). */
export function hazeScaleMultiplier(haze: FloatNode): FloatNode {
  return mix(float(1), float(1 + HAZE_SCALE_MAX), haze);
}

/** Dims emissive intensity down to `HAZE_EMISSIVE_MIN` given the normalized haze factor. */
export function hazeEmissiveMultiplier(haze: FloatNode): FloatNode {
  return mix(float(1), float(HAZE_EMISSIVE_MIN), haze);
}

/** Lerps `color` toward a warm grey by `haze * HAZE_COLOR_MIX`, per spec §4.7. */
export function hazeColorLerp(color: Vec3Node, haze: FloatNode): Vec3Node {
  return mix(color, vec3(HAZE_WARM_GREY.r, HAZE_WARM_GREY.g, HAZE_WARM_GREY.b), haze.mul(HAZE_COLOR_MIX));
}
