// GPU simulation core (plan Phase 4; spec §2 timestep, §4.5 Simulation, §4.6 Imperfection layer, §5).
// Fixed particle pool in `instancedArray` storage buffers, advanced by TSL compute passes at a
// fixed 60 Hz sim tick. CPU never touches per-particle state in the steady-state loop — the only
// CPU->GPU traffic is one small `addUpdateRange`/`needsUpdate` upload per launch/break/split event
// (via the Phase 3 `Allocator`/`reserveChildRange` slot ranges) plus a handful of global uniforms
// (sim time, wind). See `tick()` and `launch()` below for the guard comments this enforces.
//
// three@0.185.0 ships no first-party `.d.ts` for `three/webgpu` / `three/tsl` — TypeScript infers
// their shapes structurally from the JS source. The aliases below name each such inferred shape
// once so the rest of this module reads like it has real types, instead of repeating
// `ReturnType<typeof …>` at every call site.
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  instanceIndex,
  instancedArray,
  int,
  length,
  float,
  select,
  sin,
  smoothstep,
  clamp,
  mix,
  mx_fractal_noise_vec3,
  uniform,
  vec3,
} from 'three/tsl';

import { Allocator, reserveChildRange, type SlotRange } from '../show/allocator';
import type { BreakFamily, CatalogEntry } from '../show/catalog';
import { compile, type GpuRecipe } from '../show/compiler';
import { G, LAUNCH_TILT_DEG, SIM_HZ } from '../show/constants';
import { range as rngRange, type RNG } from '../show/rng';

// ---------------------------------------------------------------------------
// TSL node type aliases (see header comment for why these exist).
// ---------------------------------------------------------------------------

type FloatNode = ReturnType<typeof float>;
type Vec3Node = ReturnType<typeof vec3>;
type StorageBuf = ReturnType<typeof instancedArray>;
type ElementIndex = Parameters<StorageBuf['element']>[0];

function buildComputePass(body: () => void, count: number) {
  return Fn(body)().compute(count);
}
type ComputePass = ReturnType<typeof buildComputePass>;

// ---------------------------------------------------------------------------
// Particle class / role vocabulary (spec §4.5: "class flags (star | trail spark | crackle
// micro-flash | smoke)"). `classId` drives render channel selection; `role` (behavior.x) drives
// physics (drag/gravity/terminal transitions) and is independent of render class.
// ---------------------------------------------------------------------------

export const CLASS = { STAR: 0, TRAIL: 1, CRACKLE: 2, SMOKE: 3 } as const;
export const ROLE = { SHELL: 0, STAR: 1, WILLOW: 2, HORSETAIL: 3 } as const;

// ---------------------------------------------------------------------------
// Tuning constants (local to the sim — not part of the frozen `constants.ts` numeric table).
// ---------------------------------------------------------------------------

export const DT = 1 / SIM_HZ;
const DT_NODE = float(DT);

const CURL_FREQ = 0.015; // 1/m — macro turbulence wavelength (~65 m), §5.1
const CURL_EPS = 0.6; // finite-difference step (world meters) for the curl-noise gradient
const CURL_STRENGTH = 3.5; // m/s^2 base turbulence acceleration before per-role gain

const POINT_SIZE = 2.5; // debug point-render size (world units, ~2-3 px at the spec camera dist)
const EMBER_RGB: readonly [number, number, number] = [0.227, 0.063, 0.024]; // #3a1006, spec §3.6

/** Ideal (no-drag) launch speed reaching `apexHeight` at `riseTime`, from kinematics
 * h = v0*t - 0.5*g*t^2 solved for v0 — a deliberate approximation (real flight also has drag),
 * good enough to visually apex near fuseTime per the DoD ("ascends 2-3s ... breaks at fuse time"). */
function launchSpeed(apexHeight: number, riseTime: number): number {
  return apexHeight / riseTime + 0.5 * G * riseTime;
}

function roleForFamily(family: BreakFamily): number {
  if (family === 'willow') return ROLE.WILLOW;
  if (family === 'horsetail') return ROLE.HORSETAIL;
  return ROLE.STAR;
}

type Triple = [number, number, number];

/** Arbitrary orthonormal basis perpendicular to unit-ish direction `(dx,dy,dz)` — used to fan
 * crossette secondary tails radially around a primary star's travel direction. */
function perpendicularBasis(dx: number, dy: number, dz: number): [Triple, Triple] {
  const len = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / len;
  const ny = dy / len;
  const nz = dz / len;
  const refX = Math.abs(ny) > 0.9 ? 1 : 0;
  const refY = Math.abs(ny) > 0.9 ? 0 : 1;

  let b1x = ny * 0 - nz * refY;
  let b1y = nz * refX - nx * 0;
  let b1z = nx * refY - ny * refX;
  const b1Len = Math.hypot(b1x, b1y, b1z) || 1;
  b1x /= b1Len;
  b1y /= b1Len;
  b1z /= b1Len;

  const b2x = ny * b1z - nz * b1y;
  const b2y = nz * b1x - nx * b1z;
  const b2z = nx * b1y - ny * b1x;

  return [
    [b1x, b1y, b1z],
    [b2x, b2y, b2z],
  ];
}

