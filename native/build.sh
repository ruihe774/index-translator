#!/bin/sh
# usage: native/build.sh
# Builds pristine upstream libopus natively (x86_64) in two configurations and links each
# with native/shim.c into a shared library for native/compare.ts:
#   target/native/libopus-scalar.so  intrinsics disabled, -ffp-contract=off (plain C reference)
#   target/native/libopus-rtcd.so    upstream defaults (SSE/AVX2 with runtime CPU detection)
# OPUS_SRC (default /mnt/workspace/opus) and OPUS_REV (default 22244de5, the upstream commit
# the WASM SIMD fork is based on) select the source.
set -e
cd "$(dirname "$0")/.."
OPUS_SRC=${OPUS_SRC:-/mnt/workspace/opus}
OPUS_REV=${OPUS_REV:-22244de5}
out=$PWD/target/native
rm -rf "$out/src" && mkdir -p "$out/src"
git -C "$OPUS_SRC" archive "$OPUS_REV" | tar -x -C "$out/src"
# No .git in the export: give opus_get_version_string() the commit instead of "unknown".
v="PACKAGE_VERSION=\"$(git -C "$OPUS_SRC" rev-parse --short "$OPUS_REV")\""
echo "$v" > "$out/src/package_version" && echo "$v" > "$out/src/cmake/package_version"
build() { # $1 = name, $2 = C flags, $3.. = extra cmake args
  name=$1 cflags=$2; shift 2
  cmake -S "$out/src" -B "$out/build-$name" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_C_FLAGS="$cflags" "$@" >/dev/null
  cmake --build "$out/build-$name" >/dev/null
  cc -O2 -shared -fPIC -I"$out/src/include" native/shim.c "$out/build-$name/libopus.a" -lm \
    -o "$out/libopus-$name.so"
  ls -l "$out/libopus-$name.so"
}
build scalar "-ffp-contract=off" -DOPUS_DISABLE_INTRINSICS=ON
build rtcd ""
