# Android TV cast receiver

A minimal, framework-only Android app (`android/`) that acts as a **display-only WebRTC receiver**
for the show. It renders nothing itself — it connects to a render host (see
[webrtc-cast.md](webrtc-cast.md)) and plays the incoming video track in a fullscreen `WebView`.
This is what lets an Android TV whose System WebView predates WebGPU still show the fireworks.

## What it does

- On launch it **auto-discovers** the render host via mDNS/DNS-SD (`_firewrks._tcp`) and connects
  with no typing. If nothing is found, enter the host's `ip:port` manually and press **Connect**
  (persisted across runs).
- Loads `http://<host>/tv`, the receiver page, and plays the remote track fullscreen with sound.
- **BACK** returns to the host screen to reconnect or change host.
- Declares both a normal launcher entry and a TV **leanback** launcher entry (with a banner), so it
  appears on phones/tablets and on the Android TV home row.

No hardcoded host. Discovery uses the host advertised by `npm run cast` (see `advertiseMdns` in
`server/stream.mjs`); manual entry is always available as a fallback.

### Intent overrides (dev/automation)

- `-e host <ip:port>` — skip the entry screen and connect to that host.
- `-e url <full-url>` — load an explicit URL (also used for the adb-reverse fallback).

```sh
adb shell am start -n com.firewrks.tv/.MainActivity -e host 192.168.1.50:8765
```

## How it works

`MainActivity` is pure Android framework (no AndroidX), so it hand-builds cleanly (below):

- A `WebView` with JavaScript, DOM storage, and `setMediaPlaybackRequiresUserGesture(false)` (so
  the received media autoplays with sound in a kiosk with no user gesture).
- A `WebViewClient.shouldInterceptRequest` that serves the *optional* bundled WebGPU show from the
  APK's assets over a synthetic `https://appassets.local` origin (a secure context, and same-origin
  so ES modules load without CORS). Remote cast URLs pass straight through to the network.
- Manifest declares `INTERNET` + `ACCESS_NETWORK_STATE` and `usesCleartextTraffic="true"` (the
  receiver is plain `http` on the LAN).
- The remote **OK / D-pad center** button fires an interactive shell in the locally-rendered path.

## Building the APK

No Gradle required — `android/build-apk.sh` hand-builds with the Android SDK command-line tools:

```sh
npm run build          # produce dist/ (bundled into the APK's assets)
npm run apk            # -> firewrks.apk (signed, installable)
```

Requirements (paths auto-detected, override with `ANDROID_SDK_ROOT`):

- A JDK (JDK 8+ works; the script uses build-tools **30.0.2** `d8`, which runs on JDK 8).
- Android SDK **platform 30** (`android.jar`) and **build-tools** (aapt2/apksigner/zipalign).
- A debug keystore is generated on first run if absent.

The build: `aapt2 compile/link` (manifest + resources + `dist/` as assets) → `javac` → `d8` →
add `classes.dex` → `zipalign` → `apksigner sign`. Output: `firewrks.apk` (~270 KB + the web
bundle).

> Note: `MainActivity.java` avoids Java lambdas on purpose — the JDK-8 `d8` can't desugar
> `invokedynamic`. Use anonymous classes.

## Installing

```sh
adb connect <device-ip>:5555        # if using wireless debugging
adb install -r firewrks.apk
```

Then open **firewrks** from the launcher (or the Android TV home row), enter the render host's
`ip:port`, and Connect. Prebuilt APKs are attached to GitHub releases.

## Requirements on the device

- Any Android with a **WebRTC-capable System WebView** (WebRTC video playback long predates
  WebGPU, so old WebViews are fine as *receivers*).
- A hardware video decoder for the negotiated codec (VP9 by default — see
  [webrtc-cast.md](webrtc-cast.md) for retargeting).
- On the same LAN as the render host (or reachable via the adb-reverse fallback).
