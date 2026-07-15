// Procedural WebAudio sound effects (spec has no audio section; added from live feedback). No
// audio assets — every sound is synthesized. Realism anchors:
//   - Speed-of-sound travel delay: the camera sits ~400-550m from pad/break positions, so sound
//     arrives 1.2-1.6s AFTER the flash — the signature fireworks-at-a-distance experience.
//   - Noise-dominated explosions: a real shell report is a broadband impulse (sharp noise crack
//     collapsing into a low rumble), NOT a pitched tone. First iteration used sine-heavy booms
//     and read as synth bloops (live feedback: "super fake") — v2 layers a downward-sweeping
//     lowpassed noise impact, a small sub-sine support underneath, a slow rumble tail, and a
//     sparse high-frequency crackle tail for big shells.
//   - Open-air echo: a ConvolverNode with a synthesized exponentially-decaying stereo noise
//     impulse response — distant explosions are heard mostly as their environmental reflection,
//     which is what separates "outdoor boom" from "drum machine kick".
//   - Stereo pan from the event's stage x; loudness/brightness fall off with distance.
//
// All synthesis randomness draws from a DEDICATED seeded RNG passed by the caller — never the
// planner/compiler streams, whose draw sequences are a frozen reproducibility contract.
//
// This module is import-safe under Node (vitest): the Web Audio API is only touched inside the
// ShowAudio constructor, and the pure scheduling helpers below are exported for direct testing.

import { CAMERA, STAGE } from '../show/constants';
import type { RNG } from '../show/rng';

const SPEED_OF_SOUND_M_S = 343;
const MASTER_GAIN = 0.4;
const REVERB_SEND = 0.45;
const REVERB_SECONDS = 2.8;
// Camera world position per buildShowCamera (render.ts): (0, CAMERA.elev + 80, CAMERA.dist).
const LISTENER_POS = [0, CAMERA.elev + 80, CAMERA.dist] as const;
// starCount at which a break reaches full loudness (largest catalog shells reach ~900).
const FULL_LOUDNESS_STARS = 500;
const CRACKLE_MIN_STARS = 220; // only medium+ breaks carry an audible crackle tail

/** Seconds for sound to travel `distanceM` meters at sea level. */
export function travelDelayS(distanceM: number): number {
  return distanceM / SPEED_OF_SOUND_M_S;
}

/** Stereo pan [-0.8, 0.8] from a stage x position (meters, centered at 0). */
export function panForX(x: number): number {
  const pan = (x / (STAGE.w / 2)) * 0.7;
  return pan < -0.8 ? -0.8 : pan > 0.8 ? 0.8 : pan;
}

/** Perceptual loudness scale [0.25, 1] from a break's star count (sqrt: energy, not amplitude). */
export function gainForStarCount(starCount: number): number {
  const g = Math.sqrt(starCount / FULL_LOUDNESS_STARS);
  return g < 0.25 ? 0.25 : g > 1 ? 1 : g;
}

