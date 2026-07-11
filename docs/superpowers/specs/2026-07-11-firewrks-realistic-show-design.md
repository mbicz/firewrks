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
- **Frame pacing:** timestamp-based `requestAnimationFrame`; fixed-timestep simulation accumulator at **60 Hz sim tick** (semi-implicit Euler with quadratic drag and curl noise is stable and visually sufficient at these speeds; 120 Hz would double compute cost for no visible gain). The renderer keeps a previous-position buffer per particle and interpolates by the accumulator alpha in the vertex stage, so 60/120 Hz displays produce identical, judder-free motion. The same prev/current position pair drives velocity-stretched motion blur (§4.8).
- **Resolution & fill-rate budget:** canvas CSS size × `devicePixelRatio`, but internal render resolution is **capped at 4K equivalent (~3840×2160)** — AirPlay output is at most 4K and bloom hides the upscale, so native 5K Retina rendering buys nothing. Overdraw is bounded: per-sprite screen-space size clamped, smoke-driven halo growth clamped, and a worst-case finale frame-time budget of p95 GPU frame time < 16.6 ms (§8). Resolution changes follow the MDN `matchMedia` pattern.

## 3. Stack

- Three.js `three@0.185.0` (pinned): `WebGPURenderer`, TSL compute (`instancedArray`, `instanceIndex`, `Fn(...).compute(n)`, `renderer.compute(...)`), `SpriteNodeMaterial` node hooks, node postprocessing (`pass`, `mrt`, `bloom`, `RenderPipeline`). Legacy `EffectComposer` is WebGL-only and prohibited.
- Vite for dev/build; output is static files the Node server hosts.
- Vitest (or `node:test`) for deterministic units.

## 3.5 World scale & camera contract

All physics run in meters with $g = 9.81\,\text{m/s}^2$; believability is scale-coupled, so these numbers are the shared frame every subsystem tunes against:

| `caliberHint` | Apex height | Break radius | Stars (primary) | Rise time |
|---|---|---|---|---|
| small | 90–140 m | 15–35 m | 60–150 | 2–3 s |
| medium | 140–220 m | 35–70 m | 150–400 | 3–4.5 s |
| large | 220–300 m | 70–125 m | 300–900 | 4–6 s |

Camera: fixed spectator position ~400 m from the launch line, ~10 m elevation, FOV 50°, aimed slightly above the horizon, framed for 16:9 so a large break at apex fills ~⅔ of frame height. Sky stage ≈ 600 m wide × 350 m tall × 200 m deep; the smoke grid (§4.7) spans exactly this stage. At most an extremely slow drift (<0.5°/s) — no cuts, no orbiting.

## 3.6 Chromatic strategy (pyro color science)

Pyrotechnic emitters are near-monochromatic (strontium red ~620–640 nm, barium green, copper blue ~430–460 nm, sodium amber 589 nm, magnesium/aluminum white continuum); naive HDR-through-tonemap desaturates and hue-skews exactly the colors the catalog preserves. Therefore:

- Star **chromaticity is authored separately from intensity**; intensity scales the emissive channel, never the hue.
- The photographic read is a **clipped white-hot core with a saturated halo**: bloom runs **pre-tonemap** on the emissive MRT channel so the halo keeps saturation while the core clips.
- Tonemap must be hue-preserving in practice: evaluate AgX and ACES-with-hue-compensation against red and blue test shells during Phase implementation; reject any mapping that turns bright copper blue purple.
- **Color-over-lifetime physics** per star: brief metal-fuel white ignition flash → color-agent-dominant phase → charcoal ember deep-red fade; the compiler emits this three-phase ramp, modulated per catalog colors.

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
Seeded PRNG (seed shown on idle screen for reproducibility; default = wall clock). Produces an endless timeline of scheduled launches: single shells alternating families, cake runs honoring `shotCount`/`durationSeconds` spacing, ground mines, escalation waves roughly every 2–4 min, short finales. The planner samples a **low-frequency macro intensity envelope** so the show breathes: deliberate sparse lulls (single shells, longer gaps) contrast with dense sequences — a constant cadence is prohibited wallpaper. Invariants: inter-event gap ≤ 2.5 s **only outside designated lulls** (lull gaps may reach 6 s); concurrent live-star budget ≤ pool capacity; **~30 % of the pool is a finale-only reserve** ambient scheduling may never claim; no immediate family repetition; launch x-positions jittered across the sky stage.

### 4.4 Effect compiler (`src/show/compiler.ts`)
Pure function: catalog entry + RNG → `GpuRecipe` (typed buffers/uniform values, no Three imports) describing emitter topology, star counts, per-phase timing, color ramps, and stochastic parameters (§5). Unit-testable without a GPU.