// ---------------------------------------------------------------------------
// TSL helpers shared by the compute passes and (for the debug material) the render color ramp.
// ---------------------------------------------------------------------------

/** 3-octave value/perlin fractal-noise vector potential (spec §4.6/§5.1: "3-octave value-noise
 * gradient"), offset per-particle by `seedScalar` (its `seedHash`) so every particle rides a
 * distinct turbulence field despite sharing one global noise function. */
function curlPotential(p: Vec3Node, seedScalar: FloatNode): Vec3Node {
  const offset = vec3(seedScalar.mul(13.1).add(1.7), seedScalar.mul(7.3).add(91.3), seedScalar.mul(3.7).add(51.1));
  return mx_fractal_noise_vec3(p.mul(CURL_FREQ).add(offset), int(3), float(2.0), float(0.5));
}

/** Curl of the noise potential via central finite differences (Bridson's method) — divergence-free
 * by construction, so it turbulently advects without ever pulling particles apart or together
 * (spec §5.1: "no straight-line traces anywhere"). */
function curlNoise(p: Vec3Node, seedScalar: FloatNode): Vec3Node {
  const e = CURL_EPS;
  const px0 = curlPotential(p.sub(vec3(e, 0, 0)), seedScalar);
  const px1 = curlPotential(p.add(vec3(e, 0, 0)), seedScalar);
  const py0 = curlPotential(p.sub(vec3(0, e, 0)), seedScalar);
  const py1 = curlPotential(p.add(vec3(0, e, 0)), seedScalar);
  const pz0 = curlPotential(p.sub(vec3(0, 0, e)), seedScalar);
  const pz1 = curlPotential(p.add(vec3(0, 0, e)), seedScalar);

  const cx = py1.z.sub(py0.z).sub(pz1.y.sub(pz0.y));
  const cy = pz1.x.sub(pz0.x).sub(px1.z.sub(px0.z));
  const cz = px1.y.sub(px0.y).sub(py1.x.sub(py0.x));

  return vec3(cx, cy, cz).mul(1 / (2 * e));
}

/** Per-role/class turbulence gain (spec §5.1: "trail sparks >> heavy comet stars"). */
function turbulenceGain(role: FloatNode, classId: FloatNode): FloatNode {
  return select(
    classId.equal(float(CLASS.TRAIL)),
    float(1.6),
    select(
      role.equal(float(ROLE.SHELL)),
      float(0.8),
      select(role.equal(float(ROLE.WILLOW)), float(0.9), select(role.equal(float(ROLE.HORSETAIL)), float(0.35), float(0.7))),
    ),
  );
}

/** Quadratic-drag coefficient by role, modulated by the `terminal` transition flag: willow drag
 * increases sharply once terminal (low-density stars quickly hit a slow terminal velocity -> the
 * long graceful "hang"); horsetail drag drops once terminal (heavy stars keep falling fast). */
function dragForRole(role: FloatNode, terminal: FloatNode): FloatNode {
  const base = select(
    role.equal(float(ROLE.SHELL)),
    float(0.0006),
    select(role.equal(float(ROLE.WILLOW)), float(0.00035), select(role.equal(float(ROLE.HORSETAIL)), float(0.0009), float(0.0012))),
  );
  const willowHang = select(role.equal(float(ROLE.WILLOW)).and(terminal.greaterThan(0)), float(6.0), float(1.0));
  const horsetailFall = select(role.equal(float(ROLE.HORSETAIL)).and(terminal.greaterThan(0)), float(0.4), float(1.0));
  return base.mul(willowHang).mul(horsetailFall);
}

/** Horsetail's "heavy-mass fall" (spec §4.5) once terminal: effective gravity multiplier. */
function gravityMultiplier(role: FloatNode, terminal: FloatNode): FloatNode {
  return select(role.equal(float(ROLE.HORSETAIL)).and(terminal.greaterThan(0)), float(2.0), float(1.0));
}

/** Global wind + slowly-varying gust noise (spec §5.8), damped for trail sparks which should
 * mostly follow their own turbulence rather than get swept wholesale by the wind field. */
function windNode(windBase: Vec3Node, simTime: FloatNode, classId: FloatNode): Vec3Node {
  const gust = mx_fractal_noise_vec3(vec3(simTime.mul(0.07), float(0), float(0)), int(2), float(2.0), float(0.5)).mul(1.2);
  const wind = windBase.add(gust);
  return wind.mul(select(classId.equal(float(CLASS.TRAIL)), float(0.3), float(1.0)));
}

