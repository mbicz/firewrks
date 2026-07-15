import * as THREE from 'three/webgpu';

import { probeWebGPU } from './platform/probe';
import { fit, watchDPR } from './platform/screen';
import { runDebugSim } from './gpu/debugHarness';
import { DT, ParticleSim } from './gpu/sim';
import { ShowRenderer, buildShowCamera } from './gpu/render';
import { Atmosphere } from './gpu/atmosphere';
import { loadCatalogEntries, type CatalogEntry } from './show/catalog';
import { mulberry32 } from './show/rng';
import { planShow, type PlannerEvent } from './show/planner';
import { POOL_CAPACITY, STAGE } from './show/constants';
import { ShowAudio } from './platform/audio';
import { startPublisher } from './platform/webrtcPublisher';

// ---------------------------------------------------------------------------
// Phase 7 — real show integration (spec §4.3, §6, §7): planner -> compiler (inside
// `ParticleSim.launch`) -> allocator -> ParticleSim/Atmosphere/ShowRenderer, replacing this
// module's former `startShow` stub. Structurally mirrors `debugHarness.ts`'s tick/render split
// (same accumulator pattern, same `__firewrks*` QA-handle idea) but drives the REAL endless
// catalog-backed planner schedule instead of a fixed synthetic fixture, and additionally: (a)
// requeues on pool-exhaustion deferral instead of assuming every launch succeeds, (b) preallocates
// every per-tick scratch value/callback (steady-state loop must not allocate — see `stepOnce`),
// (c) shows the reproducibility seed per spec §4.3/§6/§7.
// ---------------------------------------------------------------------------

// Worst-case single-shot pool footprint: a large-caliber crossette can reserve up to 900 primary
// stars x 4 secondary tails each (=3600) plus trail-spark children, so a shot that would fit
// inside this margin below the pool ceiling is never falsely pre-rejected; one comfortably above
// every real per-shot demand.
const POOL_HIGH_WATER_MARGIN = 6000;
const DEFER_DELAY_S = 0.25; // spec §7: pool exhaustion requeues +250ms (base delay), never drops the event.
const ASCENT_INJECT_HEIGHT_FRAC = 0.4; // rough mid-rise height for the ascent smoke puff (mirrors debugHarness).
const SEED_LABEL_VISIBLE_MS = 5000; // spec: seed shown small in a corner for 5s...
const SEED_LABEL_FADE_MS = 1000; // ...then fades.
const STRESS_SEED = 424242; // fixed numeric seed backing the `?seed=stress` synthetic fixture.
const STRESS_RATE_MULTIPLIER = 10; // plan Phase 7 DoD: "planner mode multiplying event rate x10".

// Catalog JSON is static build-time data (spec §4.2) — bundled via Vite's glob import rather than
// fetched at runtime, so the real show never depends on the static server exposing a `/catalog`
// route beyond what `dist/` already contains.
const catalogModules = import.meta.glob<{ default: unknown }>('/catalog/*.json', { eager: true });

function loadRealCatalog(): CatalogEntry[] {
  const raw = Object.values(catalogModules).map((mod) => mod.default);
  return loadCatalogEntries(raw);
}

function parseSeedInput(raw: string): { seed: number; rateMultiplier: number } {
  if (raw.trim().toLowerCase() === 'stress') return { seed: STRESS_SEED, rateMultiplier: STRESS_RATE_MULTIPLIER };
  const seed = Number(raw);
  return { seed: Number.isFinite(seed) ? seed : Date.now(), rateMultiplier: 1 };
}

function showSeedLabel(seed: number): void {
  const label = document.createElement('div');
  label.textContent = `seed ${seed}`;
  label.style.cssText =
    'position:fixed;right:10px;bottom:8px;color:rgba(255,255,255,0.55);font:12px/1.4 monospace;' +
    `pointer-events:none;z-index:10;transition:opacity ${SEED_LABEL_FADE_MS}ms linear;`;
  document.body.appendChild(label);
  label.addEventListener('transitionend', () => label.remove());
  setTimeout(() => {
    label.style.opacity = '0';
  }, SEED_LABEL_VISIBLE_MS);
}

// ---------------------------------------------------------------------------
// Event-rate bookkeeping. Both structures are sized by launch/break EVENT rate, not tick rate —
// pushes/pops happen once per event, never inside the per-tick steady-state path.
// ---------------------------------------------------------------------------

