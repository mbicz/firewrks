# firewrks

A locally hosted, realistic aerial fireworks visualization for a big-screen TV. Runs in a WebGPU
browser on a modern Mac, mirrored to the TV over AirPlay (or any screen-share) — there is no
dependency on the TV's own GPU. One "Start show" produces an endless, non-repeating ambient
display driven by a metadata catalog of real firework products.

Full design rationale: [`docs/superpowers/specs/2026-07-11-firewrks-realistic-show-design.md`](docs/superpowers/specs/2026-07-11-firewrks-realistic-show-design.md).
Implementation plan: [`plans/2026-07-11-firewrks-implementation.md`](plans/2026-07-11-firewrks-implementation.md).

## Requirements

- Node.js and a Chromium-based browser with WebGPU support (Chrome on macOS is the target; run it
  on the Mac doing the AirPlay/screen-share, not on the TV).
- `http://localhost` is a secure-context loopback, so WebGPU works without HTTPS setup.

## Running the show

```sh
npm install
npm run build
npm run serve
```

Open `http://localhost:4173` (or whatever port `server/index.mjs` prints), click **Start**, and
mirror the browser window to the TV. The seed field lets you reproduce a specific show; a random
seed (current timestamp) is prefilled. `?seed=<n>` in the URL prefills it from a link.

For development, `npm run dev` runs Vite's dev server directly instead of building + serving the
static bundle.

## Debug/QA harness

`?debug=sim&seed=<n>` loads an isolated test-fixture scene (a single peony + crossette by
default) instead of the full ambient show, useful for inspecting one effect in isolation:

- `&shell=blue` — one pure `#2244ff` test shell (the tonemap-decision fixture).
- `&pair=1` — two identical peonies at the same `(x, z)`, 8 simulated seconds apart (the
  persistent-smoke-atmosphere visual fixture).
- `&stopAtFrame=N` — flips `document.title` to `FRAME_READY` after `N` rendered frames, for
  scripted frame capture.

Both the debug harness and the real show expose a QA handle on `window` —
`window.__firewrksDebug` / `window.__firewrksShow` — with `stepTicks(n)`, `renderFrame()`,
`getSimTime()`, `getStats()` (real show only), and `scanForNaN()` (GPU buffer readback; call this
explicitly and knowingly — it is not wired into the automatic tick loop, see `src/main.ts`'s
`stepOnce` comment for why).

To exercise the pool-exhaustion/deferral path, use the seed value `stress` (a fixed seed at a
much higher event rate) instead of a number.

## Testing

```sh
npm test          # Vitest: catalog schema, compiler, planner, allocator, atmosphere reference
npx tsc --noEmit   # type-check
```

All of the above are CPU-only and deterministic (seeded PRNG, no `Math.random()` anywhere). GPU
rendering/visual behavior has no automated test harness in this repo; verification during
development was done interactively via a headless browser tool. See the plan document's Phase 5
step 4 ("golden frames") for the intended (not yet built) automated visual-regression approach.

## Project layout

```
server/index.mjs      Node static server (127.0.0.1 only)
src/main.ts            Boot/UI, WebGPU capability probe, the real show loop
src/platform/          Capability probe + resolution/DPR handling
src/show/               Catalog schema + real product data, planner, compiler, allocator (CPU-only)
src/gpu/                Particle simulation, renderer/post pipeline, smoke atmosphere (TSL/WebGPU)
catalog/                Real firework product documents (with source provenance) + generic shells
test/                  Vitest unit tests for the CPU-only src/show modules
docs/superpowers/specs/ Design spec
plans/                 Implementation plan
```

## Realism notes

The effect catalog (`catalog/*.json`) is built from real manufacturer/distributor product pages
and a pyrotechnics glossary, not invented physics — each entry records its source URL, publisher,
and verbatim product text alongside the normalized effect vocabulary (see the design spec §4.2 for
the full grounding rules). The simulation is deliberately imperfect by design: curl-noise
turbulence, per-star lifetime/speed/angle jitter, asymmetric shell breaks, ragged trails, dud
stars, and a persistent, gradually-decaying smoke field that visibly lights and hazes later bursts
— see spec §5 and §4.7.