/** Three-phase color ramp (ignition white -> agent color -> charcoal ember, spec §3.6) plus a
 * per-star flicker (spec §5.2 "brightness flicker via per-star phase-offset noise"). Shared by the
 * debug point material here and reusable by Phase 5's real render material. */
export function colorRampNode(baseColor: Vec3Node, age: FloatNode, life: FloatNode, flickerPhase: FloatNode, simTime: FloatNode): Vec3Node {
  const t = clamp(age.div(float(1e-4).max(life)), float(0), float(1));
  const ignition = vec3(1, 1, 1);
  const ember = vec3(...EMBER_RGB);
  const toAgent = smoothstep(float(0.0), float(0.1), t);
  const toEmber = smoothstep(float(0.55), float(1.0), t);
  const c1 = mix(ignition, baseColor, toAgent);
  const c2 = mix(c1, ember, toEmber);
  const flicker = float(0.8).add(float(0.2).mul(sin(simTime.mul(28.0).add(flickerPhase.mul(6.2832)))));
  return c2.mul(flicker);
}

export function aliveMask(age: FloatNode, life: FloatNode) {
  return age.greaterThanEqual(float(0)).and(age.lessThan(life));
}

// ---------------------------------------------------------------------------
// ParticleSim
// ---------------------------------------------------------------------------

interface ChildAllocation {
  range: SlotRange;
  parentIndices: Int32Array;
}

/** Per-particle debug readback snapshot (see `ParticleSim.readback`). */
export interface ParticleState {
  position: Float32Array;
  age: Float32Array;
  life: Float32Array;
  spawnMeta: Float32Array;
  behavior: Float32Array;
}

/** Buffers/uniforms `src/gpu/render.ts` (plan Phase 5) needs to build the production sprite
 * material — the contract `ParticleSim.renderBuffers` exposes; see that getter's comment. */
export interface RenderBuffers {
  position: StorageBuf;
  prevPosition: StorageBuf;
  color: StorageBuf;
  age: StorageBuf;
  life: StorageBuf;
  behavior: StorageBuf;
  simTime: FloatNode;
}

export class ParticleSim {
  readonly capacity: number;
  readonly allocator: Allocator;
  readonly sprite: THREE.Sprite;

  private readonly renderer: THREE.WebGPURenderer;

  private readonly positionBuf: StorageBuf;
  private readonly prevPositionBuf: StorageBuf;
  private readonly velocityBuf: StorageBuf;
  private readonly colorBuf: StorageBuf;
  private readonly ageBuf: StorageBuf;
  private readonly lifeBuf: StorageBuf;
  private readonly spawnMetaBuf: StorageBuf; // (parentIndex, spawnTime, classId)
  private readonly behaviorBuf: StorageBuf; // (role, dudFlag, terminalFlag, flickerPhase)
  private readonly seedHashBuf: StorageBuf;

  private readonly simTimeUniform: FloatNode;
  private readonly windUniform: Vec3Node;

  private readonly passParentsIntegrate: ComputePass;
  private readonly passActivation: ComputePass;
  private readonly passBallistics: ComputePass;
  private readonly passEvents: ComputePass;
  private readonly passLifecycle: ComputePass;

