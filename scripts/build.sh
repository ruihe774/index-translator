#!/bin/sh
# usage: scripts/build.sh [2|3|all] [release|checked|both]
#   -> target/minisilk-wasm{2,3}.wasm (release) and target/minisilk-wasm{2,3}-checked.wasm
#      (release code with debug assertions and overflow checks, for tests)
set -e
cd "$(dirname "$0")/.."
v=${1:-all}
p=${2:-release}
build() { # $1 = variant, $2 = target features, $3 = target dir, $4 = profile
  cargo build --profile "$4" -p minisilk-wasm --target wasm32-unknown-unknown \
    --config "target.wasm32-unknown-unknown.rustflags=[\"-Ctarget-feature=$2\"]" --target-dir "$3"
  suffix=; [ "$4" = checked ] && suffix=-checked
  cp "$3/wasm32-unknown-unknown/$4/minisilk_wasm.wasm" "target/minisilk-wasm$1$suffix.wasm"
  ls -l "target/minisilk-wasm$1$suffix.wasm"
}
mkdir -p target
for profile in release checked; do
  if [ "$p" = "$profile" ] || [ "$p" = both ]; then
    if [ "$v" = 2 ] || [ "$v" = all ]; then build 2 +simd128 target "$profile"; fi
    if [ "$v" = 3 ] || [ "$v" = all ]; then build 3 +simd128,+relaxed-simd target/v3 "$profile"; fi
  fi
done
