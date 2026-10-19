#!/bin/sh
# usage: scripts/build.sh [2|3|all]  -> target/minisilk-wasm{2,3}.wasm (release, wasm32-unknown-unknown)
set -e
cd "$(dirname "$0")/.."
v=${1:-all}
build() { # $1 = variant, $2 = target features, $3 = target dir
  cargo build --release -p minisilk-wasm --target wasm32-unknown-unknown \
    --config "target.wasm32-unknown-unknown.rustflags=[\"-Ctarget-feature=$2\"]" --target-dir "$3"
  cp "$3/wasm32-unknown-unknown/release/minisilk_wasm.wasm" "target/minisilk-wasm$1.wasm"
  ls -l "target/minisilk-wasm$1.wasm"
}
mkdir -p target
if [ "$v" = 2 ] || [ "$v" = all ]; then build 2 +simd128 target; fi
if [ "$v" = 3 ] || [ "$v" = all ]; then build 3 +simd128,+relaxed-simd target/v3; fi
