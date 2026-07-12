// Ring-buffer slot allocator (spec §4.5 Emission, §8): CPU-side bookkeeping for the GPU particle
// pool's per-event slot ranges. Never overwrites a live range — `reserve` returns null (defer) on
// contention instead. The frozen SlotRange shape is verbatim from the plan's Frozen Contracts.

import { FINALE_RESERVE, POOL_CAPACITY } from './constants';

export interface SlotRange {
  classId: number;
  start: number;
  count: number;
  freeAt: number;
}

/** First index >= `from` at or after which `count` contiguous slots fit inside [0, windowEnd)
 * without touching any interval in `blocked` (sorted, non-overlapping [start, end) pairs). */
function firstFitFrom(
  blocked: readonly (readonly [number, number])[],
  windowEnd: number,
  count: number,
  from: number,
): number | null {
  let candidate = from;
  for (const [bStart, bEnd] of blocked) {
    if (bEnd <= candidate || bStart >= candidate + count) continue;
    candidate = bEnd; // overlaps the needed window; push past this block
  }
  return candidate + count <= windowEnd ? candidate : null;
}

export class Allocator {
  private readonly capacity: number;
  private cursor = 0;
  private live: SlotRange[] = [];

  constructor(capacity: number = POOL_CAPACITY) {
    this.capacity = capacity;
  }

  /** Drops ranges whose `freeAt` has passed `now` — the only place recycling happens. */
  private recycle(now: number): void {
    if (this.live.length === 0) return;
    this.live = this.live.filter((r) => r.freeAt > now);
  }

  /** Live ranges currently occupying the pool (post-recycle at the last `reserve` call). */
  get liveRanges(): readonly SlotRange[] {
    return this.live;
  }

  /**
   * Reserves `count` contiguous slots for `classId`. `maxLifetime` is the pre-jitter worst-case
   * star lifetime (seconds) for this event's recipe; `freeAt` rounds up by the spec's §5.2 +35%
   * jitter margin plus `trailLag` (callers pass 1s for trail-emitting classes, spec §4.5). Ambient
   * (non-finale) callers may only land in [0, capacity*(1-FINALE_RESERVE)) — the top
   * FINALE_RESERVE fraction is reservable only with `finale: true`. Returns null (never a
   * corrupting overwrite) when no contiguous window is free; callers must treat null as "defer".
   */
  reserve(
    classId: number,
    count: number,
    now: number,
    maxLifetime: number,
    finale = false,
    trailLag = 0,
  ): SlotRange | null {
    if (count <= 0) throw new Error('Allocator.reserve: count must be positive');
    this.recycle(now);

    const windowEnd = finale ? this.capacity : Math.floor(this.capacity * (1 - FINALE_RESERVE));
    if (count > windowEnd) return null;

    const blocked = this.live.map((r) => [r.start, r.start + r.count] as const).sort((a, b) => a[0] - b[0]);

    const cursorStart = Math.min(this.cursor, windowEnd);
    let start = firstFitFrom(blocked, windowEnd, count, cursorStart);
    if (start === null && cursorStart !== 0) {
      start = firstFitFrom(blocked, windowEnd, count, 0);
    }
    if (start === null) return null;

    const range: SlotRange = { classId, start, count, freeAt: now + maxLifetime * 1.35 + trailLag };
    this.live.push(range);
    this.cursor = start + count;
    return range;
  }
}

/**
 * Reserves a child range (trail sparks, crossette/pistil splits, crackle micro-flashes) anchored
 * to an already-live parent star range. Child particles have no CPU-known spawn state — only the
 * parent's GPU position/velocity — so each child slot needs a parent index; this returns them
 * alongside the range (spec §4.5: "each reserved child slot stores a parent index + spawn time").
 * `childrenPerParent` children are minted per parent star, in parent-star order.
 */
export function reserveChildRange(
  allocator: Allocator,
  parentRange: SlotRange,
  classId: number,
  childrenPerParent: number,
  now: number,
  maxLifetime: number,
  trailLag = 0,
): { range: SlotRange; parentIndices: Int32Array } | null {
  if (childrenPerParent <= 0) throw new Error('reserveChildRange: childrenPerParent must be positive');
  const count = parentRange.count * childrenPerParent;
  const range = allocator.reserve(classId, count, now, maxLifetime, false, trailLag);
  if (!range) return null;

  const parentIndices = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    parentIndices[i] = parentRange.start + Math.floor(i / childrenPerParent);
  }
  return { range, parentIndices };
}
