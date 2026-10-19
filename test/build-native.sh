#!/bin/sh
# usage: test/build-native.sh
# Builds upstream libopus (the third_party/opus submodule, v1.6.1) natively in two
# configurations and links each with test/shim.c into a shared library for test/compare.ts:
#   target/native/libopus-scalar.so  intrinsics disabled, -ffp-contract=off (plain C reference)
#   target/native/libopus-rtcd.so    upstream defaults (x86: SSE/AVX2 with runtime CPU detection)
# OPUS_SRC overrides the source directory.
set -e
cd "$(dirname "$0")/.."
OPUS_SRC=$(realpath "${OPUS_SRC:-third_party/opus}")
[ -f "$OPUS_SRC/CMakeLists.txt" ] || { echo "$OPUS_SRC is empty: run git submodule update --init" >&2; exit 1; }
out=$PWD/target/native
rm -rf "$out" && mkdir -p "$out"
build() { # $1 = name, $2 = C flags, $3.. = extra cmake args
  name=$1 cflags=$2; shift 2
  cmake -S "$OPUS_SRC" -B "$out/build-$name" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_C_FLAGS="$cflags" "$@" >/dev/null
  cmake --build "$out/build-$name" >/dev/null
  cc -O2 -shared -fPIC -I"$OPUS_SRC/include" test/shim.c "$out/build-$name/libopus.a" -lm \
    -o "$out/libopus-$name.so"
  ls -l "$out/libopus-$name.so"
}
build scalar "-ffp-contract=off" -DOPUS_DISABLE_INTRINSICS=ON
build rtcd ""
