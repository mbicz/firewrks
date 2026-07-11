# firewrks — Implementation Plan

Executes `docs/superpowers/specs/2026-07-11-firewrks-realistic-show-design.md` (commit `5509b44`). Each phase is self-contained for a fresh session: read the spec section(s) cited, copy the documented patterns cited, satisfy the verification checklist. Do not run formatters, linters, or project-wide suites mid-phase; Phase 8 does that once.

## Phase 0 — Documentation discovery (COMPLETE, consolidated)

**Allowed APIs (verified against maintainer source/docs on 2026-07-11):**

| API | Source anchor |
|---|---|
| `new THREE.WebGPURenderer({ antialias, forceWebGL, ... })`; WebGL2 fallback via `parameters.getFallback` (must be intercepted) | three.js `src/renderers/webgpu/WebGPURenderer.js` (ea4b88c) L28–73 |
| TSL: `instancedArray(count, 'vec3')`, `positions.element(instanceIndex)`, `Fn(() => {...})().compute(n)`, `renderer.compute(...)` | three.js `examples/webgpu_compute_particles.html` (ea4b88c) L38–163 |
| `SpriteNodeMaterial` with `.colorNode`, `.positionNode`, `.scaleNode`, `.opacityNode`; `sprite.count = n` | same example, L55–154 |
| Post: `pass(scene, camera)`, `scenePass.setMRT(mrt({ output, emissive }))`, `bloom(emissivePass, strength, radius)`, `new THREE.RenderPipeline(renderer)`, `.outputNode` | three.js `examples/webgpu_postprocessing_bloom_emissive.html` (ea4b88c) L80–126 |
| WebGPU probe: `navigator.gpu` → `await navigator.gpu.requestAdapter()` (null-check) → `await adapter.requestDevice()`; secure-context only | MDN WebGPU API, "Accessing a device" |
| `element.requestFullscreen({ navigationUI: "hide" })` promise + `fullscreenchange`/`fullscreenerror`; requires transient user activation | MDN `Element.requestFullscreen` |
| `window.devicePixelRatio` canvas sizing + `matchMedia` resolution-change listener | MDN `Window.devicePixelRatio` examples |
| `requestAnimationFrame(ts)` timestamp-driven motion | MDN `Window.requestAnimationFrame` |
| Node: `http.createServer([options][, listener])`, `server.listen(port, host, cb)` | Node v26 `doc/api/http.md` L3670+, `doc/api/net.md` L634–665 |
| `serve-handler(request, response, { public, ... })` v6.1.8 MIT | vercel/serve-handler README "Usage"/"Options" |
| Effect vocabulary + real product sequences | Phantom glossary + product pages; Superior rockets catalog + KL5013 (spec §9) |

**Known anti-patterns (global, all phases):** `fireworks-js`/Canvas-2D starbursts; legacy `EffectComposer`/`UnrealBloomPass` with WebGPURenderer; silent WebGL2 degradation; screen-height-triggered breaks; perfect spheres/straight traces/synchronized flicker; invented catalog physics; CPU per-particle steady-state writes; `three/nodes` import path (current is `three/tsl`); inventing TSL functions not present in the pinned three@0.185.0.

## Phase 1 — Scaffold, server, boot gate

**Implement:** Vite + TypeScript project; `server/index.mjs` (`http.createServer` + `serve-handler`, `127.0.0.1`, directory listing off); idle screen with title/seed/Start; WebGPU probe module; fullscreen attempt on Start; diagnostic panel on probe failure; capped-resolution canvas sizing (spec §2, §4.1, §4.9).
**Copy from:** MDN WebGPU probe snippet verbatim; MDN fullscreen toggle pattern; serve-handler README usage block; MDN devicePixelRatio canvas example (add the 4K cap).
**Verify:** `node server/index.mjs` serves the built page on `http://localhost:PORT`; probe failure path renders diagnostic when `navigator.gpu` is stubbed out; Start → fullscreen promise handled (denial tolerated); unit test for the resolution-cap function.
**Guards:** no `0.0.0.0` binding; no fullscreen call outside the click handler; no WebGL fallback acceptance — if the probe fails, the show must not start.

## Phase 2 — Effect catalog + generator

**Implement:** JSON schema (spec §4.2 fields incl. provenance), `catalog/*.json` with ~10 transcribed real products + glossary-grounded generics, `generateCatalogEntry(rng)`, validation module (spec §4.2, §7).
**Copy from:** spec §4.2 grounding rules verbatim; product wording from spec §9 sources into `verbatimText` (Golden Pyro-Fusion, Strobe Spectacular, SFX Strobe Rockets, KL5013).
**Verify:** schema tests pass — all shipped entries validate; non-generated entries require provenance; invalid entry is skipped with a warning, show data still loads; generated entries validate under fuzz (100 seeds).
**Guards:** no numeric height/velocity/strobe-rate fields sourced from marketing text; horsetail ≠ willow; crossette split count fixed at 4.

## Phase 3 — Planner, compiler, allocator (CPU, deterministic)

