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
    timeout 30 adb logcat -d 2>/dev/null | grep -iE "chromium|feuillet|AndroidRuntime|FATAL" | grep -v Cronet | tail -60 > /tmp/logcat.txt || true
    sleep 1
    printf '::error title=smoke (code %s)::%s\n' "$code" "$(tail -70 "$LOG" | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g')"
    printf '::error title=logcat::%s\n' "$(sed 's/%/%25/g' /tmp/logcat.txt | sed ':a;N;$!ba;s/\n/%0A/g')"
  fi
}
trap report EXIT
trap 'echo "Délai global du test dépassé"; exit 124' TERM
step() { echo "== [$(date +%H:%M:%S)] $*"; }
A() { timeout 60 adb "$@"; }
DEBUG_APK=$(ls apk/*-debug.apk | head -1)
RELEASE_APK=$(ls apk/*.apk | grep -v -- -debug | head -1)
PKG=app.feuillet.scanner.debug

forward() {
  local pid=""
  for _ in $(seq 1 60); do
    pid=$(A shell pidof "$PKG" | tr -d '\r' || true)
    [ -n "$pid" ] && A shell cat /proc/net/unix > /tmp/unix.txt && grep -q "webview_devtools_remote_$pid" /tmp/unix.txt && break
    sleep 1
  done
  [ -n "$pid" ] || { echo "Application non démarrée"; A logcat -d | grep -iE "AndroidRuntime|feuillet" | tail -50; exit 1; }
  A forward --remove-all || true
  A forward tcp:9222 "localabstract:webview_devtools_remote_$pid"
}

step "Appareil"
timeout 300 adb wait-for-device
A shell getprop ro.build.version.release
step "Installation de $DEBUG_APK (permissions accordées)"
timeout 300 adb install -r -g "$DEBUG_APK"
A shell am start -W -n "$PKG/app.feuillet.scanner.MainActivity"
forward
step "Parcours principal"
timeout 600 node android/scripts/smoke.mjs first

step "Export PDF présent dans Téléchargements/Feuillet ?"
A shell ls -l /sdcard/Download/Feuillet/
A shell ls /sdcard/Download/Feuillet/ | grep -q '\.pdf' || { echo "PDF exporté introuvable"; exit 1; }

step "Redémarrage complet : persistance"
A shell am force-stop "$PKG"
sleep 2
A shell am start -W -n "$PKG/app.feuillet.scanner.MainActivity"
forward
timeout 300 node android/scripts/smoke.mjs persist

step "APK de publication : installation et démarrage"
timeout 300 adb install -r "$RELEASE_APK"
A logcat -c
A shell am start -W -n "app.feuillet.scanner/app.feuillet.scanner.MainActivity"
sleep 8
A shell pidof app.feuillet.scanner >/dev/null || { echo "L’APK de publication ne démarre pas"; A logcat -d | grep -iE "AndroidRuntime|FATAL" | tail -40; exit 1; }
if A logcat -d | grep -q "FATAL EXCEPTION"; then A logcat -d | grep -A20 "FATAL EXCEPTION"; exit 1; fi
echo "Tests Android réussis."
printf '::notice title=Test émulateur Android::%s\n' "$(grep -E '^(✓|==|  largeur|Connecté)' "$LOG" | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g')"
