import { describe, expect, it } from 'vitest';
import type { CatalogEntry, CatalogPhase } from '../src/show/catalog';
import { compile, sampleBreakDirections } from '../src/show/compiler';
import { mulberry32 } from '../src/show/rng';
import { WILLOW_MIN_HANG } from '../src/show/constants';

function makeEntry(overrides: Partial<CatalogEntry> & { phases: CatalogPhase[] }): CatalogEntry {
  return {
    id: 'test-entry',
    productName: 'Test Entry',
    sourceUrl: '',
    sourcePublisher: '',
    sourceKind: 'generated',
    accessedOn: '',
    verbatimText: '',
    normalizationStatus: 'inferred',
    deviceType: 'shell',
    shotCount: 1,
    caliberHint: 'medium',
    ...overrides,
  };
}

const peonyEntry = makeEntry({
  id: 'peony-test',
  phases: [
    { kind: 'ascent', colors: ['#ffffff'], effectTags: [] },
    { kind: 'break', breakFamily: 'peony', colors: ['#ff3344'], effectTags: [] },
  ],
});

const chrysanthemumEntry = makeEntry({
  id: 'chrysanthemum-test',
  phases: [
    { kind: 'ascent', colors: ['#ffffff'], effectTags: [] },
    { kind: 'break', breakFamily: 'chrysanthemum', colors: ['#33ccff'], effectTags: [] },
  ],
});

const willowEntry = makeEntry({
  id: 'willow-test',
  phases: [
    { kind: 'ascent', colors: ['#ffd700'], effectTags: [] },
    { kind: 'break', breakFamily: 'willow', colors: ['#ffd700'], effectTags: [] },
  ],
});

const horsetailEntry = makeEntry({
  id: 'horsetail-test',
  phases: [
    { kind: 'ascent', colors: ['#ff8800'], effectTags: [] },
    { kind: 'break', breakFamily: 'horsetail', colors: ['#ff8800'], effectTags: [] },
  ],
});

const crossetteEntry = makeEntry({
  id: 'crossette-test',
  phases: [
    { kind: 'ascent', colors: ['#ffd700'], effectTags: [] },
    { kind: 'break', breakFamily: 'peony', colors: ['#ffd700'], effectTags: [] },
    { kind: 'secondary', breakFamily: 'crossette', colors: ['#ffd700'], effectTags: [] },
  ],
});

describe('compile: crossette secondary', () => {
  it('yields exactly 4 secondary tails per primary star', () => {
    const rng = mulberry32(1);
    const recipe = compile(crossetteEntry, 1, rng);
    expect(recipe.secondary).toBeDefined();
    expect(recipe.secondary?.kind).toBe('crossette');
    expect(recipe.secondary?.count).toBe(4);
  });
});

describe('compile: willow vs horsetail lifetime', () => {
  it('willow mean star lifetime exceeds horsetail mean, and every willow star hangs >= WILLOW_MIN_HANG', () => {
    const mean = (arr: Float32Array) => Array.from(arr).reduce((a, b) => a + b, 0) / arr.length;

    const willowRecipe = compile(willowEntry, 1, mulberry32(7));
    const horsetailRecipe = compile(horsetailEntry, 1, mulberry32(7));

    expect(mean(willowRecipe.lifetimes)).toBeGreaterThan(mean(horsetailRecipe.lifetimes));
    for (const life of willowRecipe.lifetimes) {
      expect(life).toBeGreaterThanOrEqual(WILLOW_MIN_HANG);
    }
  });
});

describe('compile: trail emission by family', () => {
  it('peony has zero trail emission; chrysanthemum has non-zero trail emission', () => {
    const peonyRecipe = compile(peonyEntry, 1, mulberry32(3));
    const chrysanthemumRecipe = compile(chrysanthemumEntry, 1, mulberry32(3));

    expect(peonyRecipe.trailEmissionRate).toBe(0);
    expect(chrysanthemumRecipe.trailEmissionRate).toBeGreaterThan(0);
  });
});

describe('compile: break-direction asymmetry', () => {
  it('deviates from the ideal topology (non-perfect sphere) with bounded asymmetry', () => {
    const rng = mulberry32(11);
    const starCount = 400;
    const { ideal, final, deform } = sampleBreakDirections('peony', starCount, rng);

    let maxDeviationDeg = 0;
    let anyDeviationAtLeast2Deg = false;
    for (let i = 0; i < starCount; i++) {
      const dot =
        ideal[i * 3] * final[i * 3] + ideal[i * 3 + 1] * final[i * 3 + 1] + ideal[i * 3 + 2] * final[i * 3 + 2];
      const deviationDeg = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
      maxDeviationDeg = Math.max(maxDeviationDeg, deviationDeg);
      if (deviationDeg >= 2) anyDeviationAtLeast2Deg = true;
    }

    // Not a perfect sphere: at least one star deviates by at least the angular-noise floor (2 deg).
    expect(anyDeviationAtLeast2Deg).toBe(true);
    // But bounded: the per-star noise (<=6 deg) plus the shell-wide squash/tilt deformation
    // (squash 0.85-1.0, tilt <=10 deg) never blows a direction wildly off its ideal topology.
    expect(maxDeviationDeg).toBeGreaterThanOrEqual(2);
    expect(maxDeviationDeg).toBeLessThan(45);
    expect(deform.squashY).toBeGreaterThanOrEqual(0.85);
    expect(deform.squashY).toBeLessThanOrEqual(1.0);
    expect(Math.abs(deform.tiltDeg)).toBeLessThanOrEqual(10);
  });

  it('is not a uniform sphere: the final direction set is measurably non-uniform (chi-square-style bucket check)', () => {
    const rng = mulberry32(21);
    const starCount = 2000;
    const { final } = sampleBreakDirections('peony', starCount, rng);

    // Archimedes' hat-box theorem: projecting a UNIFORM sphere sample onto any axis gives a
    // uniform distribution on [-1, 1]. Bucket the y-components and compare against that uniform
    // expectation; the squash+tilt deformation should skew at least one bucket noticeably.
    const bucketCount = 10;
    const buckets = new Array(bucketCount).fill(0);
    for (let i = 0; i < starCount; i++) {
      const y = final[i * 3 + 1];
      const bucket = Math.min(bucketCount - 1, Math.floor(((y + 1) / 2) * bucketCount));
      buckets[bucket]++;
    }
    const expected = starCount / bucketCount;
    const chiSquare = buckets.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);

    // 9 degrees of freedom; a true uniform sample essentially never exceeds ~30 by chance at this
    // sample size, so any deformed (non-uniform) distribution clears this bar comfortably.
    expect(chiSquare).toBeGreaterThan(16.92); // chi-square critical value, df=9, p=0.05
  });
});

describe('compile: determinism', () => {
  it('the same seed produces a deep-equal recipe', () => {
    const recipeA = compile(chrysanthemumEntry, 1, mulberry32(42));
    const recipeB = compile(chrysanthemumEntry, 1, mulberry32(42));

    expect(recipeA).toEqual(recipeB);
  });

  it('different seeds produce different star directions', () => {
    const recipeA = compile(chrysanthemumEntry, 1, mulberry32(1));
    const recipeB = compile(chrysanthemumEntry, 1, mulberry32(2));

    expect(recipeA.starDirections).not.toEqual(recipeB.starDirections);
  });
});

describe('compile: dud probability flag', () => {
  it('flags.dudProbability is set to the spec-fixed 0.02', () => {
    const recipe = compile(peonyEntry, 1, mulberry32(5));
    expect(recipe.flags.dudProbability).toBe(0.02);
  });
});
