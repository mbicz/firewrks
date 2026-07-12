# firewrks — Implementation Plan (executor-proof edition)

Executes `docs/superpowers/specs/2026-07-11-firewrks-realistic-show-design.md` (commit `5509b44`). The spec is the behavioral contract; this plan is the mechanical procedure.

## Execution protocol (read first, every session)

1. One phase per session, in order. Read the spec sections named by the phase before coding.
2. **Never** refactor a previous phase's files except where a step explicitly says so. The Frozen Contracts below may not be changed by any phase.
3. Run only the commands in the phase's Definition of Done. No formatters, linters, or full suites until Phase 8.
4. If an API you want is not in the Allowed APIs table or an inlined snippet, STOP and check the pinned source (`node_modules/three/...` or the cited URL). Do not invent methods, parameters, or import paths.
5. Every random draw goes through the seeded PRNG. `Math.random(` must never appear in `src/` or `server/`.

## Frozen contracts

### Directory layout

```
server/index.mjs          Node static server
catalog/*.json            effect catalog documents
src/main.ts               boot/UI (idle screen, probe, fullscreen, loop start)
src/platform/probe.ts     WebGPU capability probe
src/platform/screen.ts    resolution cap + DPR sizing
src/show/rng.ts           seeded PRNG (mulberry32)
src/show/catalog.ts       schema types + validation + generateCatalogEntry
src/show/planner.ts       show timeline
src/show/compiler.ts      catalog entry -> GpuRecipe
src/show/allocator.ts     ring-buffer slot allocator
src/show/constants.ts     ALL numeric constants (world scale, jitter, decay)
src/gpu/sim.ts            TSL compute passes (particles)
src/gpu/atmosphere.ts     smoke density field + burst lights
src/gpu/render.ts         sprite material, MRT, bloom, tonemap, exposure
test/*.test.ts            Vitest unit tests (CPU only)
tools/golden.mjs          golden-frame capture script
plans/, docs/             this plan and the spec
```

### Dependencies (exact)

`three@0.185.0`, `serve-handler@6.1.8`, `vite@^6`, `vitest@^3`, `typescript@^5`, `puppeteer@^24` (dev, Phase 5+ golden frames). Imports: `import * as THREE from 'three/webgpu'` and `import { Fn, instancedArray, instanceIndex, uv, vec3, vec4, uniform, ... } from 'three/tsl'` — these two subpaths are the package's documented exports. **Never** import from `three/nodes` (removed) or plain `three` for renderer/TSL code.

### Types (define once in Phase 2/3, then immutable)

```ts
// src/show/catalog.ts
type BreakFamily = 'peony'|'chrysanthemum'|'willow'|'horsetail'|'palm'
                 |'crossette'|'fish'|'ring'|'pistil'|'crackling_flower';
type EffectTag = 'crackle'|'strobe'|'glitter'|'whistle'|'brocade'|'wave';
type DeviceType = 'shell'|'cake'|'mine'|'comet'|'rocket';
type Caliber = 'small'|'medium'|'large';

interface CatalogPhase {
  kind: 'ascent'|'break'|'secondary'|'terminal';
  breakFamily?: BreakFamily;
  colors: string[];              // CSS hex, chromaticity only
  effectTags: EffectTag[];
}
interface CatalogEntry {
  id: string; productName: string;
  sourceUrl: string; sourcePublisher: string;
  sourceKind: 'glossary'|'product_page'|'catalog'|'generated';
  accessedOn: string; verbatimText: string;
  normalizationStatus: 'direct'|'alias'|'inferred';
  deviceType: DeviceType; shotCount: number;
  durationSeconds?: number; caliberHint: Caliber;
  phases: CatalogPhase[];
}

// src/show/compiler.ts
interface GpuRecipe {
  caliber: Caliber;
  apexHeight: number; breakRadius: number; riseTime: number; // meters/seconds, from CALIBER_TABLE + jitter
  fuseTime: number;                    // seconds after launch; breaks are fuse-timed, NEVER height-triggered
  starCount: number;
  starDirections: Float32Array;        // xyz per star, asymmetric (§5.3 applied)
  starSpeeds: Float32Array;            // m/s per star, ±10–20% spread
  colorRamp: Float32Array;             // 3 phases x rgb: ignition white -> agent color -> ember red
  lifetimes: Float32Array;             // seconds per star, ±20–35% jitter
  trailEmissionRate: number;           // 0 for peony; >0 for chrysanthemum/comet/willow
  secondary?: { kind: 'crossette'|'pistil'; count: 4|number; delay: number };
  flags: { strobe: boolean; crackle: boolean; dudProbability: number };
}

// src/show/allocator.ts
interface SlotRange { classId: number; start: number; count: number; freeAt: number; }
// allocator.reserve(classId, count, now, maxLifetime): SlotRange | null (null = defer, never overwrite)

// src/gpu/atmosphere.ts
interface BurstLight { position: [number,number,number]; color: [number,number,number]; intensity: number; fade: number; }
```