### 4.5 Simulation (`src/gpu/sim.ts`)
Fixed particle pool (~1–2 M capacity) in `instancedArray` buffers: position, velocity, color, age/lifetime, class flags (star | trail spark | crackle micro-flash | smoke). Per tick, TSL compute passes advance:
- **Ballistics:** gravity; per-particle quadratic drag by star class; global wind + gusts.
- **Events:** mortar launch with rising-tail spark emission; fuse-timed break; crossette/pistil secondary splits; terminal behaviors (willow hang, horsetail free-fall).
- **Emission (parent-index indirection):** per-class ring-buffer ranges — each launch event reserves a contiguous slot range on the CPU (one small uniform upload per event), and the compute pass activates slots whose spawn time has arrived. Child particles (trail sparks, crossette/pistil splits, crackle micro-flashes) cannot get spawn state from the CPU — the parent's position/velocity exists only in GPU buffers — so each reserved child slot stores a **parent index + spawn time**; on activation the compute pass copies the parent's state, with parents always advanced **before** children activate in the same tick (or children read previous-tick state). Slot-range recycling accounts for the worst-case lifetime including §5.2's +35 % jitter and willow ≥ 8 s hang, so live stars are never overwritten. No CPU per-particle writes during steady state.

### 4.6 Imperfection layer (§5) — fire, not geometry
Randomness is a specified subsystem, not incidental jitter. All noise derives from the show seed + `instanceIndex` hashing (reproducible).

### 4.7 Persistent atmosphere (`src/gpu/atmosphere.ts`) — stateful smoke
The sky has memory. A burst leaves a smoke cloud whose decay is gradual (minutes-scale, not the burst's lifetime), and every later firework interacts with the smoke already hanging there.

- **Smoke density field:** a coarse world-space 3D density grid (low-res **ping-pong storage texture pair** — advection/diffusion is a read-write hazard — e.g. 64×32×32 over the sky stage) updated per tick by a compute pass: breaks and rising tails inject density at their position (amount scaled by caliber), the field advects with the global wind, diffuses slowly, and decays exponentially with a 60–180 s time constant. The current texture is re-bound as a sampled texture for the render pass. This grid — not per-sprite fading alone — is the persistent state.
- **Smoke sprites:** low-count non-emissive drifting sprites spawned at breaks visualize the field's near-term structure; their opacity is driven by sampled local density so they dissipate with the field instead of on a fixed timer.
- **Burst light onto smoke:** the brightest concurrent bursts act as point-light sources for smoke shading. Smoke sprite `colorNode` accumulates contributions from the top-N (**N = 8**) active burst lights (position, color, intensity uniforms maintained by the show loop) with inverse-square falloff **plus a forward-scattering phase term (Henyey–Greenstein-style boost on `dot(lightDir, viewDir)`)** so a shell bursting behind an old cloud produces the signature backlit glow. Light-slot selection uses **hysteresis with per-slot intensity fade in/out (~150 ms)** so finale churn never pops smoke illumination.
- **Smoke onto star light:** star sprites sample the density field along the eye ray (few-tap march from star toward camera) **once per instance in the vertex/`positionNode` stage** — never per-fragment, where glow-disc overdraw would multiply the 3D taps. Accumulated density widens and dims the halo (larger `scaleNode` glow disc within the §2 clamp, reduced emissive intensity, slight warm desaturation) — a firework bursting behind lingering smoke reads hazy and diffused, while the first shell of the night is crisp.

### 4.8 Renderer (`src/gpu/render.ts`)
Instanced sprites via `SpriteNodeMaterial` (`colorNode`, `positionNode`, `scaleNode`, `opacityNode`). Fast stars are **velocity-stretched billboards**: each sprite elongates along projected velocity × frame dt using the prev/current position pair (§2) — round dots strobing across the sky ("beading") are the single biggest fireworks realism killer and are prohibited. Scene pass with MRT emissive channel → selective `bloom(emissivePass, strength, radius)` **pre-tonemap** → hue-preserving tonemap (§3.6) through `RenderPipeline.outputNode`.

- **Break flash:** every shell break emits a 2–3-frame high-intensity flash sprite so bloom kicks the way a burst charge does.
- **Scene illumination:** the horizon/ground silhouette material is driven by the same top-N burst-light uniforms (inverse-square with a wrap term) — finale gold willows visibly paint the ground; the sky is otherwise dark with a very dim star field.
- **Auto-exposure:** log-average-luminance auto-exposure with asymmetric adaptation (fast darkening, slow recovery) clamped to ±1.5 EV — handles finales, lone shells, and smoke-dimmed passages uniformly and produces the dazzle-then-recover beat; the dark sky never lifts to grey.
- Optional polish (post-v1 acceptable): 2–4-direction separable glare streaks on the emissive channel before tonemap for magnesium-white salutes.
- Smoke sprites render in the non-emissive channel so bloom stays selective to burning stars.

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
- **Allocator:** ring-buffer slot allocator invariants over a simulated hour — live ranges never overlap; recycling respects worst-case lifetime including §5.2 jitter and willow hang; finale reserve is never claimed by ambient scheduling.
- **Golden frames:** fixed seed + fixed timestep guarantee determinism — render designated frames in headless Chrome (WebGPU) and image-diff against blessed captures to catch shader regressions unit tests cannot.
- **Performance gate:** synthetic worst-case finale (max concurrent bursts + saturated smoke field) asserts p95 GPU frame time < 16.6 ms at the capped render resolution.
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
