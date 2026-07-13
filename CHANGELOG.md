# Changelog

## v0.0.0 — initial implementation

Design and implementation plan:

- Realistic GPU fireworks show design spec, written through brainstorming and revised against an
  independent expert VFX review (velocity-stretch motion blur, world-scale/camera contract, pyro
  color science, GPU secondary-emission mechanism, render-resolution/overdraw budget).
- Phased implementation plan hardened for execution across independent sessions: frozen type
  contracts, inlined API snippets, mechanical per-phase definitions of done.

Implementation, phase by phase:

- **Phase 1** — Vite/TypeScript scaffold, `127.0.0.1`-only static Node server, WebGPU capability
  probe with a diagnostic fallback, fullscreen-on-Start boot flow.
- **Phase 2** — Effect catalog schema with source provenance; ten real product documents
  transcribed from manufacturer/distributor pages plus glossary-grounded generic shells; seeded
  catalog-entry generator.
- **Phase 3** — Deterministic CPU core: seeded show planner (macro intensity envelope, lulls,
  escalations, finale reserve), catalog-entry → GPU-recipe compiler (per-family break topology,
  stochastic imperfection parameters, three-phase color ramp), ring-buffer particle-pool allocator
  with parent-index child reservation.
- **Phase 4** — TSL/WebGPU particle simulation: fixed-capacity storage buffers, fuse-timed
  ballistics/break/secondary-split/terminal compute passes, full imperfection layer (curl-noise
  turbulence, burn jitter, asymmetric breaks, dud stars, wind). Found and worked around a
  three@0.185.0 WebGPU-backend bug where partial updates to `vec3` storage buffers double-pad on
  every write after the first; every conceptually-`vec3` buffer uses `vec4` stride instead.
- **Phase 5** — Production renderer: velocity-stretched billboard sprites (no round-dot beading),
  MRT emissive channel with pre-tonemap selective bloom, a mechanically-chosen hue-preserving
  tonemap (`AgXToneMapping`, verified against a blue test shell), break-flash pop, burst-lit
  ground/horizon, clamped log-average auto-exposure.
- **Phase 6** — Persistent smoke atmosphere: a ping-pong 3D density field (inject/advect/diffuse/
  decay), non-emissive smoke sprites, hysteresis-and-crossfade burst-light bookkeeping with
  forward-scattering, and a once-per-instance (never per-fragment) star-haze vertex node. Found
  and fixed a bug where the break-flash gate coincidentally matched zero-initialized (never-
  launched) pool memory, flashing the entire unused particle pool white every frame.
- **Phase 7** — Real show integration: the planner → compiler → allocator → simulation/atmosphere/
  renderer loop replacing the boot-time stub, with pool-exhaustion deferral and finale-reserve
  enforcement. Found and fixed three further bugs during soak verification: wasted `compile()`
  calls before the allocator capacity check, a particle-pool recycling lockout introduced by the
  first fix, and an automatic per-minute NaN-scan GPU readback whose promise never resolves in a
  headless/backgrounded tab, stalling the shared WebGPU staging-buffer pool.
- **Phase 8** — Final verification and cleanup: resolved the project's WebGPU-typing diagnostics
  with the official `@webgpu/types` package instead of carrying known type errors; removed the
  Phase-4 debug point-sprite material once the production renderer fully superseded it; removed
  the unimplemented `golden` script and its `puppeteer` dependency; this README and changelog.

### Known limitations

- No automated visual-regression harness exists yet (the plan's "golden frame" capture script was
  never built; verification during development used an interactive headless-browser tool instead).
- A continuous, uninterrupted 30-simulated-minute soak could not be completed within the
  development sandbox's tool-call time budget — its WebGPU throughput is visibly far below the
  spec's target hardware (a real Apple-silicon Mac GPU). Every window that *was* observed (up to 5
  continuous simulated minutes, plus separate multi-minute stress-seed and cross-fix-boundary
  runs) showed clean, bounded telemetry with no crash, NaN, or unbounded growth.
- Live pool-exhaustion deferral was not empirically observed end-to-end in this sandbox — the 1.5M
  slot pool comfortably absorbed even the synthetic `stress` seed's peak load. The defer contract
  itself is unit-tested directly at the allocator level (`test/allocator.test.ts`).