### Constants (`src/show/constants.ts`, from spec §3.5/§4.7/§5 — copy verbatim)

```ts
export const G = 9.81;                          // m/s^2
export const STAGE = { w: 600, h: 350, d: 200 } as const;   // meters
export const CAMERA = { dist: 400, elev: 10, fovDeg: 50 } as const;
export const CALIBER_TABLE = {
  small:  { apex: [90,140],  radius: [15,35],  stars: [60,150],  rise: [2,3]   },
  medium: { apex: [140,220], radius: [35,70],  stars: [150,400], rise: [3,4.5] },
  large:  { apex: [220,300], radius: [70,125], stars: [300,900], rise: [4,6]   },
} as const;
export const SIM_HZ = 60;
export const RENDER_MAX = { w: 3840, h: 2160 } as const;
export const LIFETIME_JITTER = [0.20, 0.35] as const;      // ±fraction
export const SPEED_SPREAD = [0.10, 0.20] as const;
export const ANGLE_NOISE_DEG = [2, 6] as const;
export const FUSE_JITTER = 0.10;                             // ±fraction
export const LAUNCH_TILT_DEG = 3;
export const WILLOW_MIN_HANG = 8;                            // seconds
export const SMOKE_GRID = [64, 32, 32] as const;
export const SMOKE_DECAY_S = [60, 180] as const;
export const BURST_LIGHTS_N = 8;
export const LIGHT_FADE_MS = 150;
export const FINALE_RESERVE = 0.30;
export const MAX_GAP_S = 2.5;  export const LULL_MAX_GAP_S = 6;
export const POOL_CAPACITY = 1_500_000;
```

### npm scripts (`package.json`)

```json
{ "dev": "vite", "build": "vite build", "test": "vitest run",
  "serve": "node server/index.mjs", "golden": "node tools/golden.mjs" }
```

## Phase 0 — Allowed APIs (verified 2026-07-11; evidence inlined below)

| API | Anchor |
|---|---|
| `new THREE.WebGPURenderer({ antialias })` — never pass `forceWebGL: true`; probe replaces fallback | three.js ea4b88c `src/renderers/webgpu/WebGPURenderer.js` L28–73 |
| `instancedArray(n, 'vec3')`, `.element(instanceIndex)`, `.toAttribute()`, `Fn(()=>{...})().compute(n)`, `renderer.compute(x)` | ea4b88c `examples/webgpu_compute_particles.html` L38–163 |
| `SpriteNodeMaterial` `.colorNode/.positionNode/.scaleNode/.opacityNode`; `sprite.count = n` | same |
| `pass(scene,camera)`, `.setMRT(mrt({output, emissive}))`, `.getTextureNode('emissive')`, `bloom(node,strength,radius)`, `new THREE.RenderPipeline(renderer)`, `.outputNode` | ea4b88c `examples/webgpu_postprocessing_bloom_emissive.html` L80–126 |
| `navigator.gpu` → `requestAdapter()` → `requestDevice()` (secure context) | MDN "WebGPU API — Accessing a device" |
| `el.requestFullscreen({navigationUI:'hide'})`, `fullscreenchange`/`fullscreenerror`, `document.fullscreenElement` | MDN `Element.requestFullscreen` |
| `devicePixelRatio` + `matchMedia` resolution listener; `requestAnimationFrame(ts)` | MDN |
| `http.createServer(listener)`, `server.listen(port, host, cb)` | Node v26 http.md/net.md |
| `serveHandler(req, res, { public })` | serve-handler README |

**Reference snippets (copy these; do not improvise):**

