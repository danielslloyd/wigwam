#!/usr/bin/env bash
# Builds android/build/Wigwam.apk using only the Android SDK and a JDK (no Gradle, no Android Studio).
#
#   bash android/build.sh                               # app for https://danielslloyd.github.io/wigwam/
#   bash android/build.sh http://localhost:8080/        # test build (pair with: adb reverse tcp:8080 tcp:8080)
#   bash android/build.sh https://you.github.io/repo/ --install   # build and install on a USB-connected device
set -euo pipefail

SITE="https://danielslloyd.github.io/wigwam/"
INSTALL=0
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    http*) SITE="$a" ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
[[ "$SITE" == */ ]] || SITE="$SITE/"

win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
here=$(win "$(cd "$(dirname "$0")" && pwd)")
SDK=$(win "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$LOCALAPPDATA/Android/Sdk}}")
BT=$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)
JAR="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)/android.jar"
if [[ -z "${JAVA_HOME:-}" ]]; then JAVA_HOME=$( (ls -d "/c/Program Files/Microsoft/jdk-"* "/c/Program Files/Java/jdk"* 2>/dev/null || true) | sort -V | tail -1); fi
export JAVA_HOME; export PATH="$JAVA_HOME/bin:$PATH"
EXE=""; [[ -f "$BT/aapt2.exe" ]] && EXE=".exe"
BAT=""; [[ -f "$BT/d8.bat" ]] && BAT=".bat"

out="$here/build"
rm -rf "$out"; mkdir -p "$out/res/mipmap-xxxhdpi" "$out/gen/io/github/danielslloyd/wigwam" "$out/classes" "$out/dex"
echo "Building Wigwam for $SITE"

# Resources and manifest (plain http is only allowed for a test build)
cp -r "$here/res/." "$out/res/"   # adaptive icon (Android 8+)
cp "$here/../icons/icon-192.png" "$out/res/mipmap-xxxhdpi/ic_launcher.png"   # older Androids
cleartext=false; [[ "$SITE" == http://* ]] && cleartext=true
sed "s/usesCleartextTraffic=\"false\"/usesCleartextTraffic=\"$cleartext\"/" "$here/AndroidManifest.xml" > "$out/AndroidManifest.xml"
"$BT/aapt2$EXE" compile -o "$out/res.zip" --dir "$out/res"
"$BT/aapt2$EXE" link -o "$out/unsigned.apk" -I "$JAR" --manifest "$out/AndroidManifest.xml" \
  --min-sdk-version 24 --target-sdk-version 34 "$out/res.zip"

# Code
cat > "$out/gen/io/github/danielslloyd/wigwam/BuildConfig.java" <<EOF
package io.github.danielslloyd.wigwam;
final class BuildConfig { static final String SITE = "$SITE"; }
EOF
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$JAR" -classpath "$BT/core-lambda-stubs.jar" -encoding UTF-8 -d "$out/classes" \
  $(find "$here/src" "$out/gen" -name '*.java')
"$BT/d8$BAT" --release --min-api 24 --lib "$JAR" --output "$out/dex" $(find "$out/classes" -name '*.class')
(cd "$out/dex" && "$BT/aapt$EXE" add -k "$out/unsigned.apk" classes.dex >/dev/null)

# Align and sign with the standard Android debug key (created if missing)
KS="$(win "$HOME")/.android/debug.keystore"
if [[ ! -f "$KS" ]]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias androiddebugkey \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" >/dev/null
fi
"$BT/zipalign$EXE" -f 4 "$out/unsigned.apk" "$out/aligned.apk"
"$BT/apksigner$BAT" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey \
  --out "$out/Wigwam.apk" "$out/aligned.apk"
echo "Built $out/Wigwam.apk"

if [[ $INSTALL == 1 ]]; then
  ADB="$SDK/platform-tools/adb$EXE"
  "$ADB" install -r "$out/Wigwam.apk"
  "$ADB" shell am start -n io.github.danielslloyd.wigwam/.MainActivity
fi
