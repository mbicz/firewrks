# firewrks — Realistic GPU Fireworks Show (Design Spec)

Date: 2026-07-11
Status: approved pending user review
Decisions locked in brainstorming: ambient loop (no operator console), visual-first (no audio in v1), custom Three.js WebGPU engine (no `fireworks-js`), browser runs on a modern Mac (Apple silicon) AirPlayed to an Apple TV — no dependency on the TV's GPU.

## 1. Goal

A locally hosted web page that renders the most realistic aerial fireworks show achievable in a browser on a modern Mac GPU. One "Start show" action produces an endless, non-repeating ambient display driven by a metadata catalog of real firework products. Explicit non-goals: operator cueing UI, audio (v1), mobile/TV-browser support, network exposure beyond localhost.

## 2. Runtime & platform contract

- **Host:** Node server (`node:http` + `serve-handler`) bound to `127.0.0.1`, static files only. `http://localhost` is a secure-context loopback, so WebGPU is available without HTTPS (MDN Secure Contexts).
- **Client:** Chrome (or another WebGPU browser) on macOS. AirPlay mirroring delivers the picture to the TV; the TV GPU is irrelevant.
- **WebGPU is required.** Probe before Start: `navigator.gpu` → `await navigator.gpu.requestAdapter()` (null-check) → `await adapter.requestDevice()` (MDN WebGPU API, "Accessing a device"). On failure, render a plain diagnostic naming the missing capability. No reduced-quality WebGL2 show in v1; Three's automatic WebGL2 backend fallback must be disabled or intercepted by the probe so realism is never silently degraded.
- **Fullscreen:** the Start button click (transient user activation) calls `container.requestFullscreen({ navigationUI: "hide" })` and handles rejection; denial runs the show windowed (MDN `Element.requestFullscreen`).
- **Frame pacing:** timestamp-based `requestAnimationFrame`; fixed-timestep simulation accumulator (120 Hz sim tick) so 60/120 Hz displays produce identical motion.
- **Resolution:** canvas backing store = CSS size × `devicePixelRatio`, updated via the MDN `matchMedia` resolution-change pattern.

## 3. Stack

- Three.js `three@0.185.0` (pinned): `WebGPURenderer`, TSL compute (`instancedArray`, `instanceIndex`, `Fn(...).compute(n)`, `renderer.compute(...)`), `SpriteNodeMaterial` node hooks, node postprocessing (`pass`, `mrt`, `bloom`, `RenderPipeline`). Legacy `EffectComposer` is WebGL-only and prohibited.
- Vite for dev/build; output is static files the Node server hosts.
- Vitest (or `node:test`) for deterministic units.

## 4. Components

### 4.1 Node server (`server/`)
`http.createServer` + `serve-handler(request, response, { public: "dist" })`, listening on `127.0.0.1`. No API endpoints. Directory listing disabled.

### 4.2 Effect catalog (`catalog/*.json`) — the meta description
One JSON document per device, schema-validated. Fields:

- Identity/provenance: `id`, `productName`, `sourceUrl`, `sourcePublisher`, `sourceKind` (glossary | product_page | catalog | generated), `accessedOn`, `verbatimText`, `normalizationStatus` (direct | alias | inferred).
- Device: `deviceType` (shell | cake | mine | comet | rocket), `shotCount`, `durationSeconds` (when published), `caliberHint` (small | medium | large — inferred, drives break radius/star count scale).
- Effect: ordered `phases[]`, each `{ kind: ascent | break | secondary | terminal, breakFamily?, colors[], effectTags[] }` where `breakFamily` ∈ peony, chrysanthemum, willow, horsetail, palm, crossette, fish, ring, pistil, crackling_flower and `effectTags` ⊂ {crackle, strobe, glitter, whistle, brocade, wave}.

Grounding rules (from Phantom glossary + Superior catalog research):
- peony = spherical break, **no** star trails; chrysanthemum = spherical break **with** spark trails.
- willow = long-burning gold/silver stars, soft dome, hang time ≥ ~8 s; horsetail = heavy tailed stars, **short** travel then free-fall — never merged with willow.
- crossette = each primary star splits into exactly **4** symmetric secondary tails.
- palm = few large comet-star arms + thick rising tail; fish = self-propelled stars swimming away; ring = planar ring, optional pistil core.
- Marketing superlatives stay in `verbatimText` only; no invented heights, velocities, or strobe frequencies.

