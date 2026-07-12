export type ProbeResult = { ok: true } | { ok: false; reason: string };

export async function probeWebGPU(): Promise<ProbeResult> {
  if (!navigator.gpu) return { ok: false, reason: 'navigator.gpu missing (WebGPU unsupported)' };
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter(); } catch (e) { return { ok: false, reason: String(e) }; }
  if (!adapter) return { ok: false, reason: 'requestAdapter() returned null' };
  try { await adapter.requestDevice(); } catch (e) { return { ok: false, reason: 'requestDevice failed: ' + e }; }
  return { ok: true };
}
