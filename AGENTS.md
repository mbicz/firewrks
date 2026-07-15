# AGENTS.md

Guidance for AI agents and contributors working in this repo. Read
[docs/architecture.md](docs/architecture.md) first for the system map.

## Commands

```sh
npm install
npm run dev         # Vite dev server (local show)
npm run build       # production bundle -> dist/
npm run serve       # serve dist/ on http://localhost:4173 (local show)
npm run cast        # WebRTC signaling + static server on 0.0.0.0:8765 (see docs/webrtc-cast.md)
npm run apk         # hand-build the Android receiver APK (see docs/android-client.md)
npm test            # Vitest (CPU-only, deterministic)
npm run typecheck   # tsc --noEmit
```

Always run `npm run typecheck` and `npm test` before committing. Both are fast.

## Layout

- `src/show/` — **CPU, pure, tested.** Catalog schema/data, planner, compiler, allocator, seeded
  RNG. No `three`, no GPU, no `Math.random()`.
- `src/gpu/` — **GPU (TSL/WebGPU).** `sim.ts` (particle compute), `atmosphere.ts` (smoke field +
  burst lights), `render.ts` (sprite/bloom/tonemap pipeline + ground/skyline/flares).
- `src/platform/` — capability probe, DPR/resolution, procedural `audio.ts`, `webrtcPublisher.ts`.
- `src/main.ts` — driver loop, UI, cast wiring.
- `server/` — `index.mjs` (local static), `stream.mjs` (cast signaling+static), `tv.html` (receiver).
- `android/` — framework-only WebView receiver APK + `build-apk.sh`.
- `catalog/` — real firework product JSON (with provenance).
- `test/` — Vitest unit tests for `src/show/` + `src/platform/audio.ts` pure helpers.

## Invariants (do not break)

- **Determinism.** All randomness flows through the seeded `mulberry32` PRNG (`src/show/rng.ts`).
  Never introduce `Math.random()` or wall-clock into the show logic. A fixed seed must reproduce an
  identical show; the planner/compiler PRNG draw *sequence* is a contract — don't reorder draws.
- **Frozen numeric contract.** World scale, jitter, decay, and pool constants live in
  `src/show/constants.ts`. Read them; don't re-type magic numbers elsewhere. Local *tuning*
  constants (renderer/atmosphere look params) may live in their own module, near use.
- **No per-tick allocation.** The steady-state loop in `main.ts` must not allocate — reuse the
  preallocated scratch (`scratchWind`, callbacks, heap/queue backing arrays).
- **Fixed pool, never drop.** The particle pool is fixed size; on exhaustion, *defer* launches
  (there's a finale reserve). Never silently drop an event.
- **One burst-light selection** (in `atmosphere.ts`) feeds ground, smoke, and flares.

## Conventions

- **TypeScript, strict.** No `any` escape hatches in new code. `three@0.185.0` ships no `.d.ts` for
  `three/webgpu` / `three/tsl`; the existing type aliases handle that — follow the local pattern.
- **TSL shaders.** Build node graphs with the imported `three/tsl` helpers. Guard against NaN from
  degenerate inputs (e.g. `normalize` of a zero vector on idle light slots — see the `select`
  gates in `render.ts`/`atmosphere.ts`). Never emit negative color channels (AgX turns them blue).
- **Comments carry the "why".** Many constants and workarounds were found from live visual/GPU
  debugging; when you change one, update the reasoning comment, don't just flip the number.
- **Android:** framework-only, **no Java lambdas** (JDK-8 `d8` can't desugar `invokedynamic`) —
  use anonymous classes.

## Testing expectations

- New CPU logic in `src/show/` (or pure helpers) gets a Vitest test that defends an observable
  contract (invariant, boundary, precedence) and would fail on a plausible bug.
- GPU/visual changes have no automated harness — verify interactively (a headless WebGPU browser,
  or the cast path + a device screencap) and describe what you exercised.
- Keep tests deterministic and isolated (seed every PRNG).

## Gotchas

- WebGPU needs a secure context: `http://localhost` and `https://` qualify; plain LAN `http://`
  does not give WebGPU (but does allow WebRTC *playback*, which is all the receiver needs).
- The cast publisher must run in a real GPU-backed browser window; a headless/software renderer is
  slow and may capture an off-aspect surface.
- Casting media is peer-to-peer UDP over the LAN; `adb reverse` only tunnels the TCP signaling.