  constructor(renderer: THREE.WebGPURenderer, capacity: number) {
    this.renderer = renderer;
    this.capacity = capacity;
    this.allocator = new Allocator(capacity);

    // NOTE: declared 'vec4' (not 'vec3') for position/prevPosition/velocity/color/spawnMeta.
    // three@0.185.0's WebGPU backend pads any 'vec3' STORAGE buffer to a 4-float stride on first
    // use (WGSL disallows packed vec3 in storage blocks) by replacing `attribute.array` in place
    // (see WebGPUAttributeUtils.js `createAttribute`) — but its `updateAttribute` path re-derives
    // that same padding from `attribute.array` on every SUBSEQUENT dirty write, using the ORIGINAL
    // stride even though `.array` is by then already padded, corrupting the buffer on any update
    // after the first (confirmed empirically: launch-time writes scrambled on readback). A vec4
    // buffer is never padding-eligible (itemSize is already 4), which sidesteps the bug entirely;
    // the unused 4th component is always written/left as 0 and ignored via `.xyz` everywhere else.
    this.positionBuf = instancedArray(capacity, 'vec4');
    this.prevPositionBuf = instancedArray(capacity, 'vec4');
    this.velocityBuf = instancedArray(capacity, 'vec4');
    this.colorBuf = instancedArray(capacity, 'vec4');
    this.ageBuf = instancedArray(capacity, 'float');
    this.lifeBuf = instancedArray(capacity, 'float');
    this.spawnMetaBuf = instancedArray(capacity, 'vec4'); // (parentIndex, spawnTime, classId, _unused)
    this.behaviorBuf = instancedArray(capacity, 'vec4');
    this.seedHashBuf = instancedArray(capacity, 'float');

    this.simTimeUniform = uniform(0);
    this.windUniform = uniform(new THREE.Vector3(2.0, 0, 0.6));

    this.initSentinelState();

    // Compute pass order per tick (60 Hz accumulator; plan Phase 4 step 2 / spec §4.5):
    //   (a) parents integrate — full ballistics for every PARTICLE ALREADY LIVE before this tick
    //       (age > 0). This is what makes them "parents": their position/velocity is now this
    //       tick's, so...
    //   (b) activation — slots pending spawn (age < 0, spawnTime <= simTime) copy their parent's
    //       state. Parents are already advanced by (a); children of THIS tick therefore read
    //       post-advance parent state, never last tick's stale position (documented choice).
    //   (c) ballistics — the SAME integration as (a), applied only to particles with age === 0,
    //       i.e. exactly the slots (b) just activated this tick. This gives new children their own
    //       first physics step without double-integrating the established parents (a) already
    //       advanced once.
    //   (d) events — fuse-timed state flips: shell -> broken once its own age reaches its life
    //       (=fuseTime); willow -> low-drag hang / horsetail -> high-mass fall once past an
    //       ageFrac threshold. Breaks trigger on fuseTime only, never screen height.
    //   (e) lifecycle — age += dt; dud stars age at an accelerated rate, forcing an early fade.
    this.passParentsIntegrate = buildComputePass(() => {
      const age = this.ageBuf.element(instanceIndex);
      If(age.greaterThan(0), () => this.integrateStep(instanceIndex));
    }, capacity);

    this.passActivation = buildComputePass(() => {
      const age = this.ageBuf.element(instanceIndex);
      const meta = this.spawnMetaBuf.element(instanceIndex);
      If(age.lessThan(0).and(meta.y.lessThanEqual(this.simTimeUniform)), () => {
        If(meta.x.greaterThanEqual(0), () => {
          const parentIdx = int(meta.x);
          const parentPos = this.positionBuf.element(parentIdx);
          const parentVel = this.velocityBuf.element(parentIdx);
          const pos = this.positionBuf.element(instanceIndex);
          const prevPos = this.prevPositionBuf.element(instanceIndex);
          const vel = this.velocityBuf.element(instanceIndex);
          pos.xyz.assign(parentPos.xyz);
          vel.xyz.assign(vel.xyz.add(parentVel.xyz)); // pre-loaded ejection velocity + parent's velocity
          prevPos.xyz.assign(pos.xyz);
        });
        age.assign(0);
      });
    }, capacity);

    this.passBallistics = buildComputePass(() => {
      const age = this.ageBuf.element(instanceIndex);
      If(age.equal(0), () => this.integrateStep(instanceIndex));
    }, capacity);

    this.passEvents = buildComputePass(() => {
      const age = this.ageBuf.element(instanceIndex);
      If(age.greaterThanEqual(0), () => {
        const life = this.lifeBuf.element(instanceIndex);
        const behavior = this.behaviorBuf.element(instanceIndex);
        const role = behavior.x;
        const terminal = behavior.z;
        const ageFrac = age.div(float(1e-4).max(life));

        If(role.equal(float(ROLE.SHELL)).and(age.greaterThanEqual(life)).and(terminal.equal(0)), () => {
          terminal.assign(1); // shell has broken; render layer treats terminal shells as spent
        });
        If(role.equal(float(ROLE.WILLOW)).and(ageFrac.greaterThan(0.25)).and(terminal.equal(0)), () => {
          terminal.assign(1);
        });
        If(role.equal(float(ROLE.HORSETAIL)).and(ageFrac.greaterThan(0.15)).and(terminal.equal(0)), () => {
          terminal.assign(1);
        });
      });
    }, capacity);

    this.passLifecycle = buildComputePass(() => {
      const age = this.ageBuf.element(instanceIndex);
      If(age.greaterThanEqual(0), () => {
        const behavior = this.behaviorBuf.element(instanceIndex);
        const dud = behavior.y;
        const rate = select(dud.greaterThan(0), float(9.0), float(1.0)); // dud stars fade early (§5.4)
        age.assign(age.add(DT_NODE.mul(rate)));
      });
    }, capacity);

    const material = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ageAttr = this.ageBuf.toAttribute();
    const lifeAttr = this.lifeBuf.toAttribute();
    const alive = aliveMask(ageAttr, lifeAttr);
    material.positionNode = this.positionBuf.toAttribute().xyz;
    material.colorNode = colorRampNode(this.colorBuf.toAttribute().xyz, ageAttr, lifeAttr, this.behaviorBuf.toAttribute().w, this.simTimeUniform);
    material.scaleNode = select(alive, float(POINT_SIZE), float(0));
    material.opacityNode = select(alive, float(1), float(0));

    this.sprite = new THREE.Sprite(material);
    this.sprite.count = capacity;
    this.sprite.frustumCulled = false;
  }

