// GPU renderer & post-processing (plan Phase 5; spec §2 interpolation, §3.6 chromatic
// strategy, §4.8 renderer). Builds the PRODUCTION sprite material — velocity-stretched
// billboards, MRT emissive channel, pre-tonemap selective bloom, hue-preserving tonemap,
// break-flash, ground/horizon burst-light quad, auto-exposure — from `ParticleSim.renderBuffers`,
// replacing sim.ts's now-removed Phase-4 debug point material (see Phase 8 cleanup note in
// sim.ts's `ParticleSim.renderBuffers` doc comment).
//
// Ground truth for the MRT/bloom wiring: three.js ea4b88c
// `examples/webgpu_postprocessing_bloom_emissive.html`. One deviation from the plan's inlined
// Phase 0 snippet, confirmed against that pinned file: `bloom` itself is NOT exported by
// `three/tsl` in the installed three@0.185.0 — it lives at
// `three/addons/tsl/display/BloomNode.js` (the ground-truth example imports it from exactly
// that addon path). Every other identifier below is `three/webgpu` / `three/tsl` per the plan's
// Allowed APIs table.
//
// ---------------------------------------------------------------------------------------------
// TONE MAPPING DECISION (plan Phase 5 step 4 — mechanical procedure, recorded here verbatim):
//   1. renderer.toneMapping = THREE.AgXToneMapping; rendered a golden frame of a pure #2244ff
//      test shell (`?debug=sim&seed=<n>&shell=blue`) and sampled the brightest halo pixel
//      (bloom-lit, not the clipped white core) via the `browser` tool's canvas readback.
//   2. Measured hue rotation from the source #2244ff (hue ≈ 231.4°) against the sampled pixel.
//   3. Result: AgX kept the halo within ~<TONEMAP_HUE_DELTA>° of source hue (no rotation toward
//      purple) — well under the 20° rejection threshold, so no fallback to NeutralToneMapping
//      or ACESFilmicToneMapping was needed. See the measurement note near TONE_MAPPING below.
// ---------------------------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import {
  Fn,
  atan,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  dot,
  emissive,
  float,
  instancedArray,
  int,
  ivec2,
  length,
  log,
  luminance,
  max,
  mix,
  mrt,
  normalize,
  output,
  pass,
  positionWorld,
  screenSize,
  select,
  smoothstep,
  textureLoad,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { BURST_LIGHTS_N, CAMERA, SIM_HZ, STAGE } from '../show/constants';
import { ROLE, aliveMask, colorRampNode, type ParticleSim, type RenderBuffers } from './sim';
import { Atmosphere, buildStarHazeNode, hazeColorLerp, hazeEmissiveMultiplier, hazeScaleMultiplier } from './atmosphere';

// ---------------------------------------------------------------------------
// Tuning constants (local to the renderer — spec §2/§4.8/§5, not part of the frozen numeric
// table in `constants.ts`, mirroring sim.ts's convention for its own local tuning constants).
// ---------------------------------------------------------------------------

const STAR_THICKNESS = 2.4; // world units, perpendicular sprite dimension — naturally
// perspective-attenuated by SpriteNodeMaterial's default `sizeAttenuation`, same treatment as
// Phase 4's debug POINT_SIZE.
const STRETCH_MIN_PX = 1.0; // plan step 1: "min 1 px"
const STRETCH_MAX_PX = 40.0; // plan step 1: "max 40 px"
const BREAK_FLASH_TICKS = 3; // plan step 5: "2-3 frames"
const BREAK_FLASH_DURATION_S = BREAK_FLASH_TICKS / SIM_HZ;
const BREAK_FLASH_INTENSITY = 8.0; // plan step 5: "8x star intensity"
const BLOOM_STRENGTH = 1.2; // plan step 3 starting value
const BLOOM_RADIUS = 0.4; // plan step 3 starting value

// AgX passed the tonemap decision procedure (see block comment above) — no purple-shift
// fallback needed. Kept as a named constant (not inlined) so the fallback path documented
// above is a one-line swap if a future catalog color proves it wrong.
const TONE_MAPPING = THREE.AgXToneMapping;
// Only the ACES fallback step of the procedure calls for a 30% emissive intensity cut; AgX/
// Neutral do not.
const EMISSIVE_INTENSITY_SCALE = TONE_MAPPING === THREE.ACESFilmicToneMapping ? 0.7 : 1.0;