**Implement:** seeded PRNG; show planner with macro intensity envelope, lulls, escalation, finales, 30 % finale pool reserve (spec §4.3); effect compiler catalog→`GpuRecipe` with world-scale table (spec §3.5), three-phase color ramps (spec §3.6), stochastic parameters (spec §5); ring-buffer slot allocator with parent-index child reservation and worst-case-lifetime recycling (spec §4.5).
**Copy from:** spec §3.5 caliber table as the single scale constant module; spec §5 items 1–8 as named, testable recipe parameters.
**Verify:** all spec §8 CPU tests — compiler (crossette 4-way, willow > horsetail lifetime, peony zero-trail vs chrysanthemum, asymmetry variance bounds, seed determinism), planner (determinism, gap/budget invariants over simulated hour, lull gaps ≤ 6 s, reserve untouched by ambient), allocator (no live-range overlap, jitter-aware recycling).
**Guards:** no Three imports in `src/show/**`; no `Math.random()` anywhere (seeded PRNG only); no per-particle JS objects in recipes (typed arrays).

## Phase 4 — GPU simulation core

**Implement:** particle pool in `instancedArray` buffers (position, prevPosition, velocity, color, age/lifetime, class); compute passes: activation (parent-index copy, parents before children), ballistics (gravity, per-class quadratic drag, wind+gusts), events (fuse-timed break, secondary splits, terminal behaviors), imperfection (curl noise, burn jitter, flicker, dud stars) (spec §4.5, §4.6, §5).
**Copy from:** three.js compute-particles example L38–163 for buffer/compute structure — extend, don't reinvent; `Fn().compute(n)` + `renderer.compute()` per tick at 60 Hz fixed timestep with accumulator (spec §2).
**Verify:** headless page runs the sim with a debug readback of a small pool: a launched shell breaks at fuse time ±10 % jitter window, not at a screen height; crossette children activate at parent positions; no NaNs after 10 simulated minutes; prevPosition buffer updates every tick.
**Guards:** no per-tick CPU buffer writes beyond the per-event uniform/range upload; no `three/nodes` imports; breaks keyed to fuse time only.

## Phase 5 — Renderer & post pipeline

**Implement:** velocity-stretched billboards from prev/current positions with accumulator-alpha interpolation; `SpriteNodeMaterial` nodes; MRT emissive channel; pre-tonemap selective bloom; hue-preserving tonemap evaluation (AgX vs ACES+hue-compensation on red/blue test shells — pick and record the winner); break flash sprites; burst-lit ground/horizon; clamped auto-exposure; screen-space sprite size clamp (spec §2, §3.6, §4.8).
**Copy from:** bloom-emissive example L80–126 for the `pass`/`mrt`/`bloom`/`RenderPipeline` wiring; compute-particles example for sprite material node assignments.
**Verify:** golden-frame harness bootstrapped — fixed seed frames image-diffed in headless Chrome; visual check: no beading on fast stars at 60 Hz; bright copper-blue test shell does not shift purple; break flash visible ≤ 3 frames; sky stays black under auto-exposure.
**Guards:** no `EffectComposer`; bloom input is the emissive MRT channel only (smoke/ground stay out); tonemap decision documented in-code with the test-shell evidence.

## Phase 6 — Persistent atmosphere

**Implement:** ping-pong 3D density storage textures (64×32×32 over the §3.5 stage); inject/advect/diffuse/decay compute pass; smoke sprites with density-driven opacity; top-8 burst lights with hysteresis + 150 ms fades, inverse-square + Henyey–Greenstein forward scattering; per-instance eye-ray density march in `positionNode` driving halo widen/dim/warm (spec §4.7).
**Copy from:** compute-particles storage/compute idioms; spec §4.7 wording is the behavioral contract.
**Verify:** CPU reference tests (decay constant, injection, downwind advection, no negatives/NaN over simulated hour) match the shader update rule; visual check: second shell into an old cloud reads hazy + cloud is side/back-lit; first shell of a fresh show is crisp.
**Guards:** density march never per-fragment; light-slot swaps never pop (fade verified); smoke sprites non-emissive.

## Phase 7 — Show integration

**Implement:** wire planner→compiler→allocator→GPU uploads in the show loop; pool-exhaustion deferral; finale reserve enforcement at runtime; seed display; long-run stability (spec §4.3, §6, §7).
**Verify:** 30-minute unattended run without crash, leak (heap + GPU buffer counts stable), or visible particle pops; deferral path exercised by a synthetic over-scheduled seed.
**Guards:** no steady-state allocations in the rAF loop (verify with a heap snapshot diff).

## Phase 8 — Final verification & cleanup

1. Full test suite green (schema, compiler, planner, allocator, atmosphere reference, golden frames).
2. Performance gate: synthetic worst-case finale, p95 GPU frame time < 16.6 ms at capped resolution.
3. Anti-pattern greps: `fireworks-js`, `EffectComposer`, `UnrealBloomPass`, `Math.random(`, `three/nodes`, `getContext('2d'` — all zero hits in `src/`.
4. Manual visual pass on the Mac + AirPlay to the TV: fullscreen, ambient hour sampling, finale, smoke persistence, color fidelity.
5. Cleanup: README (run instructions: `npm run build`, `node server/index.mjs`, open `http://localhost:PORT`, press Start), changelog entry, remove scaffolding/debug readbacks.