interface PendingBreak {
  breakTime: number;
  position: THREE.Vector3;
  color: THREE.Color;
  starCount: number;
}

/** Small binary min-heap keyed by `breakTime`. `ParticleSim.launch()` returns each launch's exact
 * break time/position up front (breaks are fuse-timed, not detected from GPU state — spec §4.7),
 * but launches don't resolve in strict breakTime order (a short-fuse small shell launched after a
 * long-fuse large one breaks first), so a FIFO queue would delay `atmosphere.registerBreak()`
 * calls for out-of-order shells. */
class BreakHeap {
  private readonly items: PendingBreak[] = [];

  push(item: PendingBreak): void {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].breakTime <= this.items[i].breakTime) break;
      const tmp = this.items[parent];
      this.items[parent] = this.items[i];
      this.items[i] = tmp;
      i = parent;
    }
  }

  peek(): PendingBreak | undefined {
    return this.items[0];
  }

  pop(): PendingBreak | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (last !== undefined && this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && this.items[l].breakTime < this.items[smallest].breakTime) smallest = l;
        if (r < n && this.items[r].breakTime < this.items[smallest].breakTime) smallest = r;
        if (smallest === i) break;
        const tmp = this.items[smallest];
        this.items[smallest] = this.items[i];
        this.items[i] = tmp;
        i = smallest;
      }
    }
    return top;
  }

  get size(): number {
    return this.items.length;
  }
}

/** FIFO queue of deferred launch events (spec §7: pool exhaustion defers, never drops). A
 * deferred event's due-time is always `simTime + DEFER_DELAY_S` at the moment of deferral, and
 * `simTime` only advances, so push order already equals due-time order — no heap needed. Uses a
 * head-index instead of `Array.shift()` (O(n)) and only compacts the backing array periodically,
 * an event-rate operation, never a per-tick one. */
class DeferredQueue {
  private items: (PlannerEvent | undefined)[] = [];
  private head = 0;

  push(event: PlannerEvent): void {
    this.items.push(event);
  }

  peek(): PlannerEvent | undefined {
    return this.items[this.head];
  }

  pop(): PlannerEvent | undefined {
    const event = this.items[this.head];
    if (event !== undefined) {
      this.items[this.head] = undefined;
      this.head++;
      if (this.head > 256 && this.head * 2 > this.items.length) {
        this.items = this.items.slice(this.head);
        this.head = 0;
      }
    }
    return event;
  }

  get length(): number {
    return this.items.length - this.head;
  }
}

// ---------------------------------------------------------------------------
// QA verification handle (mirrors `debugHarness.ts`'s `window.__firewrksDebug`): drives the REAL
// show loop's own fixed-timestep tick advancement directly, bypassing `requestAnimationFrame`'s
// wall-clock pacing, so a multi-minute simulated soak can be driven in a tight loop.
// ---------------------------------------------------------------------------

interface ShowStats {
  liveRangeCount: number;
  liveSlotCount: number;
  deferredQueueLength: number;
  pendingBreakCount: number;
  launchedCount: number;
  deferredEventCount: number;
  poolCapacity: number;
}
interface FirewrksShowHandle {
  stepTicks(n: number): number;
  renderFrame(): void;
  getSimTime(): number;
  getStats(): ShowStats;
  scanForNaN(): Promise<number>;
  /** Live scene objects for QA visual isolation (toggle `.visible`, read uniforms) — the same
   * role stepTicks/scanForNaN play for the sim loop, but for renderer-side diagnosis. */
  objects: { show: ShowRenderer; atmosphere: Atmosphere; sim: ParticleSim };
}
declare global {
  interface Window {
    __firewrksShow?: FirewrksShowHandle;
  }
}

/** Real show integration (plan Phase 7; spec §4.3, §6, §7): catalog -> planner -> (compiler +
 * allocator, inside `ParticleSim.launch`) -> GPU, with pool-exhaustion deferral and the finale
 * reserve enforced by threading `PlannerEvent.finale` through to the allocator. */