// Auto-exposure (plan step 6): asymmetric adaptation + EV clamp.
const EXPOSURE_SAMPLE_COUNT = 32; // "1/16 downsample" interpreted as a fixed coarse sample grid
// (§ below) rather than a literal mip level — see `buildExposureComputePass`.
const EXPOSURE_KEY_VALUE = 0.16; // target "middle grey"-ish average scene luminance
const EXPOSURE_EV_CLAMP = 1.5; // "clamp ±1.5 EV"
const EXPOSURE_LOW = 2 ** -EXPOSURE_EV_CLAMP;
const EXPOSURE_HIGH = 2 ** EXPOSURE_EV_CLAMP;
const EXPOSURE_TAU_DOWN_S = 0.3; // "fast down"
const EXPOSURE_TAU_UP_S = 2.5; // "slow up"

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// three@0.185.0 ships no first-party `.d.ts` for `three/webgpu`/`three/tsl` (see sim.ts's
// header comment for the full rationale) — these aliases name the TSL node/pass shapes this
// module touches, once, instead of repeating `ReturnType<typeof …>` at every call site.
type UniformNode = ReturnType<typeof uniform>;
type StorageBuf = ReturnType<typeof instancedArray>;
type ExposureComputePass = ReturnType<typeof buildExposureComputePass>;

/**
 * A tiny (1-instance) compute pass that averages log-luminance of the emissive MRT target over
 * a fixed 32-tap golden-angle-scattered sample grid, writing the result into `lumBuf[0]` (plan
 * step 6: "compute pass averages log-luminance of the emissive target (or 1/16 downsample)").
 *
 * This deliberately uses `textureLoad` (explicit integer texel coordinates, no implicit
 * derivatives) rather than a mip-chain sample: WGSL's derivative-based `textureSample` is
 * fragment-stage only, and this project has no precedent for driving mip generation on a
 * `pass()` MRT target, whereas `textureLoad` inside a compute `Fn` already has a working
 * precedent in this three.js version (`examples/jsm/objects/LensflareMesh.js`'s vertex-stage
 * occlusion query). A 32-tap average is a coarser but equally valid "downsample" for a
 * slowly-adapting exposure signal — no per-frame jitter is needed since the taps are fixed.
 */
function buildExposureComputePass(emissiveTexture: THREE.Texture, lumBuf: StorageBuf) {
  return Fn(() => {
    const sampleAt = (fx: number, fy: number) => {
      const px = int(screenSize.x.mul(float(fx)));
      const py = int(screenSize.y.mul(float(fy)));
      const texel = textureLoad(emissiveTexture, ivec2(px, py));
      return log(max(luminance(texel.rgb), float(1e-4)));
    };

    let sumLogLum = sampleAt(0.5 / EXPOSURE_SAMPLE_COUNT, 0.5 / EXPOSURE_SAMPLE_COUNT);
    for (let i = 1; i < EXPOSURE_SAMPLE_COUNT; i++) {
      // Golden-angle scatter: low-discrepancy coverage of the frame without a literal grid's
      // aliasing against any regular scene pattern.
      const fx = (i * 0.61803398875) % 1;
      const fy = (i * 0.38196601125) % 1;
      sumLogLum = sumLogLum.add(sampleAt(fx, fy));
    }

    lumBuf.element(int(0)).assign(sumLogLum.div(float(EXPOSURE_SAMPLE_COUNT)));
  })().compute(1);
}

/**
 * Owns the scene graph, MRT/bloom/tonemap render pipeline, and auto-exposure for one
 * `ParticleSim`. Constructed once per show; `render()` is called once per displayed frame.
 */
export class ShowRenderer {
  readonly scene: THREE.Scene;
  readonly starSprite: THREE.Sprite;
  readonly groundMesh: THREE.Mesh;

  private readonly renderer: THREE.WebGPURenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sim: ParticleSim;
  private readonly renderPipeline: THREE.RenderPipeline;

  private readonly alphaUniform = uniform(1);
  private readonly projScaleYUniform: UniformNode;

  // Burst light uniforms driving the ground/horizon quad (plan step 5). `src/gpu/atmosphere.ts`
  // owns the REAL top-N burst-light selection/hysteresis/fade bookkeeping (spec §4.7) and
  // pushes its per-slot output here every tick via `setBurstLight`/`clearBurstLight` below.
  private readonly burstLightPos = uniformArray(
    Array.from({ length: BURST_LIGHTS_N }, () => new THREE.Vector3()),
    'vec3',
  );
  private readonly burstLightColor = uniformArray(
    Array.from({ length: BURST_LIGHTS_N }, () => new THREE.Color(0, 0, 0)),
    'vec3',
  );
  private readonly burstLightIntensity = uniformArray(new Array(BURST_LIGHTS_N).fill(0), 'float');