WebGPU probe (MDN, verbatim shape):
```js
export async function probeWebGPU() {
  if (!navigator.gpu) return { ok: false, reason: 'navigator.gpu missing (WebGPU unsupported)' };
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter(); } catch (e) { return { ok: false, reason: String(e) }; }
  if (!adapter) return { ok: false, reason: 'requestAdapter() returned null' };
  try { await adapter.requestDevice(); } catch (e) { return { ok: false, reason: 'requestDevice failed: ' + e }; }
  return { ok: true };
}
```

Server (serve-handler README pattern):
```js
import http from 'node:http';
import serveHandler from 'serve-handler';
const server = http.createServer((req, res) =>
  serveHandler(req, res, { public: 'dist', directoryListing: false }));
server.listen(4173, '127.0.0.1', () => console.log('http://localhost:4173'));
```

Three compute-particle skeleton (from the maintained example — structure to extend):
```js
import * as THREE from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, uv } from 'three/tsl';

const positions = instancedArray(POOL_CAPACITY, 'vec3');
const velocities = instancedArray(POOL_CAPACITY, 'vec3');
const colors = instancedArray(POOL_CAPACITY, 'vec3');

const computeUpdate = Fn(() => {
  const pos = positions.element(instanceIndex);
  const vel = velocities.element(instanceIndex);
  // ... ballistics, events, imperfection writes to pos/vel ...
});
const computeParticles = computeUpdate().compute(POOL_CAPACITY);

const material = new THREE.SpriteNodeMaterial();
material.colorNode = uv().mul(colors.element(instanceIndex));
material.positionNode = positions.toAttribute();
// material.scaleNode / material.opacityNode assigned in Phase 5
const particles = new THREE.Sprite(material);
particles.count = POOL_CAPACITY;

// per frame:  renderer.compute(computeParticles);  then render
```

Bloom pipeline (from the maintained example):
```js
import { pass, mrt, vec4, emissive, output } from 'three/tsl';
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, emissive: vec4(emissive, output.a) }));
const outputPass = scenePass.getTextureNode();
const emissivePass = scenePass.getTextureNode('emissive');
const bloomPass = bloom(emissivePass, 2.5, 0.5);
const renderPipeline = new THREE.RenderPipeline(renderer);
renderPipeline.outputNode = outputPass.add(bloomPass);
```
If any identifier above fails to import at build time, open the pinned example at
`https://raw.githubusercontent.com/mrdoob/three.js/ea4b88c/examples/webgpu_postprocessing_bloom_emissive.html`
(or `webgpu_compute_particles.html`) and copy the exact working lines. That file is ground truth; this plan's snippet is a reminder of its shape.

**Global anti-patterns:** `fireworks-js`; Canvas-2D; `EffectComposer`/`UnrealBloomPass`; `three/nodes`; screen-height break triggers; `Math.random(`; per-particle CPU writes in the frame loop; unclamped sprite sizes; inventing TSL functions.

## Phase 1 — Scaffold, server, boot gate

Spec: §2, §4.1, §4.9. Steps:

1. `npm create vite@latest . -- --template vanilla-ts`; pin dependencies from Frozen Contracts; add npm scripts.
2. `server/index.mjs` = the server snippet above, port from `process.env.PORT ?? 4173`.
3. `src/platform/probe.ts` = probe snippet. `src/platform/screen.ts`: `fit(cssW, cssH, dpr)` returns backing size = `min(cssW*dpr, 3840) × min(cssH*dpr, 2160)` preserving aspect; wire the MDN `matchMedia('(resolution: ...dppx)')` re-subscribe pattern.
4. `src/main.ts`: idle screen (title, seed input prefilled from `Date.now()`, Start button). On Start click: `await probeWebGPU()`; on failure render `<pre>` diagnostic with the `reason` and STOP. On success: `document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})` (windowed on denial), then call `startShow(seed)` (stub logging the seed for now).
5. Test `test/screen.test.ts`: cap math (5120×2880@2 → clamps to 3840×2160-fit; 1920×1080@1 → unchanged).

**DoD:** `npm run build && npm run serve` → page on `http://localhost:4173`; DevTools console: stubbing `Object.defineProperty(navigator,'gpu',{value:undefined})` before Start shows the diagnostic; `npm test` green.
**Guards:** server binds `127.0.0.1` only; fullscreen only inside the click handler; no renderer construction yet.

## Phase 2 — Catalog

Spec: §4.2, §7. Steps:

