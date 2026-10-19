#!/bin/sh
# usage: scripts/build-native.sh
# Builds upstream libopus (the third_party/opus submodule, v1.6.1) natively in two
# configurations, both with -ffp-contract=off:
#   scalar  intrinsics disabled (plain C reference)
#   rtcd    upstream defaults otherwise (x86: SSE/AVX2 with runtime CPU detection)
# and links them with each crate's test wrappers into shared libraries for its test/compare.ts:
#   target/native/minisilk-{scalar,rtcd}.so  minisilk/test/shim.c + libopus
#   target/native/minicelt-{scalar,rtcd}.so  minicelt/test/{shim,analysis_stub}.c + libopus without
#                                            src/analysis.c (tonality analysis off, as in minicelt)
# The wasm builds of the fork's C (target/native/minicelt-cwasm{2,3}.wasm) come from
# minicelt/test/build-cwasm.sh, which scripts/test.sh runs when they are missing.
# OPUS_SRC overrides the source directory.
set -e
cd "$(dirname "$0")/.."
OPUS_SRC=$(realpath "${OPUS_SRC:-third_party/opus}")
[ -f "$OPUS_SRC/CMakeLists.txt" ] || { echo "$OPUS_SRC is empty: run git submodule update --init" >&2; exit 1; }
out=$PWD/target/native
rm -rf "$out"/build-* "$out"/*.so && mkdir -p "$out"  # keeps the cwasm references (minicelt/test/build-cwasm.sh)
build() { # $1 = name, $2.. = extra cmake args
  name=$1; shift
  cmake -S "$OPUS_SRC" -B "$out/build-$name" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_C_FLAGS="-ffp-contract=off" "$@" >/dev/null
  cmake --build "$out/build-$name" >/dev/null
  lib=$out/build-$name/libopus.a
  cc -O2 -shared -fPIC -I"$OPUS_SRC/include" minisilk/test/shim.c "$lib" -lm -o "$out/minisilk-$name.so"
  ls -l "$out/minisilk-$name.so"
  if [ -f minicelt/test/shim.c ]; then
    cp "$lib" "$out/build-$name/libopus-noanalysis.a"
    ar d "$out/build-$name/libopus-noanalysis.a" analysis.c.o
    cc -O2 -shared -fPIC -I"$OPUS_SRC/include" -I"$OPUS_SRC/celt" -I"$OPUS_SRC/src" \
      minicelt/test/shim.c minicelt/test/analysis_stub.c "$out/build-$name/libopus-noanalysis.a" -lm \
      -o "$out/minicelt-$name.so"
    ls -l "$out/minicelt-$name.so"
  fi
}
build scalar -DOPUS_DISABLE_INTRINSICS=ON
build rtcd