/** Distance from the fixed listener (camera) to a world position. */
export function distanceToListener(x: number, y: number, z: number): number {
  const dx = x - LISTENER_POS[0];
  const dy = y - LISTENER_POS[1];
  const dz = z - LISTENER_POS[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * One WebAudio graph per show: dry + convolver-reverb buses -> master gain -> compressor ->
 * destination. Construct only inside a user-gesture call stack (the Start button handler) so
 * the context starts un-suspended.
 */
export class ShowAudio {
  private readonly ctx: AudioContext;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly noiseBuf: AudioBuffer;
  private readonly rng: RNG;
  private readonly captureDest: MediaStreamAudioDestinationNode;

  constructor(rng: RNG, outputLocal = true) {
    this.rng = rng;
    this.ctx = new AudioContext();
    // Autoplay policy: even gesture-created contexts can begin 'suspended' in some embeddings.
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 6;
    // Local speakers — skipped in WebRTC cast mode (`outputLocal=false`): the audio must come out
    // of the TV via the captured track, NOT the rendering machine's speakers.
    if (outputLocal) compressor.connect(this.ctx.destination);
    // Capture tap: the post-compressor mix feeds a MediaStream so the WebRTC publisher can send
    // the show's audio to the remote display (see webrtcPublisher.ts / server/stream.mjs).
    this.captureDest = this.ctx.createMediaStreamDestination();
    compressor.connect(this.captureDest);

    const master = this.ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(compressor);

    this.dry = this.ctx.createGain();
    this.dry.connect(master);

    // Open-air echo: exponentially-decaying stereo noise IR. Decorrelated channels give the
    // reflection field its width; the exponent shapes a hall-free outdoor-ish tail.
    const irLen = Math.floor(REVERB_SECONDS * this.ctx.sampleRate);
    const ir = this.ctx.createBuffer(2, irLen, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        data[i] = (rng() * 2 - 1) * Math.exp((-3.5 * i) / irLen);
      }
    }
    const convolver = this.ctx.createConvolver();
    convolver.buffer = ir;
    this.wet = this.ctx.createGain();
    this.wet.gain.value = REVERB_SEND;
    this.wet.connect(convolver);
    convolver.connect(master);

    // 2s shared white-noise buffer; every noise voice plays a random offset slice of it.
    const len = 2 * this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = rng() * 2 - 1;
  }

  /** Launch report: dull percussive mortar thud + faint rising whoosh, travel-delayed. */
  launch(x: number): void {
    const when = this.ctx.currentTime + travelDelayS(distanceToListener(x, 0, 0));
    const pan = this.makePan(panForX(x));
    const detune = 1 + (this.rng() - 0.5) * 0.2;

    // Thud: a short lowpassed noise pop (percussive body)...
    const pop = this.noiseVoice(when, 0.25);
    const popLp = this.ctx.createBiquadFilter();
    popLp.type = 'lowpass';
    popLp.frequency.setValueAtTime(650 * detune, when);
    popLp.frequency.exponentialRampToValueAtTime(120, when + 0.18);
    const popGain = this.envelope(0.16, when, 0.004, 0.22);
    pop.connect(popLp).connect(popGain).connect(pan);
    // ...over a small sub knock, well underneath the noise so no pitch reads through.
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(70 * detune, when);
    sub.frequency.exponentialRampToValueAtTime(38, when + 0.12);
    const subGain = this.envelope(0.1, when, 0.008, 0.2);
    sub.connect(subGain).connect(pan);
    sub.start(when);
    sub.stop(when + 0.4);

    // Whoosh: quiet bandpassed noise rising with the shell — barely-there at 400m.
    const whoosh = this.noiseVoice(when + 0.1, 0.8);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(400 * detune, when + 0.1);
    bp.frequency.exponentialRampToValueAtTime(900 * detune, when + 0.8);
    const whooshGain = this.envelope(0.018, when + 0.1, 0.15, 0.6);
    whoosh.connect(bp).connect(whooshGain).connect(pan);
  }

  /**
   * Break report for a burst at world position (x, y, z) whose FLASH happens `flashInS` seconds
   * from now (0 = this instant): broadband crack -> rumble tail (+ crackle for big shells),
   * scheduled at flash time + travel delay, attenuated and muffled by distance.
   */
  breakAt(x: number, y: number, z: number, starCount: number, flashInS: number): void {
    const dist = distanceToListener(x, y, z);
    const when = this.ctx.currentTime + flashInS + travelDelayS(dist);
    const pan = this.makePan(panForX(x));
    const big = gainForStarCount(starCount); // 0.25 small .. 1 large
    const loud = big * (400 / Math.max(dist, 100)) ** 0.7;
    // Air absorption: farther bursts arrive darker, not just quieter.
    const brightness = 400 / Math.max(dist, 200);
    const detune = 1 + (this.rng() - 0.5) * 0.3;

    // 1. Impact crack: broadband noise, lowpass slamming shut — the report itself.
    const crack = this.noiseVoice(when, 0.5);
    const crackLp = this.ctx.createBiquadFilter();
    crackLp.type = 'lowpass';
    crackLp.frequency.setValueAtTime((900 + 900 * big) * brightness * detune, when);
    crackLp.frequency.exponentialRampToValueAtTime(110, when + 0.4);
    const crackGain = this.envelope(0.9 * loud, when, 0.003, 0.35 + 0.3 * big);
    crack.connect(crackLp).connect(crackGain).connect(pan);

    // 2. Sub support: low sine well below the noise — felt more than heard.
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(50 * detune, when);
    sub.frequency.exponentialRampToValueAtTime(26, when + 0.9);
    const subGain = this.envelope(0.4 * loud, when, 0.01, 0.8 + big * 0.8);
    sub.connect(subGain).connect(pan);
    sub.start(when);
    sub.stop(when + 2.2);

    // 3. Rumble tail: slow-swelling deep noise — the boom rolling across open ground.
    const rumble = this.noiseVoice(when + 0.06, 1.2 + big * 1.6);
    const rumbleLp = this.ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 150;
    const rumbleGain = this.envelope(0.4 * loud, when + 0.06, 0.18, 1.1 + big * 1.6);
    rumble.connect(rumbleLp).connect(rumbleGain).connect(pan);

    // 4. Crackle tail for medium+ shells: sparse high ticks scattered over the seconds the
    // stars burn — unmistakably pyrotechnic, impossible to mistake for a synth hit.
    if (starCount >= CRACKLE_MIN_STARS) {
      const ticks = 14 + Math.floor(this.rng() * 18);
      for (let i = 0; i < ticks; i++) {
        const tickWhen = when + 0.15 + this.rng() * (1.1 + big * 1.2);
        const tick = this.noiseVoice(tickWhen, 0.03);
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 2.5;
        bp.frequency.value = 2200 + this.rng() * 2600;
        const tickGain = this.envelope(0.05 * loud * (0.4 + this.rng()), tickWhen, 0.002, 0.03);
        tick.connect(bp).connect(tickGain).connect(pan);
      }
    }
  }

  dispose(): void {
    void this.ctx.close();
  }

  /** Audio track carrying the full post-compressor mix, for the WebRTC publisher. */
  get audioTrack(): MediaStreamTrack {
    return this.captureDest.stream.getAudioTracks()[0];
  }

  /** Stereo panner feeding BOTH the dry bus and the reverb send. */
  private makePan(value: number): StereoPannerNode {
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = value;
    pan.connect(this.dry);
    pan.connect(this.wet);
    return pan;
  }

  /** Gain node with an attack->exponential-decay envelope starting at `when`. */
  private envelope(peak: number, when: number, attackS: number, decayS: number): GainNode {
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attackS);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attackS + decayS);
    return gain;
  }

  /** Starts a one-shot noise source at `when` for `durationS`, from a random buffer offset. */
  private noiseVoice(when: number, durationS: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = this.noiseBuf.duration;
    const offset = this.rng() * (this.noiseBuf.duration - 0.1);
    src.start(when, offset, durationS + 0.1);
    return src;
  }
}
