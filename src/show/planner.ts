// Show planner (spec §4.3): an endless generator of scheduled launches driven by a low-frequency
// macro intensity envelope (sparse lulls vs. dense sequences), cake shot-run expansion, escalation
// waves, and finale bursts. Pure/deterministic given the seeded RNG — no wall-clock, no Math.random.

import type { RNG } from './rng';
import { pick, range } from './rng';
import type { BreakFamily, CatalogEntry } from './catalog';
import { LULL_MAX_GAP_S, MAX_GAP_S, MIN_GAP_S, STAGE } from './constants';

export interface PlannerEvent {
  t: number; // seconds since show start
  entryId: string;
  phaseIdx: number;
  x: number; // meters, launch position along the stage width, centered at 0
  finale: boolean; // true only for finale-window events, which alone may claim the pool's reserve
}

const TAU = Math.PI * 2;
const LULL_ENVELOPE_THRESHOLD = 0.45;

interface Shot {
  entry: CatalogEntry;
  phaseIdx: number;
  family: BreakFamily;
}

/** Every `{entry, phaseIdx}` pair whose phase is a primary break — the vocabulary the planner
 * draws individual shots and cake shots from. */
function collectShots(entries: readonly CatalogEntry[]): Shot[] {
  const shots: Shot[] = [];
  for (const entry of entries) {
    entry.phases.forEach((phase, phaseIdx) => {
      if (phase.kind === 'break' && phase.breakFamily) {
        shots.push({ entry, phaseIdx, family: phase.breakFamily });
      }
    });
  }
  return shots;
}

/** Picks a shot whose family differs from `lastFamily` when a non-repeating choice exists (spec
 * §4.3: "no immediate family repetition"). */
function pickShot(rng: RNG, shots: readonly Shot[], lastFamily: BreakFamily | undefined): Shot {
  const candidates = lastFamily ? shots.filter((s) => s.family !== lastFamily) : shots;
  return pick(rng, candidates.length > 0 ? candidates : shots);
}

/**
 * Endless generator of scheduled launch events. `entries` is the full validated catalog; `rng`
 * drives every stochastic decision (macro envelope phase/frequency, gap sizing, shot/x selection,
 * escalation/finale timing) so a fixed seed reproduces an identical schedule.
 */
export function* planShow(entries: readonly CatalogEntry[], rng: RNG): Generator<PlannerEvent, never, void> {
  const shots = collectShots(entries);
  if (shots.length === 0) throw new Error('planShow: no catalog entry has a break phase');

  let t = 0;
  let lastFamily: BreakFamily | undefined;

  // Macro intensity envelope = sum of two slow sinusoids of the seed (spec §4.3: "the show
  // breathes"), normalized to [0, 1]; env < 0.35 is a designated lull.
  const freq1 = 1 / range(rng, [45, 90]);
  const phase1 = rng() * TAU;
  const freq2 = 1 / range(rng, [18, 36]);
  const phase2 = rng() * TAU;
  const envelope = (time: number): number => {
    const s = Math.sin(TAU * freq1 * time + phase1) + Math.sin(TAU * freq2 * time + phase2);
    return (s + 2) / 4;
  };

  let nextEscalationAt = range(rng, [120, 240]); // roughly every 2-4 min
  let nextFinaleAt = range(rng, [600, 1200]);

  const launchX = (): number => range(rng, [-STAGE.w / 2, STAGE.w / 2]);

  while (true) {
    if (t >= nextFinaleAt) {
      // Finale: rolling volleys, all flagged so the caller may claim the pool reserve. NOT one
      // continuous machine-gun run (live visual feedback: 10+ shells airborne at once reads as
      // an undifferentiated mess) — small 3-4 shell volleys with a breath between them keeps the
      // finale clearly denser than ambient while every break stays individually readable.
      const volleyCount = Math.round(range(rng, [3, 5]));
      for (let v = 0; v < volleyCount; v++) {
        const volleySize = Math.round(range(rng, [3, 4]));
        for (let i = 0; i < volleySize; i++) {
          const shot = pickShot(rng, shots, lastFamily);
          lastFamily = shot.family;
          yield { t, entryId: shot.entry.id, phaseIdx: shot.phaseIdx, x: launchX(), finale: true };
          t += range(rng, [0.3, 0.7]);
        }
        if (v < volleyCount - 1) t += range(rng, [2.5, 4.5]); // breath between volleys
      }
      nextFinaleAt = t + range(rng, [900, 1800]);
      continue;
    }

    if (t >= nextEscalationAt) {
      // Escalation wave: a tighter-paced cluster, still ambient (never claims the reserve).
      // Capped small for the same readability reason as the finale volleys above.
      const waveCount = Math.round(range(rng, [3, 5]));
      for (let i = 0; i < waveCount; i++) {
        const shot = pickShot(rng, shots, lastFamily);
        lastFamily = shot.family;
        yield { t, entryId: shot.entry.id, phaseIdx: shot.phaseIdx, x: launchX(), finale: false };
        t += range(rng, [1.2, 2.5]);
      }
      nextEscalationAt = t + range(rng, [120, 240]);
      continue;
    }

    const shot = pickShot(rng, shots, lastFamily);

    if (shot.entry.deviceType === 'cake') {
      // Cakes expand to shotCount events across durationSeconds (spec §4.2/§4.3), cycling through
      // the entry's own break phases so alternation (e.g. golden-pyro-fusion) is preserved.
      const breakPhases = shot.entry.phases
        .map((phase, phaseIdx) => ({ phase, phaseIdx }))
        .filter(({ phase }) => phase.breakFamily !== undefined);
      const duration = shot.entry.durationSeconds ?? shot.entry.shotCount * 0.5;
      const spacing = duration / shot.entry.shotCount;

      for (let i = 0; i < shot.entry.shotCount; i++) {
        const { phaseIdx, phase } = breakPhases[i % breakPhases.length];
        lastFamily = phase.breakFamily;
        yield { t, entryId: shot.entry.id, phaseIdx, x: launchX(), finale: false };
        // Ragged intra-cake spacing; skip after the last shot so this doesn't stack with the
        // shared post-event gap below (which already accounts for the pause after this cake run).
        if (i < shot.entry.shotCount - 1) t += Math.max(0.05, spacing * (0.7 + rng() * 0.6));
      }
    } else {
      lastFamily = shot.family;
      yield { t, entryId: shot.entry.id, phaseIdx: shot.phaseIdx, x: launchX(), finale: false };
      // Occasional doublet/triplet (real shows fire 2-3 shells nearly together now and then —
      // variety without sustained density; the ambient gap below still follows the whole group).
      if (rng() < 0.18) {
        const extra = rng() < 0.3 ? 2 : 1;
        for (let i = 0; i < extra; i++) {
          t += range(rng, [0.4, 1.1]);
          const mate = pickShot(rng, shots, lastFamily);
          lastFamily = mate.family;
          yield { t, entryId: mate.entry.id, phaseIdx: mate.phaseIdx, x: launchX(), finale: false };
        }
      }
    }

    // Ambient gap: individual shells build one at a time with visible breathing room between
    // them (spec's original 0.6s floor let launches fire faster than a shell's own visual
    // decay, reading as simultaneous mass-launch rather than a compounding show — see
    // constants.ts's MAX_GAP_S/LULL_MAX_GAP_S comment).
    const lull = envelope(t) < LULL_ENVELOPE_THRESHOLD;
    const gap = lull ? range(rng, [MAX_GAP_S, LULL_MAX_GAP_S]) : range(rng, [MIN_GAP_S, MAX_GAP_S]);
    t += gap;
  }
}
