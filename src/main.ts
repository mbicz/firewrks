import { probeWebGPU } from './platform/probe';
import { runDebugSim } from './gpu/sim';

function startShow(seed: number): void {
  // Stub: Phase 7 wires the real show loop (planner -> compiler -> allocator -> GPU).
  console.log('startShow seed:', seed);
}

function renderDiagnostic(reason: string): void {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  app.innerHTML = '';
  const pre = document.createElement('pre');
  pre.textContent = `WebGPU unavailable: ${reason}`;
  app.appendChild(pre);
}

function renderIdle(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  app.innerHTML = `
    <div id="idle">
      <h1>firewrks</h1>
      <label>Seed <input id="seed" type="number" value="${Date.now()}" /></label>
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
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    startShow(Number(seedInput.value));
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

const params = new URLSearchParams(location.search);
const debugMode = params.get('debug');
if (debugMode === 'sim') {
  const seedParam = params.get('seed');
  void runDebug(seedParam !== null ? Number(seedParam) : Date.now());
} else {
  renderIdle();
}
