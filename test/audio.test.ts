// Pure scheduling helpers of the procedural audio layer (src/platform/audio.ts). The WebAudio
// graph itself is browser-only; these helpers carry the physical contracts (speed-of-sound
// delay, pan/loudness clamps, listener geometry) and must hold for any event the show emits.

import { describe, expect, it } from 'vitest';

import { distanceToListener, gainForStarCount, panForX, travelDelayS } from '../src/platform/audio';
import { CAMERA, STAGE } from '../src/show/constants';

describe('audio: speed-of-sound travel delay', () => {
  it('delays one second per 343 meters', () => {
    expect(travelDelayS(343)).toBeCloseTo(1, 10);
    expect(travelDelayS(686)).toBeCloseTo(2, 10);
    expect(travelDelayS(0)).toBe(0);
  });

  it('a centered break at typical apex height reaches the listener over a second late', () => {
    // The realism anchor: flash first, boom clearly later — never simultaneous.
    const dist = distanceToListener(0, 180, 0);
    expect(travelDelayS(dist)).toBeGreaterThan(1);
  });
});

describe('audio: listener geometry', () => {
  it('is zero at the camera position and matches the camera offset from the origin', () => {
    expect(distanceToListener(0, CAMERA.elev + 80, CAMERA.dist)).toBe(0);
    expect(distanceToListener(0, 0, 0)).toBeCloseTo(Math.hypot(CAMERA.elev + 80, CAMERA.dist), 10);
  });
});

describe('audio: pan and loudness clamps', () => {
  it('pans stage edges toward but never past the +-0.8 safety clamp', () => {
    expect(panForX(0)).toBe(0);
    expect(panForX(STAGE.w / 2)).toBeCloseTo(0.7, 10);
    expect(panForX(-STAGE.w / 2)).toBeCloseTo(-0.7, 10);
    expect(panForX(STAGE.w * 10)).toBe(0.8);
    expect(panForX(-STAGE.w * 10)).toBe(-0.8);
  });

  it('scales loudness with star count inside [0.25, 1]', () => {
    expect(gainForStarCount(1)).toBe(0.25); // tiny pop never fully silent
    expect(gainForStarCount(2000)).toBe(1); // monster shell never clips past full
    const mid = gainForStarCount(250);
    expect(mid).toBeGreaterThan(0.25);
    expect(mid).toBeLessThan(1);
    expect(gainForStarCount(500)).toBe(1);
  });
});
