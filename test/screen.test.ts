import { describe, expect, it } from 'vitest';
import { fit } from '../src/platform/screen';

describe('fit', () => {
  it('clamps a 5K@2x backing size to the 3840x2160 cap, preserving aspect', () => {
    expect(fit(5120, 2880, 2)).toEqual({ w: 3840, h: 2160 });
  });

  it('leaves a 1080p@1x backing size unchanged (under the cap)', () => {
    expect(fit(1920, 1080, 1)).toEqual({ w: 1920, h: 1080 });
  });
});
