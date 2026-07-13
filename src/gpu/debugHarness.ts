// `?debug=sim` readback/visual harness (plan Phase 4 step 4, upgraded by Phase 5 to drive the
// production `ShowRenderer` instead of `sim.ts`'s Phase-4 debug point material, and by Phase 6
// to drive a real `Atmosphere`). Lives in its own module — not `sim.ts` — specifically to avoid
// a `sim.ts` <-> `render.ts` import cycle: `render.ts` imports helpers FROM `sim.ts` (and now
// FROM `atmosphere.ts`), and this harness imports the `ShowRenderer`/`Atmosphere` classes, so it
// must sit outside both.
//
// `?debug=sim&seed=N[&timeScale=X][&shell=blue][&pair=1][&stopAtFrame=N]`:
//   - default: launches one test peony + one test crossette, as Phase 4 established.
//   - `shell=blue`: launches ONE pure #2244ff test peony only — the tonemap-decision fixture
//     (plan Phase 5 step 4; see the block comment atop `render.ts`).
//   - `pair=1`: launches two IDENTICAL peonies at the SAME (x,z), 8 simulated seconds apart —
//     the plan's Phase 6 DoD visual fixture ("two shells 8s apart at the same x: second burst
//     visibly hazier and old cloud lit from the new burst's side").
//   - `stopAtFrame=N`: flips `document.title` to `'FRAME_READY'` after N rendered frames, for
//     a future puppeteer capture script.
//
// Burst lights and smoke injection are driven by the REAL per-launch `BreakEvent` `sim.launch()`
// returns (spec §4.7's event->injection hook) — not an approximated stand-in.

import * as THREE from 'three/webgpu';

import type { BreakFamily, CatalogEntry } from '../show/catalog';
import type { GpuRecipe } from '../show/compiler';
import { mulberry32 } from '../show/rng';
import { DT, ParticleSim, type BreakEvent, type ParticleState } from './sim';
import { ShowRenderer, buildShowCamera } from './render';
import { Atmosphere } from './atmosphere';

function debugCatalogEntry(id: string, family: BreakFamily, caliberHint: GpuRecipe['caliber'], color: string): CatalogEntry {
  return {
    id,
    productName: `Debug ${family}`,
    sourceUrl: '',
    sourcePublisher: '',
    sourceKind: 'generated',
    accessedOn: '2026-07-11',
    verbatimText: 'Synthetic fixture for Phase 4/5/6 sim + render + atmosphere debug verification (not a catalog product).',
    normalizationStatus: 'inferred',
    deviceType: 'shell',
    shotCount: 1,
    caliberHint,
    phases: [{ kind: 'break', breakFamily: family, colors: [color], effectTags: [] }],
  };
}

interface FirewrksDebugHandle {
  stepTicks(n: number): number;
  renderFrame(): void;
  getSimTime(): number;
  readback(): Promise<ParticleState>;
}
declare global {
  interface Window {
    __firewrksDebug?: FirewrksDebugHandle;
  }
}

const DEBUG_POOL_CAPACITY = 4096;
const PAIR_MODE_GAP_S = 8; // plan Phase 6 DoD fixture: "two shells 8s apart at the same x"
const ASCENT_INJECT_HEIGHT_FRAC = 0.4; // rough mid-rise height for the ascent smoke puff

/** One debug launch: fires at `at` (simTime), then schedules its own atmosphere injection/
 * burst-light registration off the REAL `BreakEvent` `sim.launch()` returns. */
interface ScheduledLaunch {
  entry: CatalogEntry;
  x: number;
  z: number;
  at: number;
  launched: boolean;
  breakEvent: BreakEvent | null;
  brokenFired: boolean;
}

function scheduledLaunch(entry: CatalogEntry, x: number, z: number, at: number): ScheduledLaunch {
  return { entry, x, z, at, launched: false, breakEvent: null, brokenFired: false };
}