  // ---------------------------------------------------------------------------
  // Minimal read-only accessor for `src/gpu/render.ts` (plan Phase 5): the production
  // renderer builds its OWN material/sprite/post pipeline from this bundle of buffers/
  // uniforms rather than this class's debug point material above — no compute-pass or
  // buffer-layout changes, one additive getter only (plan Phase 5 guard: "add a minimal
  // getter rather than restructuring the class").
  // ---------------------------------------------------------------------------

  get renderBuffers(): RenderBuffers {
    return {
      position: this.positionBuf,
      prevPosition: this.prevPositionBuf,
      color: this.colorBuf,
      age: this.ageBuf,
      life: this.lifeBuf,
      behavior: this.behaviorBuf,
      simTime: this.simTimeUniform,
    };
  }

  /** Ballistics integration shared by pass (a) and pass (c): gravity + wind + curl noise, quadratic
   * drag opposing velocity, semi-implicit Euler (spec §2, §4.5). Division-by-zero is avoided (never
   * `normalize()` on a possibly-zero velocity) so a freshly-activated, still-motionless particle
   * never produces a NaN — the debug NaN scan (`scanForNaN`) is what catches a regression here. */
  private integrateStep(idx: ElementIndex): void {
    const pos = this.positionBuf.element(idx);
    const prevPos = this.prevPositionBuf.element(idx);
    const vel = this.velocityBuf.element(idx);
    const seedHash = this.seedHashBuf.element(idx);
    const behavior = this.behaviorBuf.element(idx);
    const meta = this.spawnMetaBuf.element(idx);
    const role = behavior.x;
    const terminal = behavior.z;
    const classId = meta.z;

    const gain = turbulenceGain(role, classId);
    const curl = curlNoise(pos.xyz, seedHash).mul(CURL_STRENGTH).mul(gain);
    const wind = windNode(this.windUniform, this.simTimeUniform, classId);
    const gravity = vec3(0, -G, 0).mul(gravityMultiplier(role, terminal));

    const speed = length(vel.xyz);
    const dir = vel.xyz.div(float(1e-4).max(speed)); // safe direction; never a bare normalize()
    const dragAccel = dir.mul(speed.mul(speed)).mul(dragForRole(role, terminal));

    const newVel = vel.xyz.add(gravity.add(wind).add(curl).mul(DT_NODE)).sub(dragAccel.mul(DT_NODE));
    vel.xyz.assign(newVel);
    prevPos.xyz.assign(pos.xyz);
    pos.xyz.assign(pos.xyz.add(newVel.mul(DT_NODE)));
  }

  /** One-time full-buffer initialization: every slot starts inactive (`age = -1`) with `spawnTime`
   * pinned far in the future so an unreserved slot can never satisfy `spawnTime <= simTime` and
   * spuriously "activate" against garbage (zero-initialized) parent data. Not steady-state traffic —
   * runs once at construction, before the show starts. */
  private initSentinelState(): void {
    const n = this.capacity;
    const ageArr = this.ageBuf.value.array;
    const metaArr = this.spawnMetaBuf.value.array;
    ageArr.fill(-1);
    for (let i = 0; i < n; i++) {
      metaArr[i * 4] = -1;
      metaArr[i * 4 + 1] = 1e12;
      metaArr[i * 4 + 2] = CLASS.STAR;
    }
    this.ageBuf.value.addUpdateRange(0, n);
    this.ageBuf.value.needsUpdate = true;
    this.spawnMetaBuf.value.addUpdateRange(0, n * 4);
    this.spawnMetaBuf.value.needsUpdate = true;
  }

  /** Writes (x,y,z) into a vec4-declared buffer's `.xyz`, leaving `.w` at 0 (see the vec4-not-vec3
   * note on the buffer declarations above for why every "vec3" buffer here is actually vec4). */
  private writeVec3(buf: StorageBuf, index: number, x: number, y: number, z: number): void {
    const arr = buf.value.array;
    const o = index * 4;
    arr[o] = x;
    arr[o + 1] = y;
    arr[o + 2] = z;
    arr[o + 3] = 0;
  }

  private writeVec4(buf: StorageBuf, index: number, x: number, y: number, z: number, w: number): void {
    const arr = buf.value.array;
    const o = index * 4;
    arr[o] = x;
    arr[o + 1] = y;
    arr[o + 2] = z;
    arr[o + 3] = w;
  }

  private writeScalar(buf: StorageBuf, index: number, v: number): void {
    buf.value.array[index] = v;
  }

