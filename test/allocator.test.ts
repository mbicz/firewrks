import { describe, expect, it } from 'vitest';
import { Allocator, reserveChildRange, type SlotRange } from '../src/show/allocator';
import { FINALE_RESERVE } from '../src/show/constants';
import { mulberry32, range } from '../src/show/rng';

function rangesOverlap(a: SlotRange, b: SlotRange): boolean {
  return a.start < b.start + b.count && b.start < a.start + a.count;
}

describe('Allocator.reserve: no overlap', () => {
  it('never grants two live ranges that overlap, across a simulated hour of churn', () => {
    const allocator = new Allocator(50_000);
    const rng = mulberry32(17);
    let now = 0;
    let grantCount = 0;

    for (let i = 0; i < 5000; i++) {
      now += range(rng, [0.2, 2.5]);
      const count = Math.round(range(rng, [10, 400]));
      const maxLifetime = range(rng, [1, 12]);
      const finale = rng() < 0.05;
      const result = allocator.reserve(i % 4, count, now, maxLifetime, finale);
      if (result) grantCount++;

      // Re-verify the allocator's own live set after every call: no two currently-live ranges
      // may occupy overlapping slot indices, regardless of how churned recycling has been.
      const live = allocator.liveRanges;
      for (let a = 0; a < live.length; a++) {
        for (let b = a + 1; b < live.length; b++) {
          expect(rangesOverlap(live[a], live[b])).toBe(false);
        }
      }

      if (now > 3600) break;
    }

    expect(grantCount).toBeGreaterThan(0);
  });

  it('returns null (defers) rather than overwrite when the pool is saturated', () => {
    const allocator = new Allocator(1000); // ambient window = floor(1000 * 0.7) = 700
    const first = allocator.reserve(0, 600, 0, 100, false); // long-lived, fills most of the ambient window
    expect(first).not.toBeNull();

    const second = allocator.reserve(0, 200, 1, 100, false); // 600+200 > 700: no room left before it frees
    expect(second).toBeNull();
  });
});

describe('Allocator.reserve: recycling respects worst-case lifetime + jitter', () => {
  it('does not recycle a range before its jitter-inflated freeAt', () => {
    const allocator = new Allocator(1000);
    const maxLifetime = 4; // seconds, pre-jitter
    const trailLag = 1;
    const reserved = allocator.reserve(0, 500, 0, maxLifetime, false, trailLag);
    expect(reserved).not.toBeNull();
    const expectedFreeAt = 0 + maxLifetime * 1.35 + trailLag; // spec §4.5: +35% jitter margin + trail lag
    expect(reserved!.freeAt).toBeCloseTo(expectedFreeAt, 10);

    // Just before freeAt: slot is still live, so an overlapping request must be refused.
    const tooEarly = allocator.reserve(0, 500, expectedFreeAt - 0.01, 1, false);
    expect(tooEarly).toBeNull();

    // At/after freeAt: recycled, so the same-sized request now succeeds.
    const afterFree = allocator.reserve(0, 500, expectedFreeAt + 0.01, 1, false);
    expect(afterFree).not.toBeNull();
  });
});

describe('Allocator.reserve: finale reserve', () => {
  it('never lets an ambient (finale: false) request land inside the top FINALE_RESERVE fraction', () => {
    const capacity = 1000;
    const allocator = new Allocator(capacity);
    const ambientLimit = Math.floor(capacity * (1 - FINALE_RESERVE));

    // Drain the ambient window entirely with small ambient reservations.
    let now = 0;
    for (let i = 0; i < 200; i++) {
      const reserved = allocator.reserve(0, 10, now, 0.01, false); // tiny lifetime, frees almost immediately
      if (reserved) {
        expect(reserved.start + reserved.count).toBeLessThanOrEqual(ambientLimit);
      }
      now += 0.02;
    }
  });

  it('lets a finale request use the reserved top fraction of the pool', () => {
    const capacity = 1000;
    const allocator = new Allocator(capacity);
    const ambientLimit = Math.floor(capacity * (1 - FINALE_RESERVE));
    const reserveSize = capacity - ambientLimit;

    // Fill the ambient window so the only room left is the reserve.
    const filler = allocator.reserve(0, ambientLimit, 0, 100, false);
    expect(filler).not.toBeNull();

    const ambientAttempt = allocator.reserve(0, reserveSize, 0, 1, false);
    expect(ambientAttempt).toBeNull(); // ambient cannot touch the reserve

    const finaleAttempt = allocator.reserve(0, reserveSize, 0, 1, true);
    expect(finaleAttempt).not.toBeNull();
    expect(finaleAttempt!.start).toBeGreaterThanOrEqual(ambientLimit);
  });
});

describe('reserveChildRange: parent-index-aware child slots', () => {
  it('maps each child slot back to its parent star index, in parent order', () => {
    const allocator = new Allocator(1000);
    const parentRange = allocator.reserve(0, 5, 0, 4, false);
    expect(parentRange).not.toBeNull();

    const childrenPerParent = 3;
    const result = reserveChildRange(allocator, parentRange!, 1, childrenPerParent, 0, 2);
    expect(result).not.toBeNull();
    const { range: childRange, parentIndices } = result!;

    expect(childRange.count).toBe(parentRange!.count * childrenPerParent);
    expect(parentIndices.length).toBe(childRange.count);
    for (let p = 0; p < parentRange!.count; p++) {
      for (let c = 0; c < childrenPerParent; c++) {
        expect(parentIndices[p * childrenPerParent + c]).toBe(parentRange!.start + p);
      }
    }

    // Child range must not collide with the still-live parent range.
    expect(rangesOverlap(parentRange!, childRange)).toBe(false);
  });

  it('propagates a null reservation (defer) without throwing when the pool has no room', () => {
    const allocator = new Allocator(10);
    const parentRange = allocator.reserve(0, 5, 0, 1, false);
    expect(parentRange).not.toBeNull();

    const result = reserveChildRange(allocator, parentRange!, 1, 10, 0, 1); // needs 50 slots, only 10 exist
    expect(result).toBeNull();
  });
});
