import { describe, expect, it } from 'vitest';
import { AtmosphereRef } from '../src/show/atmosphereRef';
import { mulberry32, range } from '../src/show/rng';
import { SMOKE_DECAY_S } from '../src/show/constants';

describe('AtmosphereRef: exponential decay', () => {
  it('recovers the configured tau within 5% from the mass decay curve', () => {
    const tau = 90; // mid-range of SMOKE_DECAY_S
    const field = new AtmosphereRef({ tau, diffusion: 0 }); // diffusion=0 isolates pure decay
    field.inject([0, 175, 0], 1000); // stage center

    const dt = 1; // coarse ticks are fine — decay math doesn't depend on step granularity
    for (let i = 0; i < 30; i++) field.step(dt, [0, 0, 0]);
    const mass1 = field.totalMass();
    const t1 = 30 * dt;

    for (let i = 0; i < 60; i++) field.step(dt, [0, 0, 0]);
    const mass2 = field.totalMass();
    const t2 = 90 * dt;

    const recoveredTau = -(t2 - t1) / Math.log(mass2 / mass1);
    expect(Math.abs(recoveredTau - tau) / tau).toBeLessThan(0.05);
  });
});

describe('AtmosphereRef: injection', () => {
  it('raises local density at the injection point', () => {
    const field = new AtmosphereRef({ tau: 120 });
    const point: [number, number, number] = [50, 120, -20];
    const before = field.sample(point);
    field.inject(point, 500);
    const after = field.sample(point);
    expect(after).toBeGreaterThan(before);
  });

  it('never lowers density (splat is purely additive)', () => {
    const field = new AtmosphereRef({ tau: 120 });
    field.inject([0, 100, 0], 300);
    const before = field.sample([0, 100, 0]);
    field.inject([200, 300, 90], 50); // unrelated far-away splat
    const after = field.sample([0, 100, 0]);
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('AtmosphereRef: advection', () => {
  it('moves the density centroid downwind', () => {
    const field = new AtmosphereRef({ tau: 150 });
    field.inject([0, 150, 0], 1000);
    const wind: [number, number, number] = [8, 0, 0]; // steady +x wind
    const before = field.centroid();
    expect(before).not.toBeNull();

    for (let i = 0; i < 40; i++) field.step(0.5, wind);
    const after = field.centroid();
    expect(after).not.toBeNull();

    // Centroid must have moved measurably in the wind direction (+x), not merely diffused
    // symmetrically in place.
    expect(after![0]).toBeGreaterThan(before![0] + 1);
  });

  it('does not drift when wind is zero (diffusion alone stays symmetric)', () => {
    const field = new AtmosphereRef({ tau: 150 });
    field.inject([0, 150, 0], 1000);
    for (let i = 0; i < 20; i++) field.step(0.5, [0, 0, 0]);
    const centroid = field.centroid()!;
    expect(Math.abs(centroid[0])).toBeLessThan(1);
    expect(Math.abs(centroid[2])).toBeLessThan(1);
  });
});

describe('AtmosphereRef: stability over a simulated hour', () => {
  it('never goes negative or NaN under an hour of randomized injection + advection', () => {
    // Smaller grid + coarser tick than the show's real SMOKE_GRID/60Hz cadence keeps this test
    // fast (~15M cell-updates instead of ~14B) without changing the update rule under test — the
    // no-negative/no-NaN invariant is a per-cell arithmetic property independent of resolution.
    const rng = mulberry32(2026);
    const tau = range(rng, SMOKE_DECAY_S);
    const field = new AtmosphereRef({ tau, dims: [32, 16, 16] });

    const simHourSeconds = 3600;
    const dt = 2;
    const steps = simHourSeconds / dt;
    let nextInjectAt = 0;

    for (let t = 0; t < steps; t++) {
      const simTime = t * dt;
      if (simTime >= nextInjectAt) {
        const pos: [number, number, number] = [
          range(rng, [-300, 300]),
          range(rng, [90, 300]),
          range(rng, [-100, 100]),
        ];
        field.inject(pos, range(rng, [50, 2000]));
        nextInjectAt = simTime + range(rng, [1, 3]);
      }
      const wind: [number, number, number] = [range(rng, [-4, 4]), range(rng, [-0.5, 0.5]), range(rng, [-4, 4])];
      field.step(dt, wind);
    }

    expect(field.hasNegativeOrNaN()).toBe(false);
    expect(field.totalMass()).toBeGreaterThan(0); // show still has some hanging smoke, sanity check
  });
});