  private markDirty(buf: StorageBuf, range: SlotRange): void {
    const itemSize = buf.value.itemSize;
    buf.value.addUpdateRange(range.start * itemSize, range.count * itemSize);
    buf.value.needsUpdate = true;
  }

  private markDirtyAll(range: SlotRange): void {
    this.markDirty(this.positionBuf, range);
    this.markDirty(this.prevPositionBuf, range);
    this.markDirty(this.velocityBuf, range);
    this.markDirty(this.colorBuf, range);
    this.markDirty(this.ageBuf, range);
    this.markDirty(this.lifeBuf, range);
    this.markDirty(this.spawnMetaBuf, range);
    this.markDirty(this.behaviorBuf, range);
    this.markDirty(this.seedHashBuf, range);
  }

  /**
   * Compiles `entry.phases[phaseIdx]` and uploads it as one launch event: a single "shell" slot
   * (the ascending pseudo-particle CPU writes directly) plus a pre-reserved child range of
   * `starCount` break stars (spec §4.5 "Emission (parent-index indirection)"), and — depending on
   * the recipe — pre-reserved crossette/trail/crackle child ranges, each with its own baked-in
   * jittered `spawnTime`. This is the ONLY per-event CPU->GPU write path; nothing here runs per
   * tick. Returns `false` (never overwrites a live range) when the pool has no room, matching the
   * allocator's defer contract.
   */
  launch(entry: CatalogEntry, phaseIdx: number, rng: RNG, now: number, launchX: number, launchZ: number): boolean {
    const family = entry.phases[phaseIdx]?.breakFamily;
    if (!family) throw new Error(`ParticleSim.launch: phase ${phaseIdx} of "${entry.id}" has no breakFamily`);
    const recipe = compile(entry, phaseIdx, rng);

    let maxStarLife = 0;
    for (const l of recipe.lifetimes) if (l > maxStarLife) maxStarLife = l;

    const shellRange = this.allocator.reserve(CLASS.STAR, 1, now, recipe.fuseTime);
    if (!shellRange) return false;

    const starsChild = reserveChildRange(this.allocator, shellRange, CLASS.STAR, recipe.starCount, now, maxStarLife);
    if (!starsChild) return false;

    this.writeShell(shellRange, recipe, launchX, launchZ, now, rng);
    this.writeStars(starsChild, recipe, roleForFamily(family), now, rng);

    if (recipe.secondary?.kind === 'crossette') {
      const crossChild = reserveChildRange(
        this.allocator,
        starsChild.range,
        CLASS.TRAIL,
        recipe.secondary.count,
        now,
        maxStarLife * 0.5,
        1, // trailLag: 1s for trail-classed slots (plan Phase 3 step 4)
      );
      if (crossChild) this.writeCrossette(crossChild, starsChild.range, recipe, now, rng);
    }

    if (recipe.trailEmissionRate > 0) {
      const perParent = Math.max(1, Math.round(recipe.trailEmissionRate * recipe.riseTime));
      const trailChild = reserveChildRange(this.allocator, shellRange, CLASS.TRAIL, perParent, now, 0.9, 1);
      if (trailChild) this.writeTrail(trailChild, recipe, now, rng);
    }

    if (recipe.flags.crackle) {
      const crackleChild = reserveChildRange(this.allocator, starsChild.range, CLASS.CRACKLE, 3, now, 0.25, 1);
      if (crackleChild) this.writeCrackle(crackleChild, starsChild.range, recipe, now, rng);
    }

    return true;
  }

  private writeShell(range: SlotRange, recipe: GpuRecipe, launchX: number, launchZ: number, now: number, rng: RNG): void {
    // Ascent wobble (spec §5.7): launch tilt +-LAUNCH_TILT_DEG around a random horizontal axis,
    // plus per-shell thrust asymmetry from the unique curl-noise offset `seedHash` gives this
    // particle — together producing an individually curved rise path, not a straight line.
    const tiltRad = (rngRange(rng, [-LAUNCH_TILT_DEG, LAUNCH_TILT_DEG]) * Math.PI) / 180;
    const axisAngle = rng() * Math.PI * 2;
    const dirX = Math.sin(tiltRad) * Math.cos(axisAngle);
    const dirZ = Math.sin(tiltRad) * Math.sin(axisAngle);
    const dirY = Math.cos(tiltRad);
    const v0 = launchSpeed(recipe.apexHeight, recipe.riseTime);

    const i = range.start;
    this.writeVec3(this.positionBuf, i, launchX, 0, launchZ);
    this.writeVec3(this.prevPositionBuf, i, launchX, 0, launchZ);
    this.writeVec3(this.velocityBuf, i, dirX * v0, dirY * v0, dirZ * v0);
    this.writeVec3(this.colorBuf, i, recipe.colorRamp[3], recipe.colorRamp[4], recipe.colorRamp[5]);
    this.writeScalar(this.ageBuf, i, -1);
    this.writeScalar(this.lifeBuf, i, recipe.fuseTime);
    this.writeVec3(this.spawnMetaBuf, i, -1, now, CLASS.STAR);
    this.writeVec4(this.behaviorBuf, i, ROLE.SHELL, 0, 0, rng());
    this.writeScalar(this.seedHashBuf, i, rng());
    this.markDirtyAll(range);
  }