export async function runDebugSim(seed: number, timeScaleOverride?: number): Promise<void> {
  const params = new URLSearchParams(location.search);
  const timeScale = timeScaleOverride ?? Number(params.get('timeScale') ?? '1');
  const blueShellOnly = params.get('shell') === 'blue';
  const pairMode = params.get('pair') === '1';
  const stopAtFrame = params.get('stopAtFrame') !== null ? Number(params.get('stopAtFrame')) : null;

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const container = document.querySelector<HTMLDivElement>('#app');
  if (container) {
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
  } else {
    document.body.appendChild(renderer.domElement);
  }

  const camera = buildShowCamera(window.innerWidth / window.innerHeight);
  const rng = mulberry32(seed);
  const sim = new ParticleSim(renderer, DEBUG_POOL_CAPACITY);
  const atmosphere = new Atmosphere(renderer, rng);
  const show = new ShowRenderer(renderer, camera, sim, atmosphere);
  show.scene.add(atmosphere.smokeSprite);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  const schedule: ScheduledLaunch[] = pairMode
    ? (() => {
        const pairEntry = debugCatalogEntry('debug-pair', 'peony', 'medium', '#ff9a3c');
        return [scheduledLaunch(pairEntry, 0, 0, 0), scheduledLaunch(pairEntry, 0, 0, PAIR_MODE_GAP_S)];
      })()
    : blueShellOnly
      ? [scheduledLaunch(debugCatalogEntry('debug-blue-shell', 'peony', 'medium', '#2244ff'), -60, 0, 0)]
      : [
          scheduledLaunch(debugCatalogEntry('debug-peony', 'peony', 'small', '#ff6a1a'), -60, 0, 0),
          scheduledLaunch(debugCatalogEntry('debug-crossette', 'crossette', 'small', '#3fb2ff'), 60, 0, 0),
        ];

  let simTime = 0;
  let tickCount = 0;
  let frameCount = 0;

  function stepOnce(): void {
    for (const item of schedule) {
      if (!item.launched && simTime >= item.at) {
        item.breakEvent = sim.launch(item.entry, 0, rng, simTime, item.x, item.z);
        item.launched = true;
        console.log(`[debug:sim] launched "${item.entry.id}" at simTime=${simTime.toFixed(2)}`);
        if (item.breakEvent) {
          const ascentPos = new THREE.Vector3(item.x, item.breakEvent.position.y * ASCENT_INJECT_HEIGHT_FRAC, item.z);
          atmosphere.injectAscent(ascentPos, item.breakEvent.starCount);
        }
      }
      if (item.breakEvent && !item.brokenFired && simTime >= item.breakEvent.breakTime) {
        atmosphere.registerBreak(item.breakEvent.position, item.breakEvent.color, item.breakEvent.starCount, simTime);
        item.brokenFired = true;
        console.log(`[debug:sim] "${item.entry.id}" broke at simTime=${simTime.toFixed(2)}`);
      }
    }

    atmosphere.tick(
      simTime,
      DT,
      sim.windVector,
      (i, position, color, intensity) => show.setBurstLight(i, position, color, intensity),
      (i) => show.clearBurstLight(i),
    );

    sim.tick(simTime);
    simTime += DT;
    tickCount++;

    if (tickCount % 600 === 0) {
      const tickAtScan = tickCount;
      const simTimeAtScan = simTime;
      void sim.scanForNaN().then((bad) => {
        console.log(`[debug:sim] NaN scan @ tick ${tickAtScan} (simTime=${simTimeAtScan.toFixed(1)}s): ${bad}`);
      });
    }
  }

  function renderFrame(): void {
    show.render();
    frameCount++;
    if (stopAtFrame !== null && frameCount === stopAtFrame) {
      document.title = 'FRAME_READY';
    }
  }

  // Headless/automated verification hook: `document.hidden` suspends `requestAnimationFrame`
  // entirely in some headless embedders, so QA drives the fixed-timestep loop manually through
  // this handle instead of waiting on rAF. The rAF loop below remains the real interactive path.
  window.__firewrksDebug = {
    stepTicks(n: number): number {
      for (let i = 0; i < n; i++) stepOnce();
      show.setAlpha(1);
      renderFrame();
      return simTime;
    },
    renderFrame,
    getSimTime: () => simTime,
    readback: () => sim.readback(),
  };

  let acc = 0;
  let lastTs = performance.now();

  function frame(ts: number): void {
    const rawDt = Math.min((ts - lastTs) / 1000, 0.25);
    lastTs = ts;
    acc += rawDt * timeScale;

    while (acc >= DT) {
      stepOnce();
      acc -= DT;
    }

    show.setAlpha(acc / DT); // spec §2: interpolate the render position by the accumulator alpha
    renderFrame();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
