// `?debug=sim` readback/visual harness (plan Phase 4 step 4, upgraded by Phase 5 to drive the
// production `ShowRenderer` instead of `sim.ts`'s Phase-4 debug point material). Lives in its
// own module — not `sim.ts` — specifically to avoid a `sim.ts` <-> `render.ts` import cycle:
// `render.ts` imports helpers FROM `sim.ts`, and this harness imports the `ShowRenderer` class
// FROM `render.ts`, so it must sit outside both.
//
// `?debug=sim&seed=N[&timeScale=X][&shell=blue][&stopAtFrame=N]`:
//   - default: launches one test peony + one test crossette, as Phase 4 established.
//   - `shell=blue`: launches ONE pure #2244ff test peony only — the tonemap-decision fixture
//     (plan Phase 5 step 4; see the block comment atop `render.ts`) and the blue-hue-fidelity
//     half of this phase's DoD.
//   - `stopAtFrame=N`: flips `document.title` to `'FRAME_READY'` after N rendered frames, for
//     `tools/golden.mjs`'s puppeteer capture (plan step 7).

import * as THREE from 'three/webgpu';

import type { BreakFamily, CatalogEntry } from '../show/catalog';
import type { GpuRecipe } from '../show/compiler';
import { mulberry32 } from '../show/rng';
import { DT, ParticleSim, type ParticleState } from './sim';
import { ShowRenderer, buildShowCamera } from './render';

function debugCatalogEntry(id: string, family: BreakFamily, caliberHint: GpuRecipe['caliber'], color: string): CatalogEntry {
  return {
    id,
    productName: `Debug ${family}`,
    sourceUrl: '',
    sourcePublisher: '',
    sourceKind: 'generated',
    accessedOn: '2026-07-11',
    verbatimText: 'Synthetic fixture for Phase 4/5 sim + render debug verification (not a catalog product).',
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

// Ground/horizon burst-light stub scheduling (see the `setBurstLight`/Phase-6-stub comment on
// `ShowRenderer`): this harness knows launch position + approximate apex height/fuse time from
// the debug entries' own caliber constants (NOT the compiled recipe — the recipe is compiled
// again, with fresh RNG draws, inside `sim.launch()` itself, so peeking at it here would desync
// the two calls' RNG consumption). "Approximate" is intentional and documented — Phase 6 owns
// the real per-break light bookkeeping driven by actual GPU break state.
const DEBUG_BREAK_DELAY_S = 2.5; // mid-range of CALIBER_TABLE.small.rise [2,3]
const DEBUG_BREAK_HEIGHT = 110; // mid-range of CALIBER_TABLE.small.apex [90,140]
const DEBUG_BURST_LIGHT_LIFE_S = 1.5; // spec §4.7: "every break for 1.5 s with intensity decay"

export async function runDebugSim(seed: number, timeScaleOverride?: number): Promise<void> {
  const params = new URLSearchParams(location.search);
  const timeScale = timeScaleOverride ?? Number(params.get('timeScale') ?? '1');
  const blueShellOnly = params.get('shell') === 'blue';
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
  const sim = new ParticleSim(renderer, DEBUG_POOL_CAPACITY);
  const show = new ShowRenderer(renderer, camera, sim);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  const rng = mulberry32(seed);
  const peonyEntry = blueShellOnly
    ? debugCatalogEntry('debug-blue-shell', 'peony', 'medium', '#2244ff')
    : debugCatalogEntry('debug-peony', 'peony', 'small', '#ff6a1a');
  const crossetteEntry = debugCatalogEntry('debug-crossette', 'crossette', 'small', '#3fb2ff');

  let simTime = 0;
  let tickCount = 0;
  let frameCount = 0;
  let peonyLaunched = false;
  let crossetteLaunched = false;
  let peonyBurstSet = false;
  let crossetteBurstSet = false;
  let peonyBurstCleared = false;
  let crossetteBurstCleared = false;

  function stepOnce(): void {
    if (!peonyLaunched) {
      sim.launch(peonyEntry, 0, rng, simTime, -60, 0);
      peonyLaunched = true;
      console.log('[debug:sim] peony launched at simTime=0');
    }
    if (!blueShellOnly && !crossetteLaunched) {
      sim.launch(crossetteEntry, 0, rng, simTime, 60, 0);
      crossetteLaunched = true;
      console.log('[debug:sim] crossette launched at simTime=0');
    }

    // Break-flash-adjacent stub burst lights (see the comment above `DEBUG_BREAK_DELAY_S`).
    if (!peonyBurstSet && simTime >= DEBUG_BREAK_DELAY_S) {
      show.setBurstLight(0, new THREE.Vector3(-60, DEBUG_BREAK_HEIGHT, 0), new THREE.Color(0xff6a1a), 4000);
      peonyBurstSet = true;
    }
    if (!peonyBurstCleared && simTime >= DEBUG_BREAK_DELAY_S + DEBUG_BURST_LIGHT_LIFE_S) {
      show.clearBurstLight(0);
      peonyBurstCleared = true;
    }
    if (!blueShellOnly) {
      if (!crossetteBurstSet && simTime >= DEBUG_BREAK_DELAY_S) {
        show.setBurstLight(1, new THREE.Vector3(60, DEBUG_BREAK_HEIGHT, 0), new THREE.Color(0x3fb2ff), 4000);
        crossetteBurstSet = true;
      }
      if (!crossetteBurstCleared && simTime >= DEBUG_BREAK_DELAY_S + DEBUG_BURST_LIGHT_LIFE_S) {
        show.clearBurstLight(1);
        crossetteBurstCleared = true;
      }
    }

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