  private writeStars(child: ChildAllocation, recipe: GpuRecipe, role: number, now: number, rng: RNG): void {
    const { range, parentIndices } = child;
    const spawnTime = now + recipe.fuseTime;
    for (let k = 0; k < range.count; k++) {
      const i = range.start + k;
      const dx = recipe.starDirections[k * 3];
      const dy = recipe.starDirections[k * 3 + 1];
      const dz = recipe.starDirections[k * 3 + 2];
      const speed = recipe.starSpeeds[k];
      const dud = rng() < recipe.flags.dudProbability ? 1 : 0;

      // Position/prevPosition are irrelevant pre-activation (overwritten with the parent shell's
      // position when the activation pass copies its state); velocity here is the star's OWN
      // ejection velocity (asymmetric direction/speed already baked into GpuRecipe by the
      // compiler), added to the parent's velocity by the activation pass — not overwritten by it.
      this.writeVec3(this.velocityBuf, i, dx * speed, dy * speed, dz * speed);
      this.writeVec3(this.positionBuf, i, 0, 0, 0);
      this.writeVec3(this.prevPositionBuf, i, 0, 0, 0);
      this.writeVec3(this.colorBuf, i, recipe.colorRamp[3], recipe.colorRamp[4], recipe.colorRamp[5]);
      this.writeScalar(this.ageBuf, i, -1);
      this.writeScalar(this.lifeBuf, i, recipe.lifetimes[k]);
      this.writeVec3(this.spawnMetaBuf, i, parentIndices[k], spawnTime, CLASS.STAR);
      this.writeVec4(this.behaviorBuf, i, role, dud, 0, rng());
      this.writeScalar(this.seedHashBuf, i, rng());
    }
    this.markDirtyAll(range);
  }

  private writeCrossette(child: ChildAllocation, starsRange: SlotRange, recipe: GpuRecipe, now: number, rng: RNG): void {
    if (!recipe.secondary) return;
    const { range, parentIndices } = child;
    const spawnTime = now + recipe.fuseTime + recipe.secondary.delay;
    const perParent = recipe.secondary.count;

    for (let j = 0; j < starsRange.count; j++) {
      const base = j * 3;
      const [b1, b2] = perpendicularBasis(recipe.starDirections[base], recipe.starDirections[base + 1], recipe.starDirections[base + 2]);
      const fanOffset = rng() * Math.PI * 2;
      const starSpeed = recipe.starSpeeds[j];

      for (let k = 0; k < perParent; k++) {
        const i = range.start + j * perParent + k;
        const angle = fanOffset + k * ((Math.PI * 2) / perParent);
        const ejectSpeed = starSpeed * (0.4 + 0.3 * rng());
        const ex = (b1[0] * Math.cos(angle) + b2[0] * Math.sin(angle)) * ejectSpeed;
        const ey = (b1[1] * Math.cos(angle) + b2[1] * Math.sin(angle)) * ejectSpeed;
        const ez = (b1[2] * Math.cos(angle) + b2[2] * Math.sin(angle)) * ejectSpeed;

        // Position stays (0,0,0) pre-activation: the activation pass copies the PRIMARY STAR's
        // *current GPU position* (wherever it has drifted to by breakTime+delay) into this slot,
        // so a crossette child visibly continues from its parent star's position at split time.
        this.writeVec3(this.velocityBuf, i, ex, ey, ez);
        this.writeVec3(this.positionBuf, i, 0, 0, 0);
        this.writeVec3(this.prevPositionBuf, i, 0, 0, 0);
        this.writeVec3(this.colorBuf, i, recipe.colorRamp[3], recipe.colorRamp[4], recipe.colorRamp[5]);
        this.writeScalar(this.ageBuf, i, -1);
        this.writeScalar(this.lifeBuf, i, recipe.lifetimes[j] * 0.5);
        this.writeVec3(this.spawnMetaBuf, i, parentIndices[j * perParent + k], spawnTime, CLASS.TRAIL);
        this.writeVec4(this.behaviorBuf, i, ROLE.STAR, 0, 0, rng());
        this.writeScalar(this.seedHashBuf, i, rng());
      }
    }
    this.markDirtyAll(range);
  }

