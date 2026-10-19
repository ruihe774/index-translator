#!/bin/sh
# usage: scripts/test.sh [silk|celt|all] [--quick] [audio files...]
# Builds native libopus (once; rerun scripts/build-native.sh after changing it or a test/*.c) and
# all wasm builds (minicelt also the wasm build of the fork's C, minicelt/test/build-cwasm.sh, once), then runs the differential test mini{silk,celt}/test/compare.ts.
set -e
cd "$(dirname "$0")/.."
c=all
case "$1" in silk|celt|all) c=$1; shift ;; esac
for crate in minisilk minicelt; do
  [ "$c" = all ] || [ "$c" = "${crate#mini}" ] || continue
  [ -f "$crate/test/compare.ts" ] || continue
  [ -f "target/native/$crate-scalar.so" ] && [ -f "target/native/$crate-rtcd.so" ] || scripts/build-native.sh
  if [ "$crate" = minicelt ]; then
    [ -f target/native/minicelt-cwasm2.wasm ] && [ -f target/native/minicelt-cwasm3.wasm ] || minicelt/test/build-cwasm.sh
  fi
  scripts/build.sh "${crate#mini}" all both
  deno run --allow-read --allow-ffi --allow-run "$crate/test/compare.ts" "$@"
done
