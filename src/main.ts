import { probeWebGPU } from './platform/probe';

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
    if (!result.ok) {
      renderDiagnostic(result.reason);
      return;
    }
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    startShow(Number(seedInput.value));
  });
}

renderIdle();
