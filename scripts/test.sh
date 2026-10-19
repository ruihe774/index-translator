#!/bin/sh
# usage: scripts/test.sh [--quick] [audio files...]
# Builds native libopus (once; rerun test/build-native.sh after changing it) and all wasm
# builds, then runs the differential test test/compare.ts.
set -e
cd "$(dirname "$0")/.."
[ -f target/native/libopus-scalar.so ] && [ -f target/native/libopus-rtcd.so ] || test/build-native.sh
scripts/build.sh all both
exec deno run --allow-read --allow-ffi --allow-run test/compare.ts "$@"