Seed content: ~10 transcribed real products (e.g., Golden Pyro-Fusion 18-shot comet/crackle/crossette alternation; Strobe Spectacular 20-shot strobing tails → alternating willows; SFX Strobe Rockets 5 s strobe→willow; Color Comets & Crackling Flower Barrage 721 shots/30 s) plus glossary-grounded generic shells per family. A `generateCatalogEntry(rng)` function synthesizes additional schema-valid entries, marked `sourceKind: "generated"`.

### 4.3 Show planner (`src/show/planner.ts`)
Seeded PRNG (seed shown on idle screen for reproducibility; default = wall clock). Produces an endless timeline of scheduled launches: single shells alternating families, cake runs honoring `shotCount`/`durationSeconds` spacing, ground mines, escalation waves roughly every 2–4 min, short finales. Invariants: inter-event gap ≤ 2.5 s; concurrent live-star budget ≤ pool capacity; no immediate family repetition; launch x-positions jittered across the sky stage.

### 4.4 Effect compiler (`src/show/compiler.ts`)
Pure function: catalog entry + RNG → `GpuRecipe` (typed buffers/uniform values, no Three imports) describing emitter topology, star counts, per-phase timing, color ramps, and stochastic parameters (§5). Unit-testable without a GPU.

### 4.5 Simulation (`src/gpu/sim.ts`)
Fixed particle pool (~1–2 M capacity) in `instancedArray` buffers: position, velocity, color, age/lifetime, class flags (star | trail spark | crackle micro-flash | smoke). Per tick, TSL compute passes advance:
- **Ballistics:** gravity; per-particle quadratic drag by star class; global wind + gusts.
- **Events:** mortar launch with rising-tail spark emission; fuse-timed break; crossette/pistil secondary splits; terminal behaviors (willow hang, horsetail free-fall).
- **Emission:** per-class ring-buffer ranges — each launch event reserves a contiguous slot range on the CPU (one small uniform upload per event), and the compute pass activates slots whose spawn time has arrived. No CPU per-particle writes during steady state; slot ranges recycle after their class's max lifetime.

### 4.6 Imperfection layer (§5) — fire, not geometry
Randomness is a specified subsystem, not incidental jitter. All noise derives from the show seed + `instanceIndex` hashing (reproducible).

