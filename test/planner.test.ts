import { describe, expect, it } from 'vitest';
import type { BreakFamily, CatalogEntry } from '../src/show/catalog';
import { compile } from '../src/show/compiler';
import { planShow, type PlannerEvent } from '../src/show/planner';
import { Allocator } from '../src/show/allocator';
import { mulberry32 } from '../src/show/rng';
import { FINALE_RESERVE, LULL_MAX_GAP_S, POOL_CAPACITY } from '../src/show/constants';

const entries: CatalogEntry[] = [
  {
    id: 'peony-shell',
    productName: 'Peony Shell',
    sourceUrl: '',
    sourcePublisher: '',
    sourceKind: 'generated',
    accessedOn: '',
    verbatimText: '',
    normalizationStatus: 'inferred',
    deviceType: 'shell',
    shotCount: 1,
    caliberHint: 'medium',
    phases: [
      { kind: 'ascent', colors: ['#ffffff'], effectTags: [] },
      { kind: 'break', breakFamily: 'peony', colors: ['#ff3344'], effectTags: [] },
    ],
  },
  {
    id: 'chrysanthemum-shell',
    productName: 'Chrysanthemum Shell',
    sourceUrl: '',
    sourcePublisher: '',
    sourceKind: 'generated',
    accessedOn: '',
    verbatimText: '',
    normalizationStatus: 'inferred',
    deviceType: 'shell',
    shotCount: 1,
    caliberHint: 'small',
    phases: [
      { kind: 'ascent', colors: ['#ffffff'], effectTags: [] },
      { kind: 'break', breakFamily: 'chrysanthemum', colors: ['#33ccff'], effectTags: [] },
    ],
  },
  {
    id: 'willow-shell',
    productName: 'Willow Shell',
    sourceUrl: '',
    sourcePublisher: '',
    sourceKind: 'generated',
    accessedOn: '',
    verbatimText: '',
    normalizationStatus: 'inferred',
    deviceType: 'shell',
    shotCount: 1,
    caliberHint: 'large',
    phases: [
      { kind: 'ascent', colors: ['#ffd700'], effectTags: [] },
      { kind: 'break', breakFamily: 'willow', colors: ['#ffd700'], effectTags: [] },
    ],
  },
  {
    id: 'palm-cake',
    productName: 'Palm Cake',
    sourceUrl: '',
    sourcePublisher: '',
    sourceKind: 'generated',
    accessedOn: '',
    verbatimText: '',
    normalizationStatus: 'inferred',
    deviceType: 'cake',
    shotCount: 20,
    durationSeconds: 10,
    caliberHint: 'small',
    phases: [
      { kind: 'ascent', colors: ['#ffffff'], effectTags: [] },
      { kind: 'break', breakFamily: 'palm', colors: ['#ff8800'], effectTags: [] },
    ],
  },
  {
    id: 'alternating-cake',
    productName: 'Alternating Cake',
    sourceUrl: '',
    sourcePublisher: '',
    sourceKind: 'generated',
    accessedOn: '',
    verbatimText: '',
    normalizationStatus: 'inferred',
    deviceType: 'cake',
    shotCount: 18,
    caliberHint: 'small',
    phases: [
      { kind: 'ascent', colors: ['#ffd700'], effectTags: [] },
      { kind: 'break', breakFamily: 'crackling_flower', colors: ['#ffd700'], effectTags: ['crackle'] },
      { kind: 'secondary', breakFamily: 'crossette', colors: ['#ffd700'], effectTags: ['crackle'] },
    ],
  },
  {
    id: 'horsetail-shell',
    productName: 'Horsetail Shell',
    sourceUrl: '',
    sourcePublisher: '',
    sourceKind: 'generated',
    accessedOn: '',
    verbatimText: '',
    normalizationStatus: 'inferred',
    deviceType: 'shell',
    shotCount: 1,
    caliberHint: 'medium',
    phases: [
      { kind: 'ascent', colors: ['#ff8800'], effectTags: [] },
      { kind: 'break', breakFamily: 'horsetail', colors: ['#ff8800'], effectTags: [] },
    ],
  },
];

const entryById = new Map(entries.map((e) => [e.id, e]));

function familyOf(event: PlannerEvent): BreakFamily {
  const entry = entryById.get(event.entryId);
  if (!entry) throw new Error(`unknown entryId ${event.entryId}`);
  const family = entry.phases[event.phaseIdx]?.breakFamily;
  if (!family) throw new Error(`phase ${event.phaseIdx} of ${event.entryId} has no breakFamily`);
  return family;
}

function takeUntil(generator: Generator<PlannerEvent, never, void>, endTime: number): PlannerEvent[] {
  const out: PlannerEvent[] = [];
  for (const event of generator) {
    if (event.t > endTime) break;
    out.push(event);
  }
  return out;
}

