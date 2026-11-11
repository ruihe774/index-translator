#!/usr/bin/env bash
# Builds native/sat.zig into a shared library for x86-64-v3 (AVX2, FMA).
#   native/build.sh                      -> native/out/base/libsat.so with native/config.zig as it is
#   native/build.sh NAME key=value ...   -> native/out/NAME/libsat.so, config.zig with those values overridden
# ZIG overrides the compiler (default: zig-x86_64-linux-0.17.1/zig here).
set -euo pipefail
cd "$(dirname "$0")"
ZIG=${ZIG:-../zig-x86_64-linux-0.17.1/zig}
NAME=${1:-base}
shift || true
OUT=out/$NAME
mkdir -p "$OUT"
cp config.zig "$OUT/config.zig"
for kv in "$@"; do
  key=${kv%%=*} value=${kv#*=}
  grep -q "^pub const $key = " "$OUT/config.zig" || { echo "unknown tunable: $key" >&2; exit 1; }
  sed -i "s|^pub const $key = .*;|pub const $key = $value;|" "$OUT/config.zig"
done
"$ZIG" build-lib -dynamic -O ReleaseFast -target x86_64-linux-gnu -mcpu x86_64_v3 -lc -fno-emit-h \
  --dep config -Mroot=sat.zig -Mconfig="$OUT/config.zig" --name sat -femit-bin="$OUT/libsat.so" \
  --cache-dir out/.cache
echo "$OUT/libsat.so"