1. `src/show/rng.ts`: mulberry32 (`seed:number` → `() => float [0,1)`), plus `range(rng,[a,b])`, `pick(rng,arr)`.
2. `src/show/catalog.ts`: the frozen `CatalogEntry` types; `validateEntry(x): string[]` (empty = valid) enforcing: required provenance unless `sourceKind==='generated'`; `phases` non-empty; `breakFamily` present on `kind:'break'|'secondary'`; crossette `secondary.count===4` at compile level (Phase 3) — here just vocabulary validity.
3. `catalog/`: 10 real entries transcribed from spec §9 sources — REQUIRED: golden-pyro-fusion (cake, 18 shots, comet+crackle alternating with crossette), strobe-spectacular (cake, 20 shots, strobe tails → willows white/green-purple/green-yellow), sfx-strobe-rockets (rocket, 5 s, strobe→willow gold / gold+red-strobe), howler-rockets (rocket, 5 s, whistle/crackle/strobe/brocade), kl5013-crackling-flower (cake, 721 shots, 30 s, red/green/yellow/blue crackling_flower) — plus one generic glossary-grounded shell for each of peony, chrysanthemum, willow, horsetail, palm. Put the exact quoted sentence in `verbatimText`, real URL in `sourceUrl`, `accessedOn: "2026-07-11"`.
4. `generateCatalogEntry(rng): CatalogEntry` — picks device/family/colors/caliber from vocabulary lists; `sourceKind:'generated'`; must pass `validateEntry`.
5. `test/catalog.test.ts`: every shipped file validates; provenance rule enforced (mutate one field → error); 100-seed generator fuzz all valid; loader skips an invalid entry with a warning and returns the rest.

**DoD:** `npm test` green.
**Guards:** no numeric physics fields in catalog JSON (heights/velocities/strobe-rates prohibited — physics comes from `caliberHint` via CALIBER_TABLE in Phase 3); willow and horsetail remain distinct families.

## Phase 3 — Planner, compiler, allocator (CPU only)

Spec: §3.5, §3.6, §4.3, §4.4, §4.5-Emission, §5. Steps:

1. `src/show/constants.ts` verbatim from Frozen Contracts.
2. `src/show/compiler.ts`: `compile(entry, phaseIdx, rng): GpuRecipe`.
   - Scale: draw apex/radius/stars/rise uniformly from `CALIBER_TABLE[entry.caliberHint]`.
   - `fuseTime = rise * (1 ± FUSE_JITTER*rng)`.
   - Directions: family topology (peony/chrys/willow: uniform sphere via normalized gaussian triple; palm: 5–8 arm unit vectors; horsetail: cone half-angle ≤ 25° downrange; ring: unit circle in a plane tilted ≤ 15°; fish: sphere + `selfPropelled` handled as high per-star curl gain) ⊕ per-star angular noise `ANGLE_NOISE_DEG` ⊕ one per-shell deformation matrix (scale y by 0.85–1.0, random tilt ≤ 10°).
   - Speeds: `breakRadius / meanLifetime` scaled per family, spread `SPEED_SPREAD`.
   - Lifetimes: family base (willow ≥ WILLOW_MIN_HANG; horsetail ≈ 2–3 s) with `LIFETIME_JITTER`.
   - `colorRamp`: [white 1.0-intensity ignition, entry color, `#3a1006` ember], per §3.6.
   - `trailEmissionRate`: 0 peony; >0 chrysanthemum/comet/willow/horsetail.
   - `secondary`: crossette `{count: 4, delay: 0.4–0.8s}`; pistil from catalog phases.
   - `flags.dudProbability = 0.02`.
3. `src/show/planner.ts`: generator yielding `{t, entryId, phaseIdx, x}` events. Macro envelope = sum of two slow sinusoids of the seed; lull when envelope < 0.35 (gaps up to `LULL_MAX_GAP_S`), else gaps ≤ `MAX_GAP_S`; cakes expand to `shotCount` events across `durationSeconds`; escalation wave every 2–4 min; finale claims the reserve; never two consecutive identical `breakFamily`.
4. `src/show/allocator.ts` per frozen interface. Reserve rounds `freeAt = now + maxLifetime*1.35 + trailLag` (trailLag = 1 s for trail classes). Returns `null` when the range would overlap a live one; ambient callers must treat `null` as defer. Finale reserve: slots `[capacity*(1-FINALE_RESERVE), capacity)` reservable only with `finale:true`.
5. `test/compiler.test.ts`, `test/planner.test.ts`, `test/allocator.test.ts`: every §8 CPU assertion — crossette=4; mean(willow lifetimes) > mean(horsetail); peony `trailEmissionRate===0` and chrysanthemum `>0`; direction-set variance within deformation bounds but ≠ perfect sphere (chi-square against uniform must fail perfection: assert max angular deviation ≥ 2°); same seed → deep-equal recipe/schedule; simulated hour: gap rules hold, ambient never touches reserve, allocator ranges never overlap, recycling respects jitter+hang.