### 4.7 Persistent atmosphere (`src/gpu/atmosphere.ts`) — stateful smoke
The sky has memory. A burst leaves a smoke cloud whose decay is gradual (minutes-scale, not the burst's lifetime), and every later firework interacts with the smoke already hanging there.

- **Smoke density field:** a coarse world-space 3D density grid (low-res storage texture, e.g. 64×32×32 over the sky stage) updated per tick by a compute pass: breaks and rising tails inject density at their position (amount scaled by caliber), the field advects with the global wind, diffuses slowly, and decays exponentially with a 60–180 s time constant. This grid — not per-sprite fading alone — is the persistent state.
- **Smoke sprites:** low-count non-emissive drifting sprites spawned at breaks visualize the field's near-term structure; their opacity is driven by sampled local density so they dissipate with the field instead of on a fixed timer.
- **Burst light onto smoke:** the brightest concurrent bursts act as point-light sources for smoke shading. Smoke sprite `colorNode` accumulates contributions from the top-N (≈4) active burst lights (position, color, intensity uniforms maintained by the show loop) with inverse-square falloff — a shell exploding beside an old cloud visibly lights that cloud from its side.
- **Smoke onto star light:** star sprites sample the density field along the eye ray (few-tap march from star toward camera). Accumulated density widens and dims the halo (larger `scaleNode` glow disc, reduced emissive intensity, slight warm desaturation) — a firework bursting behind lingering smoke reads hazy and diffused, while the first shell of the night is crisp.

### 4.8 Renderer (`src/gpu/render.ts`)
Instanced sprites via `SpriteNodeMaterial` (`colorNode`, `positionNode`, `scaleNode`, `opacityNode`); scene pass with MRT emissive channel → selective `bloom(emissivePass, strength, radius)` → ACES filmic tone mapping through `RenderPipeline.outputNode`. Dark sky, subtle horizon/ground silhouette, very dim star field. Exposure eases down slightly during finale density. Smoke sprites render in the non-emissive channel so bloom stays selective to burning stars.

### 4.9 Boot/UI (`src/main.ts`)
Idle screen (title, seed, Start button) → capability probe → fullscreen attempt → show loop. Diagnostic panel on probe failure. `fullscreenerror` tolerated.

## 5. Imperfection layer (required behaviors)

1. **Curl-noise turbulence** on every particle velocity (strength by class: trail sparks ≫ heavy comet stars) — no straight-line traces anywhere.
2. **Burn-rate jitter:** per-star lifetime ±20–35 %, brightness flicker via per-star phase-offset noise (fire-like shimmer, not synchronized pulsing).
3. **Asymmetric breaks:** star directions = ideal topology ⊕ per-star angular noise (2–6°) ⊕ per-shell global deformation (squashed/tilted sphere, uneven arm spacing); per-star speed spread ±10–20 %.
4. **Shell imperfections:** per launch, small probabilities of weak break (reduced radius/count), off-center pistil, early/late fuse (±10 % break time), and occasional dud stars that go dark early.
5. **Tumbling/strobe irregularity:** strobe gates use per-star frequency + phase jitter; crackle spawns micro-flashes at Poisson-distributed times/offsets near end-of-life.
6. **Trail raggedness:** trail-spark emission intervals and ejection velocities jittered so comet tails are ragged and turbulent, never ribbon-smooth.
7. **Ascent wobble:** launch tilt ±3°, slight thrust asymmetry producing curved, individual rise paths; mines fan with uneven spoke spacing.
8. **Wind field:** slowly-varying global wind + gust noise; willow/horsetail descent visibly drifts.

## 6. Data flow

catalog JSON → (validate) → planner schedule → compiler `GpuRecipe` → uniform/buffer upload at launch time → GPU compute per tick (particles + smoke density field) → instanced draw (stars lit through smoke, smoke lit by bursts) → MRT/bloom/tonemap → screen (AirPlay mirrors it).

## 7. Error handling

- Probe failure → diagnostic panel (names missing API), no show start.
- Fullscreen rejection → windowed show.
- Catalog validation failure → entry skipped with console warning; show continues with remaining entries.
- Pool exhaustion → planner defers launches (never crashes or visibly pops particles).

## 8. Testing

- **Schema:** every shipped catalog entry validates; provenance fields required for non-generated entries.
- **Compiler:** crossette recipe yields exactly 4 secondary vectors per primary star; willow star mean lifetime > horsetail; peony recipe has zero trail emission, chrysanthemum non-zero; break-direction sets are non-uniform (asymmetry variance within configured bounds); fixed seed → identical recipe.
- **Planner:** fixed seed → deterministic schedule; gap and live-star-budget invariants hold over a simulated hour.
- **Atmosphere:** density-field decay is exponential with the configured time constant (CPU reference implementation of the update rule); injection increases local density; advection moves the density centroid downwind; field never goes negative or NaN under an hour of simulated events.
- **Smoke test:** server serves `dist/`; page boots; probe path exercised (mock `navigator.gpu` absence → diagnostic panel). Visual realism verified manually on the Mac.

## 9. Documentation anchors (implementation must copy these patterns)

- GPU compute + instanced sprites: three.js `examples/webgpu_compute_particles.html` (ea4b88c) L38–163, L270–279.
- Emissive MRT bloom: `examples/webgpu_postprocessing_bloom_emissive.html` (ea4b88c) L80–126.
- Renderer fallback semantics (to intercept): `src/renderers/webgpu/WebGPURenderer.js` (ea4b88c) L28–73.
- WebGPU probe: MDN WebGPU API "Accessing a device".
- Fullscreen: MDN `Element.requestFullscreen` "Requesting fullscreen mode" / "Using navigationUI".
- HiDPI + resolution listener: MDN `Window.devicePixelRatio` examples.
- rAF timing: MDN `Window.requestAnimationFrame` examples.
- Server: Node v26 `http.createServer` docs; `vercel/serve-handler` README "Usage"/"Options" (v6.1.8, MIT).
- Effect vocabulary: Phantom Fireworks glossary (cake, peony, chrysanthemum, willow, horsetail, palm, crossette, fish, mine); Phantom product pages (Golden Pyro-Fusion, Strobe Spectacular); Superior Fireworks rockets catalog + KL5013 barrage page. Accessed 2026-07-11.

## 10. Anti-patterns (prohibited)

- `fireworks-js` or any Canvas-2D starburst model.
- Three legacy `EffectComposer`/`UnrealBloomPass` with `WebGPURenderer`.
- Silent WebGL2 degradation; screen-height-triggered breaks (breaks are fuse-timed).
- Perfectly spherical/symmetric breaks, straight traces, synchronized flicker.
- Fabricated physical claims from marketing text; `colorChanging: true`-style flags without source wording.
- Per-frame CPU particle loops or per-particle JS object allocation during steady state.