  private writeTrail(child: ChildAllocation, recipe: GpuRecipe, now: number, rng: RNG): void {
    const { range, parentIndices } = child;
    for (let k = 0; k < range.count; k++) {
      const i = range.start + k;
      // Ragged emission intervals + jittered ejection (spec §5.6 "trail raggedness"): spark
      // spawn times are jittered across the shell's rise rather than evenly spaced.
      const spawnOffset = ((k + rng() * 0.6) / range.count) * recipe.riseTime;
      const ejectSpeed = 1.5 + rng() * 2.5;
      const ang = rng() * Math.PI * 2;

      this.writeVec3(this.velocityBuf, i, Math.cos(ang) * ejectSpeed, -1.0 - rng(), Math.sin(ang) * ejectSpeed);
      this.writeVec3(this.positionBuf, i, 0, 0, 0);
      this.writeVec3(this.prevPositionBuf, i, 0, 0, 0);
      this.writeVec3(this.colorBuf, i, recipe.colorRamp[3], recipe.colorRamp[4], recipe.colorRamp[5]);
      this.writeScalar(this.ageBuf, i, -1);
      this.writeScalar(this.lifeBuf, i, 0.4 + rng() * 0.4);
      this.writeVec3(this.spawnMetaBuf, i, parentIndices[k], now + spawnOffset, CLASS.TRAIL);
      this.writeVec4(this.behaviorBuf, i, ROLE.STAR, 0, 0, rng());
      this.writeScalar(this.seedHashBuf, i, rng());
    }
    this.markDirtyAll(range);
  }

  private writeCrackle(child: ChildAllocation, starsRange: SlotRange, recipe: GpuRecipe, now: number, rng: RNG): void {
    const { range, parentIndices } = child;
    for (let k = 0; k < range.count; k++) {
      const i = range.start + k;
      const parentIdx = parentIndices[k];
      const parentLife = recipe.lifetimes[parentIdx - starsRange.start] ?? recipe.lifetimes[0];
      // Poisson-ish: concentrated in the last 40% of the parent star's life (spec §5.5 "crackle
      // spawns micro-flashes at Poisson-distributed times ... near end-of-life").
      const lifeFrac = 0.55 + rng() * 0.4;

      this.writeVec3(this.velocityBuf, i, 0, 0, 0);
      this.writeVec3(this.positionBuf, i, 0, 0, 0);
      this.writeVec3(this.prevPositionBuf, i, 0, 0, 0);
      this.writeVec3(this.colorBuf, i, 1, 1, 1); // bright white micro-flash, not the agent color
      this.writeScalar(this.ageBuf, i, -1);
      this.writeScalar(this.lifeBuf, i, 0.06 + rng() * 0.08);
      this.writeVec3(this.spawnMetaBuf, i, parentIdx, now + recipe.fuseTime + parentLife * lifeFrac, CLASS.CRACKLE);
      this.writeVec4(this.behaviorBuf, i, ROLE.STAR, 0, 0, rng());
      this.writeScalar(this.seedHashBuf, i, rng());
    }
    this.markDirtyAll(range);
  }

  /** One fixed 1/60 s sim step. The only per-tick CPU->GPU traffic is the `simTimeUniform` scalar
   * (a uniform, not a buffer range) — no per-particle CPU writes happen here (guard: "the ONLY
   * steady-state CPU->GPU traffic is per-event range uploads + global uniforms"). */
  tick(simTime: number): void {
    this.simTimeUniform.value = simTime;
    this.renderer.compute(this.passParentsIntegrate); // (a)
    this.renderer.compute(this.passActivation); // (b)
    this.renderer.compute(this.passBallistics); // (c)
    this.renderer.compute(this.passEvents); // (d)
    this.renderer.compute(this.passLifecycle); // (e)
  }

  /** Reads back the position buffer and counts non-finite components (debug mode: called every
   * 600 ticks per the Phase 4 DoD). */
  async scanForNaN(): Promise<number> {
    const raw = await this.renderer.getArrayBufferAsync(this.positionBuf.value);
    const arr = new Float32Array(raw);
    let bad = 0;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) bad++;
    return bad;
  }

  /** Debug-only: reads back per-particle state for external inspection (e.g. automated visual QA
   * driving the sim without a live display). Not used by the steady-state tick loop. */
  async readback(): Promise<ParticleState> {
    const [posRaw, ageRaw, lifeRaw, metaRaw, behaviorRaw] = await Promise.all([
      this.renderer.getArrayBufferAsync(this.positionBuf.value),
      this.renderer.getArrayBufferAsync(this.ageBuf.value),
      this.renderer.getArrayBufferAsync(this.lifeBuf.value),
      this.renderer.getArrayBufferAsync(this.spawnMetaBuf.value),
      this.renderer.getArrayBufferAsync(this.behaviorBuf.value),
    ]);
    return {
      position: new Float32Array(posRaw),
      age: new Float32Array(ageRaw),
      life: new Float32Array(lifeRaw),
      spawnMeta: new Float32Array(metaRaw),
      behavior: new Float32Array(behaviorRaw),
    };
  }
}