**DoD:** `npm test` green.
**Guards:** zero `three` imports under `src/show/`; typed arrays only in `GpuRecipe`; every constant read from `constants.ts` (grep for magic numbers).

## Phase 4 — GPU simulation core

Spec: §2 (timestep), §4.5, §4.6, §5. Steps:

1. `src/gpu/sim.ts`: buffers per Frozen Contracts + `prevPositions`, `spawnMeta` (parentIndex, spawnTime, classId), `age`, `life`, `seedHash`. Upload path: one `reserve()`-backed range per launch event; write recipe arrays into a staging region of the buffers via renderer-supported buffer update for that range only (event-time, not per-tick).
2. Compute pass order per tick (60 Hz accumulator): (a) parents integrate; (b) activation — slots with `spawnTime <= simTime && age < 0` copy parent pos/vel (parents already advanced; children of this tick read post-advance state — document this choice in a comment); (c) ballistics `vel += (g + wind + curl(pos,seedHash) ) * dt; vel -= drag(class)*|vel|*vel*dt; prevPos = pos; pos += vel*dt`; (d) events — `simTime >= launchT+fuseTime` flips ascent→break star states, spawns via pre-reserved child ranges; terminal flags (willow low-drag hang, horsetail high-mass fall); (e) lifecycle `age += dt`, dud stars force early fade.
3. Imperfection is not optional: curl-noise (3-octave value-noise gradient, per-class gain), per-star flicker phase from `seedHash`, all §5 items 1–8 wired to the recipe fields.
4. Debug readback mode (`?debug=sim`): a 4k-particle pool, `renderer.readback`-style buffer fetch if available in 0.185 — otherwise render positions as 2-px points and assert visually; log a NaN scan of a readback array every 600 ticks.

**DoD:** `npm run dev` with `?debug=sim&seed=42`: a single test peony launches, ascends 2–3 s along a visibly curved (wobbling) path, breaks at fuse time into an expanding non-perfect sphere; console NaN scan prints 0 for 10 sim-minutes; crossette test entry shows children continuing from parent positions.
**Guards:** breaks trigger on `fuseTime` only; the ONLY steady-state CPU→GPU traffic is per-event range uploads + global uniforms (wind, time, lights); parents-before-children ordering stated in a comment.

## Phase 5 — Renderer & post

Spec: §2, §3.6, §4.8. Steps:

1. Velocity stretch: in `positionNode`/vertex stage, elongate the sprite along `project(pos) - project(prevPos)` (screen-space), length = that delta × interpolation alpha, min 1 px, max 40 px (clamp). Round-dot rendering of fast stars is a build failure, not a style choice.
2. Interpolation: render position = `mix(prevPos, pos, alpha)` with accumulator alpha.
3. MRT + bloom exactly per the Phase 0 snippet; bloom strength start 1.2, radius 0.4.
4. Tonemap decision procedure (mechanical): set `renderer.toneMapping = THREE.AgXToneMapping`; render golden frame of a pure `#2244ff` shell; sample the brightest halo pixel; if its hue rotated > 20° toward purple, switch to `THREE.NeutralToneMapping`; if still failing, `THREE.ACESFilmicToneMapping` + reduce emissive intensity 30 %. Record the outcome in a comment block in `render.ts`. (All three constants are documented three.js tone-mapping constants.)
5. Break flash: on each break event enqueue a 2–3 frame sprite at 8× star intensity. Ground/horizon: full-width quad strip whose material colorNode sums the `BURST_LIGHTS_N` uniforms (inverse-square × wrap term `max(dot(n,l),0)*0.5+0.5`).
6. Auto-exposure: compute pass averages log-luminance of the emissive target (or 1/16 downsample); exposure uniform adapts fast down (τ≈0.3 s) slow up (τ≈2.5 s), clamp ±1.5 EV.
7. `tools/golden.mjs` (puppeteer): launch headless Chrome with `--enable-unsafe-webgpu` if needed, open `http://localhost:4173/?seed=42&stopAtFrame=180`, wait for `document.title==='FRAME_READY'`, screenshot to `test/golden/`. First run writes the blessed image; later runs pixel-diff (>1 % differing pixels = fail).