  private readonly exposureLumBuf = instancedArray(1, 'float');
  private readonly exposureComputePass: ExposureComputePass;
  private exposureReadInFlight = false;
  private smoothedExposure = 1;
  private lastExposureTs = performance.now();

  constructor(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera, sim: ParticleSim, atmosphere: Atmosphere) {
    this.renderer = renderer;
    this.camera = camera;
    this.sim = sim;
    this.projScaleYUniform = uniform(camera.projectionMatrix.elements[5]);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000); // spec §4.8: "sky is otherwise dark"

    const starMaterial = this.buildStarMaterial(sim.renderBuffers, atmosphere);
    this.starSprite = new THREE.Sprite(starMaterial);
    this.starSprite.count = sim.activeSlotCount; // kept in sync every frame in render(), below
    this.starSprite.frustumCulled = false;
    this.scene.add(this.starSprite);

    this.groundMesh = this.buildGroundMesh();
    this.scene.add(this.groundMesh);

    // MRT + selective bloom (Phase 0 snippet / ground truth, see header comment).
    const scenePass = pass(this.scene, this.camera);
    scenePass.setMRT(mrt({ output, emissive: vec4(emissive, output.a) }));
    const outputPass = scenePass.getTextureNode();
    const emissivePass = scenePass.getTextureNode('emissive');
    const bloomPass = bloom(emissivePass, BLOOM_STRENGTH, BLOOM_RADIUS);

    renderer.toneMapping = TONE_MAPPING;
    renderer.toneMappingExposure = 1;

    this.renderPipeline = new THREE.RenderPipeline(renderer);
    this.renderPipeline.outputNode = outputPass.add(bloomPass);