describe('planShow: determinism', () => {
  it('the same seed produces a deep-equal schedule', () => {
    const eventsA = takeUntil(planShow(entries, mulberry32(42)), 600);
    const eventsB = takeUntil(planShow(entries, mulberry32(42)), 600);

    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsA).toEqual(eventsB);
  });
});

describe('planShow: family repetition', () => {
  it('never picks the same breakFamily for two consecutive top-level launches', () => {
    // A single multi-shot cake run legitimately repeats its own family across its shots (that's
    // the device, e.g. a 721-shot single-family crackling-flower barrage) — the "no immediate
    // repetition" invariant is about consecutive independent scheduling decisions, so collapse
    // consecutive same-entryId events (one cake run) to their first shot before comparing.
    const scheduled = takeUntil(planShow(entries, mulberry32(9)), 1800);
    const topLevel = scheduled.filter((event, i) => i === 0 || event.entryId !== scheduled[i - 1].entryId);
    for (let i = 1; i < topLevel.length; i++) {
      expect(familyOf(topLevel[i])).not.toBe(familyOf(topLevel[i - 1]));
    }
  });
});

describe('planShow: gap and intensity-envelope invariants over a simulated hour', () => {
  const scheduled = takeUntil(planShow(entries, mulberry32(123)), 3600);

  it('schedules a non-trivial number of events across the hour', () => {
    expect(scheduled.length).toBeGreaterThan(50);
  });

  it('never leaves a gap wider than LULL_MAX_GAP_S, even across designated lulls', () => {
    for (let i = 1; i < scheduled.length; i++) {
      const gap = scheduled[i].t - scheduled[i - 1].t;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(LULL_MAX_GAP_S + 1e-9);
    }
  });

  it('breathes: some gaps sit in the lull band above MAX_GAP_S, not a constant cadence', () => {
    const gaps = scheduled.slice(1).map((event, i) => event.t - scheduled[i].t);
    const hasLullGap = gaps.some((g) => g > 2.5);
    const hasDenseGap = gaps.some((g) => g <= 2.5);
    expect(hasLullGap).toBe(true);
    expect(hasDenseGap).toBe(true);
  });

  it('keeps concurrent live-star count within the pool capacity', () => {
    const compileRng = mulberry32(999);
    type Boundary = { time: number; delta: number };
    const boundaries: Boundary[] = [];
    for (const event of scheduled) {
      const entry = entryById.get(event.entryId);
      if (!entry) continue;
      const recipe = compile(entry, event.phaseIdx, compileRng);
      const maxLifetime = recipe.lifetimes.reduce((a, b) => Math.max(a, b), 0);
      boundaries.push({ time: event.t, delta: recipe.starCount });
      boundaries.push({ time: event.t + maxLifetime, delta: -recipe.starCount });
    }
    boundaries.sort((a, b) => a.time - b.time);

    let concurrent = 0;
    let peak = 0;
    for (const b of boundaries) {
      concurrent += b.delta;
      peak = Math.max(peak, concurrent);
    }
    expect(peak).toBeLessThanOrEqual(POOL_CAPACITY);
  });

  it('never lets an ambient (non-finale) event claim a slot inside the finale reserve', () => {
    const allocator = new Allocator(10_000); // small pool makes reserve contention exercised
    const compileRng = mulberry32(555);
    const ambientLimit = Math.floor(10_000 * (1 - FINALE_RESERVE));

    for (const event of scheduled.slice(0, 400)) {
      const entry = entryById.get(event.entryId);
      if (!entry) continue;
      const recipe = compile(entry, event.phaseIdx, compileRng);
      const starCount = Math.min(recipe.starCount, ambientLimit); // keep individual asks satisfiable
      const maxLifetime = recipe.lifetimes.reduce((a, b) => Math.max(a, b), 0);
      const reserved = allocator.reserve(0, starCount, event.t, maxLifetime, event.finale);
      if (!reserved) continue; // defer is a valid outcome; just never an out-of-window grant
      if (!event.finale) {
        expect(reserved.start + reserved.count).toBeLessThanOrEqual(ambientLimit);
      }
    }
  });
});

describe('planShow: cake expansion', () => {
  it('expands a cake entry into shotCount events cycling its break phases', () => {
    const cakeOnly = [entries.find((e) => e.id === 'alternating-cake')!];
    const scheduled = takeUntil(planShow(cakeOnly, mulberry32(3)), 30);
    const fromThisCake = scheduled.filter((e) => e.entryId === 'alternating-cake');

    expect(fromThisCake.length).toBeGreaterThanOrEqual(18);
    const phaseIdxsUsed = new Set(fromThisCake.map((e) => e.phaseIdx));
    expect(phaseIdxsUsed.has(1)).toBe(true); // crackling_flower break phase
    expect(phaseIdxsUsed.has(2)).toBe(true); // crossette secondary phase
  });
});
