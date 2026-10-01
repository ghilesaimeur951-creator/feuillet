#!/usr/bin/env bash
# Emulator smoke test of the APKs built by the CI (see .github/workflows/android.yml).
set -euo pipefail
cd "$(dirname "$0")/../.."
LOG=/tmp/smoke.log
exec > >(tee "$LOG") 2>&1
# On failure, the end of the log and of logcat become annotations (readable through the API).
report() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    adb logcat -d 2>/dev/null | grep -iE "chromium|feuillet|AndroidRuntime|FATAL|cr_" | tail -60 > /tmp/logcat.txt || true
    sleep 1
    printf '::error title=smoke (code %s)::%s\n' "$code" "$(tail -70 "$LOG" | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g')"
    printf '::error title=logcat::%s\n' "$(sed 's/%/%25/g' /tmp/logcat.txt | sed ':a;N;$!ba;s/\n/%0A/g')"
  fi
}
trap report EXIT
DEBUG_APK=$(ls apk/*-debug.apk | head -1)
RELEASE_APK=$(ls apk/*.apk | grep -v -- -debug | head -1)
PKG=app.feuillet.scanner.debug

forward() {
  local pid=""
  for _ in $(seq 1 60); do
    pid=$(adb shell pidof "$PKG" | tr -d '\r' || true)
    [ -n "$pid" ] && adb shell cat /proc/net/unix | grep -q "webview_devtools_remote_$pid" && break
    sleep 1
  done
  [ -n "$pid" ] || { echo "Application non démarrée"; adb logcat -d | grep -iE "AndroidRuntime|feuillet" | tail -50; exit 1; }
  adb forward --remove-all || true
  adb forward tcp:9222 "localabstract:webview_devtools_remote_$pid"
}

adb wait-for-device
adb shell settings put global window_animation_scale 0 || true
echo "== Installation de $DEBUG_APK (permissions accordées)"
adb install -r -g "$DEBUG_APK"
adb shell am start -W -n "$PKG/app.feuillet.scanner.MainActivity"
forward
node android/scripts/smoke.mjs first

echo "== Export PDF présent dans Téléchargements/Feuillet ?"
adb shell ls -l /sdcard/Download/Feuillet/
adb shell ls /sdcard/Download/Feuillet/ | grep -q '\.pdf' || { echo "PDF exporté introuvable"; exit 1; }

echo "== Redémarrage complet : persistance"
adb shell am force-stop "$PKG"
sleep 2
adb shell am start -W -n "$PKG/app.feuillet.scanner.MainActivity"
forward
node android/scripts/smoke.mjs persist

echo "== APK de publication : installation et démarrage"
adb install -r "$RELEASE_APK"
adb logcat -c
adb shell am start -W -n "app.feuillet.scanner/app.feuillet.scanner.MainActivity"
sleep 8
adb shell pidof app.feuillet.scanner >/dev/null || { echo "L’APK de publication ne démarre pas"; adb logcat -d | grep -iE "AndroidRuntime|FATAL" | tail -40; exit 1; }
if adb logcat -d | grep -q "FATAL EXCEPTION"; then adb logcat -d | grep -A20 "FATAL EXCEPTION"; exit 1; fi
echo "Tests Android réussis."
printf '::notice title=Test émulateur Android::%s\n' "$(grep -E '^(✓|==|  largeur)' "$LOG" | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g')"