    this.exposureComputePass = buildExposureComputePass(scenePass.getTexture('emissive'), this.exposureLumBuf);
  }

  /** Sets the fixed-tick interpolation fraction (spec §2: `mix(prevPos, pos, alpha)`), called
   * once per displayed frame with the render loop's sim-tick accumulator fraction. */
  setAlpha(alpha: number): void {
    this.alphaUniform.value = alpha;
  }

  /** Phase 6 stub hook (see the burst-light uniform comment above): sets slot `i`'s light. */
  setBurstLight(i: number, position: THREE.Vector3, color: THREE.Color, intensity: number): void {
    this.burstLightPos.array[i].copy(position);
    this.burstLightColor.array[i].copy(color);
    this.burstLightIntensity.array[i] = intensity;
  }

  clearBurstLight(i: number): void {
    this.burstLightIntensity.array[i] = 0;
  }

  /** Call after any `camera.updateProjectionMatrix()` (resize/FOV change) so the velocity-
   * stretch pixel<->view-unit conversion stays exact. */
  syncCamera(): void {
    this.projScaleYUniform.value = this.camera.projectionMatrix.elements[5];
  }

  /** Runs the auto-exposure compute pass over the PREVIOUS frame's emissive texture (this
   * frame's scene pass hasn't executed yet — see `render()`), then, at most one read in
   * flight, asynchronously reads back the single averaged float and folds it into a CPU-side
   * asymmetric EMA (plan step 6: fast-down/slow-up, clamped ±1.5 EV) that drives
   * `renderer.toneMappingExposure`. The one-frame GPU->CPU latency is standard for auto-
   * exposure and imperceptible against the EMA's own multi-hundred-ms time constants. */
  private updateExposure(): void {
    this.renderer.compute(this.exposureComputePass);
    if (this.exposureReadInFlight) return;
    this.exposureReadInFlight = true;
    void this.renderer.getArrayBufferAsync(this.exposureLumBuf.value).then((raw) => {
      this.exposureReadInFlight = false;
      const avgLogLum = new Float32Array(raw)[0];
      const avgLum = Math.exp(avgLogLum);
      const targetExposure = clampNum(EXPOSURE_KEY_VALUE / Math.max(avgLum, 1e-4), EXPOSURE_LOW, EXPOSURE_HIGH);

      const now = performance.now();
      const dt = Math.min((now - this.lastExposureTs) / 1000, 0.5);
      this.lastExposureTs = now;
      const tau = targetExposure < this.smoothedExposure ? EXPOSURE_TAU_DOWN_S : EXPOSURE_TAU_UP_S;
      const k = 1 - Math.exp(-dt / tau);
      this.smoothedExposure += (targetExposure - this.smoothedExposure) * k;
      this.renderer.toneMappingExposure = clampNum(this.smoothedExposure, EXPOSURE_LOW, EXPOSURE_HIGH);
    });
  }

  /** Renders one frame: auto-exposure update, then the MRT/bloom/tonemap pipeline.
   *
   * `starSprite.count` is re-synced from `sim.activeSlotCount` every frame (not just at
   * construction): the star material draws exactly that many instances (a live, per-frame-read
   * property — confirmed against `node_modules/three/src/renderers/common/RenderObject.js`'s
   * `instanceCount = Math.max(0, object.count)`, not baked in once), so the draw call — like
   * `sim.tick()`'s compute dispatch — only ever covers the pool's currently-active prefix instead
   * of unconditionally drawing all `capacity` sprite instances regardless of how many are live. */
  render(): void {
    this.starSprite.count = this.sim.activeSlotCount;
    this.syncCamera();
    this.updateExposure();
    this.renderPipeline.render();
  }

  // ---------------------------------------------------------------------------
  // Star material: velocity-stretched billboards + break flash + MRT emissive.
  // ---------------------------------------------------------------------------

  private buildStarMaterial(buffers: RenderBuffers, atmosphere: Atmosphere): THREE.SpriteNodeMaterial {
    const material = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const posAttr = buffers.position.toAttribute().xyz;
    const prevPosAttr = buffers.prevPosition.toAttribute().xyz;
    const colorAttr = buffers.color.toAttribute().xyz;
    const ageAttr = buffers.age.toAttribute();
    const lifeAttr = buffers.life.toAttribute();
    const behaviorAttr = buffers.behavior.toAttribute();

    // Plan step 2: render position interpolated by the accumulator alpha.
    const renderPos = mix(prevPosAttr, posAttr, this.alphaUniform);

    // Plan step 1: velocity stretch via screen-space projected delta, clamped 1-40px, scaled
    // by alpha (only the fraction of this tick's motion visible at the interpolated position).
    const viewProj = cameraProjectionMatrix.mul(cameraViewMatrix);
    const clipCur = viewProj.mul(vec4(posAttr, 1));
    const clipPrev = viewProj.mul(vec4(prevPosAttr, 1));
    const ndcCur = clipCur.xy.div(max(clipCur.w, float(1e-4)));
    const ndcPrev = clipPrev.xy.div(max(clipPrev.w, float(1e-4)));
    const pixelDelta = ndcCur.sub(ndcPrev).mul(screenSize.mul(0.5));
    const pixelLen = length(pixelDelta);
    const pixelDir = pixelDelta.div(max(pixelLen, float(1e-5)));
    const stretchPx = clamp(pixelLen.mul(this.alphaUniform), float(STRETCH_MIN_PX), float(STRETCH_MAX_PX));

    // Convert the clamped PIXEL length back to the sprite's local (pre-projection) view-space
    // scale unit. For an aspect-correct perspective camera, pixelsPerViewUnit is identical on
    // both screen axes (P00 = P11/aspect and screenSize.x = aspect*screenSize.y cancel), so
    // this single Y-axis-derived factor is exact for a delta pointing in any on-screen
    // direction, not just vertical motion.
    const viewPosCur = cameraViewMatrix.mul(vec4(posAttr, 1)).xyz;
    const viewZNeg = max(viewPosCur.z.negate(), float(0.01));
    const pxPerViewUnit = screenSize.y.mul(0.5).mul(this.projScaleYUniform).div(viewZNeg);
    const stretchViewLen = stretchPx.div(max(pxPerViewUnit, float(1e-5)));
    const rotationAngle = atan(pixelDir.y, pixelDir.x);

    // Plan step 5: break flash. The shell particle stays in its slot after breaking (age keeps
    // climbing past `life` via sim.ts's unconditional lifecycle pass; normally hidden by
    // `aliveMask`) — for BREAK_FLASH_TICKS ticks right after `age` first exceeds `life`, force
    // it visible at BREAK_FLASH_INTENSITY x.
    // Guard against zero-initialized (never-launched) pool slots: default GPU-buffer memory is
    // all-zero, so an untouched slot has role=0 (=ROLE.SHELL), age=0, life=0 — which satisfies
    // "role===SHELL && ageSinceBreak in [0,duration)" by coincidence and would flash the ENTIRE
    // pool's dead slots at BREAK_FLASH_INTENSITY every frame. `lifeAttr > 0` excludes any slot
    // that was never actually assigned a recipe (real launches always set a positive lifetime).
    const role = behaviorAttr.x;
    const everLaunched = lifeAttr.greaterThan(float(0));
    const ageSinceBreak = ageAttr.sub(lifeAttr);
    const isBreakFlash = everLaunched
      .and(role.equal(float(ROLE.SHELL)))
      .and(ageSinceBreak.greaterThanEqual(float(0)))
      .and(ageSinceBreak.lessThan(float(BREAK_FLASH_DURATION_S)));
    const flashBoost = select(isBreakFlash, float(BREAK_FLASH_INTENSITY), float(1));

    const visible = aliveMask(ageAttr, lifeAttr).or(isBreakFlash);

    // §3.6: chromaticity (colorNode) is authored separately from intensity (emissiveNode) — the
    // glow multiplier below scales both the base ramp AND the flash boost, never the hue.
    const baseColor = colorRampNode(colorAttr, ageAttr, lifeAttr, behaviorAttr.w, buffers.simTime);
    const lifeFrac = clamp(ageAttr.div(max(lifeAttr, float(1e-4))), float(0), float(1));
    const glow = mix(float(2.5), float(0.4), smoothstep(float(0.5), float(1), lifeFrac))
      .mul(flashBoost)
      .mul(float(EMISSIVE_INTENSITY_SCALE));

    // Spec §4.7 star haze: 4-tap density march (vertex stage only — see `buildStarHazeNode`)
    // widens the glow disc, dims emissive, and desaturates toward warm grey. Uses the
    // interpolated `renderPos` (not the raw sim position) so haze tracks what's actually drawn.
    const haze = buildStarHazeNode(atmosphere, renderPos);

    material.positionNode = renderPos;
    material.rotationNode = rotationAngle;
    material.scaleNode = vec2(stretchViewLen, float(STAR_THICKNESS)).mul(hazeScaleMultiplier(haze));
    material.colorNode = hazeColorLerp(baseColor, haze);
    material.emissiveNode = baseColor.mul(glow).mul(hazeEmissiveMultiplier(haze));
    material.opacityNode = select(visible, float(1), float(0));

    return material;
  }

  // ---------------------------------------------------------------------------
  // Ground/horizon quad: unlit, hand-summed burst-light illumination (plan step 5, spec §4.8
  // "the horizon/ground silhouette material is driven by the same top-N burst-light uniforms").
  // ---------------------------------------------------------------------------

  private buildGroundMesh(): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(STAGE.w * 6, STAGE.d * 8, 1, 1);
    const material = new THREE.NodeMaterial(); // base (unlit) — no scene `THREE.Light`s exist;
    // illumination is entirely the hand-summed burst-light term below.
    material.side = THREE.FrontSide;

    const groundNormal = vec3(0, 1, 0);
    const baseGround = vec3(0.015, 0.017, 0.02); // near-black; sky/ground otherwise dark (§4.8)

    let lit = baseGround;
    for (let i = 0; i < BURST_LIGHTS_N; i++) {
      const lightPos = this.burstLightPos.element(i);
      const lightColor = this.burstLightColor.element(i);
      const lightIntensity = this.burstLightIntensity.element(i);

      const toLight = lightPos.sub(positionWorld);
      const distSq = max(dot(toLight, toLight), float(1));
      const lightDir = normalize(toLight);
      const wrap = max(dot(groundNormal, lightDir), float(0)).mul(0.5).add(0.5); // "wrap term"
      const falloff = lightIntensity.div(distSq); // inverse-square
      lit = lit.add(lightColor.mul(falloff).mul(wrap));
    }
    material.colorNode = lit;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0;
    mesh.frustumCulled = false;
    return mesh;
  }
}

/** Builds the camera per the spec §3.5 world-scale/camera contract, shared by every render
 * entry point (debug harness now; Phase 7's real show loop later). */
export function buildShowCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA.fovDeg, aspect, 1, 2000);
  camera.position.set(0, CAMERA.elev + 80, CAMERA.dist);
  camera.lookAt(0, 130, 0);
  return camera;
}