**DoD:** `npm run golden` produces/matches captures for seeds 42 (peony) and 43 (blue shell); visually: no beading, blue stays blue, flash pops, ground glints during a gold willow, sky never grey.
**Guards:** bloom input = emissive channel only; no `EffectComposer` import; sprite max screen size clamped.

## Phase 6 — Atmosphere

Spec: §4.7. Steps:

1. Two `SMOKE_GRID` 3D storage textures (ping-pong). Update pass per tick: sample previous, advect by `wind*dt` (semi-Lagrangian back-trace), diffuse (6-tap Laplacian × small k), decay `*= exp(-dt/tau)` with `tau` drawn once per show from `SMOKE_DECAY_S`; injection: per break/ascent event add Gaussian splat (amount ∝ caliber) via event uniform list (≤ 16 per tick).
2. Smoke sprites: `classId: smoke`, non-emissive channel, opacity = sampled local density × age fade.
3. Burst lights: CPU maintains `BURST_LIGHTS_N` slots; candidate = every break for 1.5 s with intensity decay; selection by intensity with hysteresis (a slot keeps its light until candidate exceeds it by 25 %); per-slot fade in/out over `LIGHT_FADE_MS`. Smoke colorNode: Σ lights `I/(d²+1) * (1 + 2.5*pow(max(dot(lightDir, viewDir),0), 4))` (HG-style forward boost).
4. Star haze: in vertex stage, 4-tap march star→camera through the density texture; output scalar `haze` → widen `scaleNode` (≤ +60 %), dim emissive (down to 40 %), lerp color toward warm grey by `haze*0.3`.
5. CPU reference implementation of the update rule in `src/show/atmosphereRef.ts` + `test/atmosphere.test.ts`: exponential decay constant recovered within 5 %; injection raises local density; centroid moves downwind; 1 simulated hour → no negatives/NaN.

**DoD:** `npm test` green; visual (`?seed=44` two shells 8 s apart at same x): second burst visibly hazier and old cloud lit from the new burst's side; `npm run golden` seed 44 blessed.
**Guards:** march in vertex stage only; light slots never hard-swap (fade verified by slow-mo `?timeScale=0.2`); smoke sprites never write the emissive channel.

## Phase 7 — Show integration

Spec: §4.3, §6, §7. Steps: wire `startShow(seed)`: load+validate catalog → planner stream → per event: compile → `allocator.reserve` (null → requeue event +250 ms, unless finale) → range upload; maintain wind, lights, exposure uniforms; seed shown small in a corner for 5 s then fades.

**DoD:** 30-minute unattended run (`?seed=7`): no crash; `performance.memory.usedJSHeapSize` drift < 10 % between minute 5 and minute 30; no visible particle pops; synthetic over-scheduled seed (`?seed=stress` maps to a planner mode multiplying event rate ×10) shows deferral without corruption.
**Guards:** zero allocations in the rAF loop (no array/object literals; preallocate scratch); heap snapshot diff before/after 10 min shows stable object counts.

## Phase 8 — Final verification & cleanup

1. `npm test` — full suite green.
2. Perf gate: `?seed=finale-bench` (max concurrent bursts + saturated smoke) with `?stats=1` overlay logging GPU frame time (three's `renderer.info` + `performance.now` around render): p95 < 16.6 ms at capped resolution. If it fails: reduce trail emission rate first, then bloom radius, then pool — in that order; re-run.
3. Anti-pattern greps (all must return nothing under `src/ server/`): `fireworks-js`, `EffectComposer`, `UnrealBloomPass`, `Math.random(`, `three/nodes`, `getContext('2d'`.
4. Golden frames re-blessed only if a deliberate visual change happened this phase (record why in the commit message).
5. Manual pass on the Mac + AirPlay: fullscreen entry, ambient 10-min sample, one finale, smoke persistence across ≥ 3 bursts, red/blue color fidelity on the TV.
6. Cleanup: README (install, `npm run build`, `npm run serve`, open `http://localhost:4173`, press Start; seed URL param documented), remove `?debug=sim` scaffolding readbacks (keep the query switch, delete dead code), changelog entry, commit.
