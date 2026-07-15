#!/usr/bin/env bash
# Gradle-free APK build for the firewrks Android TV wrapper.
#
# Uses only tools already on this machine: JDK 8 (javac/keytool), Android build-tools 30.0.2 d8
# (build-tools 35 d8 needs JDK 11+), aapt2/apksigner/zipalign, and platform android-30.
# Run from the repo root AFTER `npx vite build` has produced dist/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AND="$ROOT/android"
SDK="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
BT_D8="$SDK/build-tools/30.0.2"      # d8 must run on JDK 8 (class 52)
BT="$SDK/build-tools/35.0.0"         # aapt2 (native) — newest is fine
PLATFORM="$SDK/platforms/android-30/android.jar"
BUILD="$AND/build"
PKG_DIR="com/firewrks/tv"

command -v javac >/dev/null || { echo "javac not found"; exit 1; }
[ -f "$PLATFORM" ] || { echo "android.jar (platform 30) missing at $PLATFORM"; exit 1; }
[ -d "$ROOT/dist" ] || { echo "dist/ missing — run: npx vite build"; exit 1; }

echo "== clean =="
rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/compiled_res" "$BUILD/assets"

echo "== stage web bundle into assets =="
cp -R "$ROOT/dist/." "$BUILD/assets/"

echo "== compile resources =="
"$BT/aapt2" compile --dir "$AND/res" -o "$BUILD/compiled_res/res.zip"

echo "== link resources + manifest + assets -> base apk =="
"$BT/aapt2" link \
  -o "$BUILD/app-unaligned.apk" \
  -I "$PLATFORM" \
  --manifest "$AND/AndroidManifest.xml" \
  -A "$BUILD/assets" \
  --java "$BUILD/gen" \
  "$BUILD/compiled_res/res.zip"

echo "== javac (R.java + activity, target 8) =="
javac -source 8 -target 8 -nowarn \
  -bootclasspath "$PLATFORM" \
  -classpath "$PLATFORM" \
  -d "$BUILD/classes" \
  "$BUILD/gen/$PKG_DIR/R.java" \
  "$AND/java/$PKG_DIR/MainActivity.java"

echo "== d8 -> classes.dex =="
CLASSES=$(find "$BUILD/classes" -name '*.class')
"$BT_D8/d8" --min-api 21 --lib "$PLATFORM" --output "$BUILD" $CLASSES

echo "== add dex to apk =="
( cd "$BUILD" && zip -q app-unaligned.apk classes.dex )

echo "== zipalign =="
"$BT_D8/zipalign" -f -p 4 "$BUILD/app-unaligned.apk" "$BUILD/app-aligned.apk"

echo "== ensure debug keystore =="
KS="$AND/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=firewrks,O=firewrks,C=US" >/dev/null 2>&1
fi

echo "== sign =="
"$BT_D8/apksigner" sign \
  --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$ROOT/firewrks.apk" \
  "$BUILD/app-aligned.apk"

echo "== verify =="
"$BT_D8/apksigner" verify --print-certs "$ROOT/firewrks.apk" | head -3
echo "APK: $ROOT/firewrks.apk"
