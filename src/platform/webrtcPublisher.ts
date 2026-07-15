// WebRTC publisher: sends a captured MediaStream (the WebGPU canvas + show audio) to the TV
// receiver via the SSE/POST signaling relay in server/stream.mjs. Runs inside the show page when
// launched with `?stream=1` on a WebGPU-capable browser (the Mac). Media is peer-to-peer over the
// LAN; only SDP/ICE crosses the relay. See server/stream.mjs and server/tv.html for the two ends.

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Posts one signaling message to the other role via the relay. */
function signal(base: string, target: 'pub' | 'tv', msg: unknown): void {
  void fetch(`${base}/sig/send/${target}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  });
}


/**
 * Publishes `stream` as WebRTC role 'pub'. Idempotent per viewer: each `viewer-ready` (TV connect
 * or reload) tears down any stale peer connection and re-offers, so the TV can rejoin anytime.
 * Returns nothing; runs for the lifetime of the page.
 */
export function startPublisher(stream: MediaStream, base: string = location.origin): void {
  let pc: RTCPeerConnection | null = null;

  const makeOffer = async (): Promise<void> => {
    if (pc) pc.close();
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    // Prefer VP9: the TV hardware-decodes it (OMX.MS.VP9.Decoder) AND it's a WebRTC codec Chrome
    // encodes. The default VP8 path also HW-decodes here but corrupted — a persistent right-edge
    // stride band at 1920 wide, then full-frame green when pushed on bitrate. VP9's newer HW
    // decoder is cleaner and ~40% more efficient, so it stays artifact-free at a higher ceiling.
    // (H264/HEVC also HW-decode, but forced H264 earlier produced zero frames, and HEVC isn't a
    // WebRTC codec.)
    for (const tr of pc.getTransceivers()) {
      if (tr.sender.track?.kind !== 'video') continue;
      const caps = RTCRtpSender.getCapabilities?.('video');
      if (caps && typeof tr.setCodecPreferences === 'function') {
        const vp9 = caps.codecs.filter((c) => /vp9/i.test(c.mimeType));
        const rest = caps.codecs.filter((c) => !/vp9/i.test(c.mimeType));
        if (vp9.length) tr.setCodecPreferences([...vp9, ...rest]);
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) signal(base, 'tv', { type: 'ice', candidate: e.candidate });
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Moderate fixed ceiling. No ramp and no SDP munge — a stepped/40 Mbps ceiling desynced the
    // decoder into green garbage. VP9 at 8 Mbps holds full quality on the dark scene without
    // overrunning the HW decoder; resolution/framerate stay at negotiated defaults.
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = 8_000_000;
      try { await sender.setParameters(params); } catch { /* transient mid-negotiation reject; ignore */ }
    }
    signal(base, 'tv', { type: 'offer', sdp: offer.sdp });
  };

  const es = new EventSource(`${base}/sig/sub/pub`);
  es.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data) as { type: string; sdp?: string; candidate?: RTCIceCandidateInit };
    if (msg.type === 'viewer-ready') {
      await makeOffer();
    } else if (msg.type === 'answer' && pc && msg.sdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    } else if (msg.type === 'ice' && pc && msg.candidate) {
      try { await pc.addIceCandidate(msg.candidate); } catch { /* candidate may arrive pre-remote; ignore */ }
    }
  };
}