async function startShow(seed: number, rateMultiplier = 1, stream = false): Promise<void> {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();

  const container = document.querySelector<HTMLDivElement>('#app');
  if (container) container.innerHTML = '';
  (container ?? document.body).appendChild(renderer.domElement);

  // Falls back to spec §3.5's 16:9 framing if the viewport briefly reports zero size at
  // construction (see the `applySize` comment below) — never feed a NaN aspect ratio in.
  const camera = buildShowCamera(window.innerWidth > 0 && window.innerHeight > 0 ? window.innerWidth / window.innerHeight : 16 / 9);

  // Resolution cap (spec §2: internal render resolution capped ~3840x2160): CSS layout size
  // tracks the viewport, but the backing (device-pixel) size is capped by scaling the pixel
  // ratio down, never by shrinking the CSS box.
  function applySize(): void {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    // A 0x0 viewport (tab backgrounded/hidden, mid-layout in an embedding host) makes the
    // backing/CSS ratio below divide by zero, producing a NaN pixel ratio that corrupts the
    // renderer's backing-store size and crashes the next `render()` call inside three.js's
    // WebGPU texture creation ("Value NaN is outside the range..."). Root-caused via that exact
    // stack trace during Phase 7's compressed soak verification; skip resizing until the
    // viewport reports a real size again (the next resize/DPR change re-fires this).
    if (cssW <= 0 || cssH <= 0) return;
    const backing = fit(cssW, cssH, window.devicePixelRatio);
    renderer.setPixelRatio(backing.w / cssW);
    renderer.setSize(cssW, cssH);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();
  }
  watchDPR(applySize); // fires once immediately (initial sizing) + on every future DPR change.
  window.addEventListener('resize', applySize);

  const rng = mulberry32(seed);
  const entries = loadRealCatalog();
  if (entries.length === 0) throw new Error('startShow: catalog produced zero valid entries');
  const catalogById = new Map(entries.map((entry) => [entry.id, entry]));

  const sim = new ParticleSim(renderer, POOL_CAPACITY);
  const atmosphere = new Atmosphere(renderer, rng);
  const show = new ShowRenderer(renderer, camera, sim, atmosphere);
  show.scene.add(atmosphere.smokeSprite);

  showSeedLabel(seed);

  // Procedural sound (platform/audio.ts). Created here because startShow only ever runs inside
  // the Start button's click call stack — the user gesture WebAudio requires. Seeded with its
  // own derived stream so audio jitter never consumes draws from the planner/compiler `rng`
  // (their draw sequences are the seed-reproducibility contract). `?mute` disables entirely —
  // also the right default for headless soak harnesses.
  const muted = new URLSearchParams(location.search).has('mute');
  // In cast mode (`stream`) the audio must play on the TV via the captured track, not the Mac's
  // speakers, so local output is silenced (outputLocal=false) while the capture tap stays live.
  const audio = muted ? null : new ShowAudio(mulberry32(seed ^ 0x5f3759d), !stream);

  // Preallocated per-tick scratch/callbacks — the steady-state loop below must not allocate
  // (plan Phase 7 guard): a fresh closure or Vector3 every tick, at 60 Hz over a multi-hour
  // ambient show, is exactly the per-frame CPU allocation §10 prohibits.
  const scratchWind = new THREE.Vector3();
  const scratchAscentPos = new THREE.Vector3();
  const pushLightCb = (i: number, position: THREE.Vector3, color: THREE.Color, intensity: number) =>
    show.setBurstLight(i, position, color, intensity);
  const clearLightCb = (i: number) => show.clearBurstLight(i);

  const schedule = planShow(entries, rng);
  const deferredQueue = new DeferredQueue();
  const breakHeap = new BreakHeap();

  let pendingEvent: PlannerEvent = schedule.next().value; // endless generator: always yields, never `done`.
  let simTime = 0;
  let tickCount = 0;
  let launchedCount = 0;
  let deferredEventCount = 0;

  function approxLiveSlotCount(): number {
    // Prune expired ranges FIRST: `Allocator.recycle` otherwise only runs inside `reserve()`,
    // which this cheap pre-check exists specifically to skip when the pool looks full — without
    // this call, a once-full pool could never appear to free up again (see `Allocator.recycle`'s
    // doc comment for the full self-lockout mechanism this closes). Cheap and idempotent: O(live
    // range count), safe to call unconditionally every event-processing attempt.
    sim.allocator.recycle(simTime);
    let n = 0;
    for (const r of sim.allocator.liveRanges) n += r.count;
    return n;
  }

  function requeueDelay(): number {
    // Jittered, not fixed: every failed launch that shares the exact same `simTime` would
    // otherwise re-defer to the exact same future due-time, and if the pool stays saturated that
    // whole batch keeps re-synchronizing onto itself tick after tick — a thundering-herd retry
    // storm. Root-caused during Phase 7's compressed soak (KL5013's 721-shot cake, whose ~0.04s
    // shot spacing floods far more launch attempts than the pool can absorb at once, made this
    // reproduce within tens of simulated seconds and hard-hang the tab). Jittering spreads
    // retries back out over roughly [0.25s, 0.55s] so they drain instead of resonating.
    return DEFER_DELAY_S * (1 + rng());
  }

  function processLaunch(event: PlannerEvent): void {
    const entry = catalogById.get(event.entryId);
    if (!entry) {
      console.warn(`[show] planner emitted unknown catalog id "${event.entryId}"; dropping`);
      return;
    }
    // Cheap pre-check BEFORE `sim.launch()`, which unconditionally calls `compile()` (typed-array
    // + per-star trig/noise for up to 900 stars) ahead of its own (comparatively cheap) allocator
    // capacity check. Under sustained pool pressure, every failed retry was re-paying that full
    // compile cost only to immediately discard it — this `approxLiveSlotCount()` sum is O(live
    // range count), a couple hundred entries, orders of magnitude cheaper. Applies to finale
    // events too (originally exempted, wrongly — a finale burst hitting a genuinely saturated
    // pool hit the exact same wasted-compile storm during soak testing): `POOL_CAPACITY` here is
    // already the correct ceiling for both cases, matching `Allocator.reserve`'s own `windowEnd`
    // (`finale ? capacity : capacity*(1-FINALE_RESERVE)`) — finale may use the full capacity, so
    // checking against the full capacity (not the smaller ambient window) is exactly right for it.
    if (approxLiveSlotCount() + POOL_HIGH_WATER_MARGIN > POOL_CAPACITY) {
      deferredQueue.push({ t: simTime + requeueDelay(), entryId: event.entryId, phaseIdx: event.phaseIdx, x: event.x, finale: event.finale });
      deferredEventCount++;
      return;
    }
    const breakEvent = sim.launch(entry, event.phaseIdx, rng, simTime, event.x, 0, event.finale);
    if (breakEvent === null) {
      // Pool exhaustion (spec §7): `allocator.reserve` never overwrites a live range — requeue
      // instead, unless this WAS already a finale event (finale already got the widest possible
      // reservation window; retrying identically is still correct and terminates once capacity
      // frees up).
      deferredQueue.push({ t: simTime + requeueDelay(), entryId: event.entryId, phaseIdx: event.phaseIdx, x: event.x, finale: event.finale });
      deferredEventCount++;
      return;
    }
    launchedCount++;
    audio?.launch(event.x);
    scratchAscentPos.set(event.x, breakEvent.position.y * ASCENT_INJECT_HEIGHT_FRAC, 0);
    atmosphere.injectAscent(scratchAscentPos, breakEvent.starCount);
    breakHeap.push({ breakTime: breakEvent.breakTime, position: breakEvent.position, color: breakEvent.color, starCount: breakEvent.starCount });
  }

  /** Pulls every event due by `simTime` from BOTH sources (the live generator and the deferred
   * requeue), always processing whichever is due earliest — a stress-compressed schedule can
   * pack several events inside a single 1/60s tick, so this loops, not a single `if`. */
  function pumpEvents(): void {
    for (;;) {
      const deferredFront = deferredQueue.peek();
      const deferredDueAt = deferredFront === undefined ? Infinity : deferredFront.t;
      const generatorDueAt = pendingEvent.t / rateMultiplier;
      if (Math.min(deferredDueAt, generatorDueAt) > simTime) break;

      if (deferredDueAt <= generatorDueAt) {
        processLaunch(deferredQueue.pop()!);
      } else {
        processLaunch(pendingEvent);
        pendingEvent = schedule.next().value;
      }
    }
  }

  function pumpBreaks(): void {
    for (;;) {
      const top = breakHeap.peek();
      if (top === undefined || top.breakTime > simTime) break;
      breakHeap.pop();
      atmosphere.registerBreak(top.position, top.color, top.starCount, simTime);
      // Boom scheduled at the FLASH's own moment (this tick) + speed-of-sound travel delay —
      // hooked here rather than at launch so compressed QA soaks (stepTicks) can't front-load
      // minutes of booms, and there's zero sim-vs-audio clock drift to accumulate.
      audio?.breakAt(top.position.x, top.position.y, top.position.z, top.starCount, 0);
    }
  }

  /** One fixed 1/60s sim step (spec §2). Zero allocations: every object touched above this line
   * (`scratchWind`, `pushLightCb`/`clearLightCb`, the heap/queue backing arrays) is preallocated;
   * `processLaunch` only runs at event rate (bounded, sparse), never once per tick.
   *
   * Deliberately does NOT call `sim.scanForNaN()` automatically. It did, once per simulated
   * minute, until Phase 7's compressed soak testing found `renderer.getArrayBufferAsync`'s
   * promise never resolving in this sandbox's headless/backgrounded tab context — and every
   * frame after that first stuck readback got progressively (then catastrophically) slower,
   * consistent with three.js's WebGPU backend reusing a small internal pool of staging buffers
   * for ALL buffer readbacks/uploads (including the per-launch `addUpdateRange` uploads this
   * loop's steady-state path depends on): one permanently-unresolved `mapAsync` can starve that
   * pool for every later caller, not just future NaN scans. `scanForNaN()` stays available on
   * `window.__firewrksShow` for an operator/test harness to invoke explicitly and knowingly
   * accept that risk — it must never be wired into the unattended per-tick path again.
   */
  function stepOnce(): void {
    pumpEvents();
    pumpBreaks();
    sim.windVectorInto(scratchWind);
    atmosphere.tick(simTime, DT, scratchWind, pushLightCb, clearLightCb);
    sim.tick(simTime);
    simTime += DT;
    tickCount++;
  }

  function renderFrame(): void {
    show.render();
  }

  // Interactive launches (live request): a click/tap anywhere fires one extra shell whose stage
  // x matches the clicked screen x. Reuses `processLaunch` wholesale — pool pre-check, deferral,
  // ascent smoke, break heap — so an interactive shell is indistinguishable from a scheduled one.
  // Vocabulary mirrors the planner's collectShots predicate (primary break phases only). Note:
  // interactive shots draw from the shared show `rng` at launch time, perturbing the remaining
  // schedule — unavoidable and correct: reproducibility is only promised for untouched runs.
  const interactiveShots: { entryId: string; phaseIdx: number }[] = [];
  for (const entry of entries) {
    entry.phases.forEach((phase, phaseIdx) => {
      if (phase.kind === 'break' && phase.breakFamily) interactiveShots.push({ entryId: entry.id, phaseIdx });
    });
  }
  renderer.domElement.addEventListener('pointerdown', (e: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0) return;
    const shot = interactiveShots[Math.floor(rng() * interactiveShots.length)];
    const x = ((e.clientX - rect.left) / rect.width - 0.5) * STAGE.w;
    processLaunch({ t: simTime, entryId: shot.entryId, phaseIdx: shot.phaseIdx, x, finale: false });
  });

  // QA verification hook (see the block comment above `FirewrksShowHandle`): the real show's
  // counterpart to `debugHarness.ts`'s `window.__firewrksDebug`, driving this SAME loop's own
  // `stepOnce`/`renderFrame` — not a separate synthetic path — so a compressed multi-minute
  // soak exercises exactly the production integration.
  window.__firewrksShow = {
    stepTicks(n: number): number {
      for (let i = 0; i < n; i++) stepOnce();
      show.setAlpha(1);
      renderFrame();
      return simTime;
    },
    renderFrame,
    getSimTime: () => simTime,
    getStats: (): ShowStats => {
      let liveSlotCount = 0;
      for (const range of sim.allocator.liveRanges) liveSlotCount += range.count;
      return {
        liveRangeCount: sim.allocator.liveRanges.length,
        liveSlotCount,
        deferredQueueLength: deferredQueue.length,
        pendingBreakCount: breakHeap.size,
        launchedCount,
        deferredEventCount,
        poolCapacity: POOL_CAPACITY,
      };
    },
    scanForNaN: () => sim.scanForNaN(),
    objects: { show, atmosphere, sim },
  };

  let acc = 0;
  let lastTs = performance.now();

  // WebRTC publish (`?stream=1`): cast this WebGPU render to a display-only client (e.g. an
  // Android TV whose WebView lacks WebGPU). captureStream grabs the canvas; the show's audio
  // rides along via ShowAudio's capture tap. Media is peer-to-peer over the LAN — see
  // src/platform/webrtcPublisher.ts and server/stream.mjs.
  if (stream) {
    const castStream = renderer.domElement.captureStream(30);
    if (audio) castStream.addTrack(audio.audioTrack);
    startPublisher(castStream);
  }

  function frame(ts: number): void {
    const rawDt = Math.min((ts - lastTs) / 1000, 0.25);
    lastTs = ts;
    acc += rawDt;

    while (acc >= DT) {
      stepOnce();
      acc -= DT;
    }

    show.setAlpha(acc / DT); // spec §2: interpolate the render position by the accumulator alpha.
    renderFrame();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

function renderDiagnostic(reason: string): void {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  app.innerHTML = '';
  // Readable on the black body (index.html sets background:#000) and on a TV from across the
  // room: light text, centered, generous size. A default <pre> is black-on-black — invisible,
  // which is exactly what a no-WebGPU device (e.g. Android WebView < 121) would show.
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:0.6em;color:#f0e8dc;font:600 28px system-ui,sans-serif;' +
    'text-align:center;padding:6vh 8vw;';
  const title = document.createElement('div');
  title.textContent = 'WebGPU unavailable';
  title.style.cssText = 'font-size:40px;color:#ffd27a;';
  const detail = document.createElement('div');
  detail.textContent = reason;
  detail.style.cssText = 'font-size:22px;font-weight:400;opacity:0.85;max-width:36em;';
  const hint = document.createElement('div');
  hint.textContent = 'This device\u2019s System WebView is too old for WebGPU (needs WebView 121+).';
  hint.style.cssText = 'font-size:18px;font-weight:400;opacity:0.6;max-width:36em;';
  box.append(title, detail, hint);
  app.appendChild(box);
}

function renderIdle(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  const seedParam = new URLSearchParams(location.search).get('seed');
  app.innerHTML = `
    <div id="idle">
      <h1>firewrks</h1>
      <label>Seed <input id="seed" type="text" value="${seedParam ?? Date.now()}" /></label>
      <button id="start" type="button">Start</button>
    </div>
  `;

  const startBtn = app.querySelector<HTMLButtonElement>('#start')!;
  const seedInput = app.querySelector<HTMLInputElement>('#seed')!;

  startBtn.addEventListener('click', async () => {
    const result = await probeWebGPU();
    if (result.ok === false) {
      renderDiagnostic(result.reason);
      return;
    }
    const { seed, rateMultiplier } = parseSeedInput(seedInput.value);
    void startShow(seed, rateMultiplier);
  });
}

async function runDebug(seed: number): Promise<void> {
  const result = await probeWebGPU();
  if (result.ok === false) {
    renderDiagnostic(result.reason);
    return;
  }
  await runDebugSim(seed);
}

async function runAutostart(seed: number, rateMultiplier: number, stream: boolean): Promise<void> {
  // Kiosk/TV entry (Android APK loads `?autostart=1`): no idle screen, no Start click. The
  // Android wrapper sets `setMediaPlaybackRequiresUserGesture(false)` so ShowAudio's context is
  // allowed to start without a gesture; on failure we still surface the diagnostic. `?stream=1`
  // additionally publishes the render over WebRTC (see startShow / webrtcPublisher.ts).
  const result = await probeWebGPU();
  if (result.ok === false) {
    renderDiagnostic(result.reason);
    return;
  }
  void startShow(seed, rateMultiplier, stream);
}

const params = new URLSearchParams(location.search);
const debugMode = params.get('debug');
if (debugMode === 'sim') {
  const seedParam = params.get('seed');
  void runDebug(seedParam !== null ? Number(seedParam) : Date.now());
} else if (params.has('autostart') || params.has('stream')) {
  const { seed, rateMultiplier } = parseSeedInput(params.get('seed') ?? String(Date.now()));
  void runAutostart(seed, rateMultiplier, params.has('stream'));
} else {
  renderIdle();
}
